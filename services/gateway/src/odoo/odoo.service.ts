import {
  BadGatewayException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';
import { Pool } from 'pg';

export interface OdooVersionResponse {
  tenant: string;
  database: string;
  api: 'json-2';
  version: string;
  version_info: unknown[];
  base_module_version: string | null;
}

interface OdooJsonVersionPayload {
  version: string;
  version_info: unknown[];
}

interface OdooModuleRecord {
  name: string;
  installed_version?: string | false;
  latest_version?: string | false;
  state?: string;
}

const TENANT_CODE_REGEX = /^[a-z0-9_]+$/;

@Injectable()
export class OdooService implements OnModuleDestroy {
  private readonly pgPool: Pool;
  private readonly odooUrl: string;
  private readonly devApiKey: string;

  constructor() {
    this.pgPool = new Pool({
      host: process.env.POSTGRES_HOST ?? 'postgres',
      port: Number(process.env.POSTGRES_PORT ?? 5432),
      user: process.env.POSTGRES_USER ?? 'iteso_gateway',
      password: process.env.POSTGRES_PASSWORD ?? '',
      database: process.env.POSTGRES_DB ?? 'postgres',
      connectionTimeoutMillis: 3000,
    });
    this.odooUrl = process.env.ODOO_URL ?? 'http://odoo:8069';
    this.devApiKey = process.env.ODOO_DEV_API_KEY ?? '';
  }

  async onModuleDestroy(): Promise<void> {
    await this.pgPool.end();
  }

  resolveDatabaseName(tenantCode: string | undefined): string {
    if (!tenantCode || !TENANT_CODE_REGEX.test(tenantCode)) {
      throw new NotFoundException({
        error: 'TENANT_NOT_FOUND',
        message: `Tenant '${tenantCode ?? ''}' not found`,
      });
    }
    return `t_${tenantCode}`;
  }

  async tenantDatabaseExists(dbName: string): Promise<boolean> {
    const result = await this.pgPool.query<{ exists: number }>(
      'SELECT 1 AS exists FROM pg_database WHERE datname = $1 AND datistemplate = false',
      [dbName],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getVersionForTenant(
    tenantCode: string | undefined,
  ): Promise<OdooVersionResponse> {
    const dbName = this.resolveDatabaseName(tenantCode);
    const exists = await this.tenantDatabaseExists(dbName);

    if (!exists) {
      throw new NotFoundException({
        error: 'TENANT_NOT_FOUND',
        message: `Tenant '${tenantCode}' not found`,
      });
    }

    // Call Odoo 20 External JSON-2 API against the tenant's database
    const json2Response = await this.callJson2<OdooModuleRecord[]>(
      dbName,
      'ir.module.module',
      'search_read',
      {
        domain: [['name', '=', 'base']],
        fields: ['name', 'installed_version', 'latest_version', 'state'],
        limit: 1,
      },
    );

    // Also fetch server version metadata from Odoo 20 /json/version
    const versionInfo = await this.fetchServerVersion();

    const baseModule = json2Response[0];
    const baseModuleVersion =
      typeof baseModule?.installed_version === 'string'
        ? baseModule.installed_version
        : typeof baseModule?.latest_version === 'string'
          ? baseModule.latest_version
          : null;

    return {
      tenant: tenantCode as string,
      database: dbName,
      api: 'json-2',
      version: versionInfo.version,
      version_info: versionInfo.version_info,
      base_module_version: baseModuleVersion,
    };
  }

  async callJson2<T>(
    dbName: string,
    model: string,
    method: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Odoo-Database': dbName,
    };
    if (this.devApiKey) {
      headers['Authorization'] = `bearer ${this.devApiKey}`;
    }

    let response: Response;
    try {
      response = await fetch(`${this.odooUrl}/json/2/${model}/${method}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      throw new BadGatewayException({
        error: 'ODOO_UNREACHABLE',
        message: err instanceof Error ? err.message : String(err),
      });
    }

    if (response.status === 404) {
      throw new NotFoundException({
        error: 'TENANT_NOT_FOUND',
        message: `Odoo database '${dbName}' not found`,
      });
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new BadGatewayException({
        error: 'ODOO_API_ERROR',
        message: `Odoo JSON-2 API returned HTTP ${response.status}: ${detail}`,
      });
    }

    return (await response.json()) as T;
  }

  async fetchServerVersion(): Promise<OdooJsonVersionPayload> {
    let response: Response;
    try {
      response = await fetch(`${this.odooUrl}/json/version`, {
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      throw new BadGatewayException({
        error: 'ODOO_UNREACHABLE',
        message: err instanceof Error ? err.message : String(err),
      });
    }

    if (!response.ok) {
      throw new BadGatewayException({
        error: 'ODOO_API_ERROR',
        message: `Odoo /json/version returned HTTP ${response.status}`,
      });
    }

    return (await response.json()) as OdooJsonVersionPayload;
  }
}
