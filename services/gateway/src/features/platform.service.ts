import {
  Injectable,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';
import { Pool } from 'pg';

export interface TenantInfo {
  id: string;
  code: string;
  dbName: string;
  displayName: string;
  status: 'active' | 'suspended';
  industries: string[];
}

export interface FeatureEvaluation {
  key: string;
  enabled: boolean;
}

interface FeatureCacheItem {
  enabled: boolean;
  timestamp: number;
}

const TENANT_CODE_REGEX = /^[a-z0-9_]+$/;
const CACHE_TTL_MS = 30_000; // 30 seconds

@Injectable()
export class PlatformService implements OnModuleDestroy {
  private readonly pgPool: Pool;
  // Cache key: `${tenantCode}:${featureKey}` -> FeatureCacheItem
  private readonly featureCache = new Map<string, FeatureCacheItem>();
  // Tenant cache: tenantCode -> TenantInfo
  private readonly tenantCache = new Map<string, { tenant: TenantInfo; timestamp: number }>();

  constructor() {
    this.pgPool = new Pool({
      host: process.env.POSTGRES_HOST ?? 'postgres',
      port: Number(process.env.POSTGRES_PORT ?? 5432),
      user: process.env.POSTGRES_USER ?? 'iteso_gateway',
      password: process.env.POSTGRES_PASSWORD ?? '',
      database: process.env.PLATFORM_DB ?? 'platform',
      connectionTimeoutMillis: 3000,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.pgPool.end();
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.pgPool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  clearCache(tenant?: string | null, key?: string | null): void {
    if (!tenant && !key) {
      this.featureCache.clear();
      this.tenantCache.clear();
      return;
    }

    for (const cacheKey of this.featureCache.keys()) {
      const [tCode, fKey] = cacheKey.split(':');
      if (tenant && tCode === tenant) {
        this.featureCache.delete(cacheKey);
      } else if (key && fKey === key) {
        this.featureCache.delete(cacheKey);
      }
    }

    if (tenant) {
      this.tenantCache.delete(tenant);
    }
  }

  async getActiveTenant(tenantCode?: string): Promise<TenantInfo> {
    if (!tenantCode || !TENANT_CODE_REGEX.test(tenantCode)) {
      throw new NotFoundException({
        error: 'TENANT_NOT_FOUND',
        message: `Tenant '${tenantCode ?? ''}' not found`,
      });
    }

    const cached = this.tenantCache.get(tenantCode);
    const now = Date.now();
    if (cached && now - cached.timestamp < CACHE_TTL_MS) {
      return cached.tenant;
    }

    const res = await this.pgPool.query<TenantInfo>(
      `SELECT id, code, db_name AS "dbName", display_name AS "displayName", status, industries
       FROM tenants
       WHERE code = $1`,
      [tenantCode],
    );

    if (res.rows.length === 0) {
      throw new NotFoundException({
        error: 'TENANT_NOT_FOUND',
        message: `Tenant '${tenantCode}' not found`,
      });
    }

    const tenant = res.rows[0];
    if (tenant.status !== 'active') {
      throw new NotFoundException({
        error: 'TENANT_NOT_FOUND',
        message: `Tenant '${tenantCode}' is suspended`,
      });
    }

    this.tenantCache.set(tenantCode, { tenant, timestamp: now });
    return tenant;
  }

  async isPlatformFeatureEnabled(featureKey: string): Promise<boolean> {
    const cacheKey = `platform:${featureKey}`;
    const now = Date.now();
    const cached = this.featureCache.get(cacheKey);
    if (cached && now - cached.timestamp < CACHE_TTL_MS) {
      return cached.enabled;
    }

    const query = `
      SELECT 
        implementation_status AS "implementationStatus",
        platform_enabled AS "platformEnabled"
      FROM feature_definitions
      WHERE key = $1
    `;
    const res = await this.pgPool.query<{
      implementationStatus: string;
      platformEnabled: boolean;
    }>(query, [featureKey]);

    if (res.rows.length === 0) {
      this.featureCache.set(cacheKey, { enabled: false, timestamp: now });
      return false;
    }

    const row = res.rows[0];
    const enabled = row.implementationStatus === 'available' && row.platformEnabled;
    this.featureCache.set(cacheKey, { enabled, timestamp: now });
    return enabled;
  }

  async isFeatureEnabled(tenantCode: string | undefined, featureKey: string): Promise<boolean> {
    if (!tenantCode) {
      return this.isPlatformFeatureEnabled(featureKey);
    }

    const cacheKey = `${tenantCode}:${featureKey}`;
    const now = Date.now();
    const cached = this.featureCache.get(cacheKey);
    if (cached && now - cached.timestamp < CACHE_TTL_MS) {
      return cached.enabled;
    }

    const tenant = await this.getActiveTenant(tenantCode);

    const query = `
      SELECT 
        fd.key,
        fd.implementation_status AS "implementationStatus",
        fd.platform_enabled AS "platformEnabled",
        fd.default_enabled AS "defaultEnabled",
        tf.enabled AS "tenantEnabled"
      FROM feature_definitions fd
      LEFT JOIN tenant_features tf 
        ON tf.feature_key = fd.key AND tf.tenant_id = $1
      WHERE fd.key = $2
    `;

    const res = await this.pgPool.query<{
      key: string;
      implementationStatus: string;
      platformEnabled: boolean;
      defaultEnabled: boolean;
      tenantEnabled: boolean | null;
    }>(query, [tenant.id, featureKey]);

    if (res.rows.length === 0) {
      this.featureCache.set(cacheKey, { enabled: false, timestamp: now });
      return false;
    }

    const row = res.rows[0];
    const isAvailable = row.implementationStatus === 'available';
    const tenantSetting = row.tenantEnabled !== null ? row.tenantEnabled : row.defaultEnabled;

    const enabled = isAvailable && row.platformEnabled && tenantSetting;

    this.featureCache.set(cacheKey, { enabled, timestamp: now });
    return enabled;
  }

  async getEnabledFeaturesForTenant(tenantCode: string): Promise<string[]> {
    const tenant = await this.getActiveTenant(tenantCode);

    const query = `
      SELECT 
        fd.key,
        fd.implementation_status AS "implementationStatus",
        fd.platform_enabled AS "platformEnabled",
        fd.default_enabled AS "defaultEnabled",
        tf.enabled AS "tenantEnabled"
      FROM feature_definitions fd
      LEFT JOIN tenant_features tf 
        ON tf.feature_key = fd.key AND tf.tenant_id = $1
    `;

    const res = await this.pgPool.query<{
      key: string;
      implementationStatus: string;
      platformEnabled: boolean;
      defaultEnabled: boolean;
      tenantEnabled: boolean | null;
    }>(query, [tenant.id]);

    const enabledKeys: string[] = [];
    for (const row of res.rows) {
      const isAvailable = row.implementationStatus === 'available';
      const tenantSetting = row.tenantEnabled !== null ? row.tenantEnabled : row.defaultEnabled;
      if (isAvailable && row.platformEnabled && tenantSetting) {
        enabledKeys.push(row.key);
      }
    }

    return enabledKeys;
  }
}
