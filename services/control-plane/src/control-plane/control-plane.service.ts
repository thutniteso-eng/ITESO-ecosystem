import {
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '../db/schema';
import { NatsService } from '../nats/nats.service';

@Injectable()
export class ControlPlaneService implements OnModuleDestroy {
  private readonly pgPool: Pool;
  private readonly db: NodePgDatabase<typeof schema>;

  constructor(private readonly natsService: NatsService) {
    this.pgPool = new Pool({
      host: process.env.POSTGRES_HOST ?? 'postgres',
      port: Number(process.env.POSTGRES_PORT ?? 5432),
      user: process.env.POSTGRES_CONTROL_PLANE_USER ?? 'iteso_control_plane',
      password: process.env.POSTGRES_CONTROL_PLANE_PASSWORD ?? '',
      database: process.env.PLATFORM_DB ?? 'platform',
      connectionTimeoutMillis: 3000,
    });
    this.db = drizzle(this.pgPool, { schema });
  }

  async onModuleDestroy(): Promise<void> {
    await this.pgPool.end();
  }

  async checkHealth(): Promise<{ database: boolean; nats: boolean }> {
    let database = false;
    try {
      await this.pgPool.query('SELECT 1');
      database = true;
    } catch {
      database = false;
    }
    const nats = await this.natsService.isHealthy();
    return { database, nats };
  }

  async getTenants(): Promise<Array<typeof schema.tenants.$inferSelect>> {
    return this.db.select().from(schema.tenants);
  }

  async getFeatures(): Promise<Array<typeof schema.featureDefinitions.$inferSelect>> {
    return this.db.select().from(schema.featureDefinitions);
  }

  async getTenantFeatures(code: string): Promise<
    Array<{
      key: string;
      group: string;
      description: string;
      implementationStatus: string;
      platformEnabled: boolean;
      defaultEnabled: boolean;
      tenantOverride: boolean | null;
      effectiveEnabled: boolean;
    }>
  > {
    const tenant = await this.db.query.tenants.findFirst({
      where: eq(schema.tenants.code, code),
    });

    if (!tenant) {
      throw new NotFoundException({
        error: 'TENANT_NOT_FOUND',
        message: `Tenant '${code}' not found`,
      });
    }

    const allFeatures = await this.db.select().from(schema.featureDefinitions);
    const overrides = await this.db
      .select()
      .from(schema.tenantFeatures)
      .where(eq(schema.tenantFeatures.tenantId, tenant.id));

    const overrideMap = new Map(overrides.map((o) => [o.featureKey, o.enabled]));

    return allFeatures.map((f) => {
      const override = overrideMap.has(f.key) ? overrideMap.get(f.key)! : null;
      const isAvailable = f.implementationStatus === 'available';
      const tenantVal = override !== null ? override : f.defaultEnabled;
      const effectiveEnabled = isAvailable && f.platformEnabled && tenantVal;

      return {
        key: f.key,
        group: f.group,
        description: f.description,
        implementationStatus: f.implementationStatus,
        platformEnabled: f.platformEnabled,
        defaultEnabled: f.defaultEnabled,
        tenantOverride: override,
        effectiveEnabled,
      };
    });
  }

  async updatePlatformFeature(
    key: string,
    enabled: boolean,
    note?: string,
  ): Promise<typeof schema.featureDefinitions.$inferSelect> {
    const feat = await this.db.query.featureDefinitions.findFirst({
      where: eq(schema.featureDefinitions.key, key),
    });

    if (!feat) {
      throw new NotFoundException({
        error: 'FEATURE_NOT_FOUND',
        message: `Feature '${key}' not found`,
      });
    }

    if (enabled && feat.implementationStatus === 'not_implemented') {
      throw new ConflictException({
        error: 'FEATURE_NOT_IMPLEMENTED',
        message: `Feature '${key}' is not implemented and cannot be enabled`,
      });
    }

    // Atomic update + audit log
    const beforeState = { ...feat };
    let updatedFeature: typeof schema.featureDefinitions.$inferSelect;

    await this.db.transaction(async (tx) => {
      const updated = await tx
        .update(schema.featureDefinitions)
        .set({ platformEnabled: enabled })
        .where(eq(schema.featureDefinitions.key, key))
        .returning();

      updatedFeature = updated[0];

      await tx.insert(schema.adminAuditLog).values({
        actor: 'super_admin',
        action: 'UPDATE_PLATFORM_FEATURE',
        targetType: 'feature',
        targetId: key,
        before: beforeState,
        after: updatedFeature,
        note: note ?? null,
      });
    });

    // Publish NATS event
    await this.natsService.publish('platform.features.changed', {
      tenant: null,
      key,
    });

    return updatedFeature!;
  }

  async updateTenantFeature(
    tenantCode: string,
    featureKey: string,
    enabled: boolean,
    note?: string,
  ): Promise<typeof schema.tenantFeatures.$inferSelect> {
    const tenant = await this.db.query.tenants.findFirst({
      where: eq(schema.tenants.code, tenantCode),
    });

    if (!tenant) {
      throw new NotFoundException({
        error: 'TENANT_NOT_FOUND',
        message: `Tenant '${tenantCode}' not found`,
      });
    }

    const feat = await this.db.query.featureDefinitions.findFirst({
      where: eq(schema.featureDefinitions.key, featureKey),
    });

    if (!feat) {
      throw new NotFoundException({
        error: 'FEATURE_NOT_FOUND',
        message: `Feature '${featureKey}' not found`,
      });
    }

    if (enabled && feat.implementationStatus === 'not_implemented') {
      throw new ConflictException({
        error: 'FEATURE_NOT_IMPLEMENTED',
        message: `Feature '${featureKey}' is not implemented and cannot be enabled`,
      });
    }

    const existing = await this.db.query.tenantFeatures.findFirst({
      where: and(
        eq(schema.tenantFeatures.tenantId, tenant.id),
        eq(schema.tenantFeatures.featureKey, featureKey),
      ),
    });

    const beforeState = existing ? { ...existing } : null;
    let saved: typeof schema.tenantFeatures.$inferSelect;

    await this.db.transaction(async (tx) => {
      const result = await tx
        .insert(schema.tenantFeatures)
        .values({
          tenantId: tenant.id,
          featureKey,
          enabled,
          updatedBy: 'super_admin',
          note: note ?? null,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [schema.tenantFeatures.tenantId, schema.tenantFeatures.featureKey],
          set: {
            enabled,
            updatedBy: 'super_admin',
            note: note ?? null,
            updatedAt: new Date(),
          },
        })
        .returning();

      saved = result[0];

      await tx.insert(schema.adminAuditLog).values({
        actor: 'super_admin',
        action: 'UPDATE_TENANT_FEATURE',
        targetType: 'tenant_feature',
        targetId: `${tenantCode}:${featureKey}`,
        before: beforeState,
        after: saved,
        note: note ?? null,
      });
    });

    // Publish NATS event
    await this.natsService.publish('platform.features.changed', {
      tenant: tenantCode,
      key: featureKey,
    });

    return saved!;
  }
}
