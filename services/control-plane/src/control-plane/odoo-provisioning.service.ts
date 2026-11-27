import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { eq, and, sql, lt, or } from 'drizzle-orm';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import * as schema from '../db/schema';
import { NatsService } from '../nats/nats.service';
import { decryptAesGcm, encryptAesGcm } from '../auth/crypto.util';

export interface ProvisioningResult {
  membershipId: string;
  status: 'pending' | 'active' | 'disabled' | 'error';
  odooUid?: number | null;
  odooLogin?: string | null;
  lastError?: string | null;
}

@Injectable()
export class OdooProvisioningService implements OnModuleInit, OnModuleDestroy {
  private readonly pgPool: Pool;
  readonly db: NodePgDatabase<typeof schema>;
  private readonly platformEncKey: string;
  private readonly odooCredentialsKey: string;
  private readonly odooUrl: string;
  private readonly defaultTtlDays: number;
  private rotationIntervalTimer?: NodeJS.Timeout;

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

    this.odooUrl = (process.env.ODOO_URL || 'http://odoo:8069').replace(/\/+$/, '');
    this.defaultTtlDays = parseInt(process.env.ODOO_MEMBER_KEY_TTL_DAYS || '90', 10);

    // Platform encryption key (for decrypting tenant system keys)
    let pKey = process.env.PLATFORM_ENCRYPTION_KEY;
    const pKeyPath =
      process.env.PLATFORM_ENCRYPTION_KEY_PATH ||
      path.resolve(__dirname, '../../../../infra/secrets/platform_encryption.key');
    if (!pKey && fs.existsSync(pKeyPath)) {
      pKey = fs.readFileSync(pKeyPath, 'utf8').trim();
    }
    this.platformEncKey = pKey || (process.env.NODE_ENV === 'test' ? 'MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=' : '');

    // Odoo credentials key (for encrypting/decrypting member API keys)
    let cKey = process.env.ODOO_CREDENTIALS_KEY;
    const cKeyPath =
      process.env.ODOO_CREDENTIALS_KEY_PATH ||
      path.resolve(__dirname, '../../../../infra/secrets/odoo_credentials.key');
    if (!cKey && fs.existsSync(cKeyPath)) {
      cKey = fs.readFileSync(cKeyPath, 'utf8').trim();
    }
    this.odooCredentialsKey = cKey || (process.env.NODE_ENV === 'test' ? 'MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=' : '');
  }

  async onModuleInit(): Promise<void> {
    if (process.env.NODE_ENV !== 'test') {
      // Trigger background key rotation & retry on boot
      this.runRotationCheck().catch((err) => {
        console.error('[OdooProvisioningService] Initial rotation check error:', err);
      });

      // Run every 24 hours
      this.rotationIntervalTimer = setInterval(
        () => {
          this.runRotationCheck().catch((err) => {
            console.error('[OdooProvisioningService] Scheduled rotation check error:', err);
          });
        },
        24 * 60 * 60 * 1000,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.rotationIntervalTimer) {
      clearInterval(this.rotationIntervalTimer);
    }
    await this.pgPool.end();
  }

  async callOdooJson2(
    dbName: string,
    systemKey: string,
    model: string,
    method: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const url = `${this.odooUrl}/json/2/${model}/${method}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Odoo-Database': dbName,
        'Authorization': `bearer ${systemKey}`,
      },
      body: JSON.stringify(args),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Odoo HTTP ${res.status}: ${errText}`);
    }

    const data = (await res.json()) as Record<string, unknown>;
    if (data && typeof data === 'object' && 'error' in data && data.error) {
      throw new Error(`Odoo RPC Error: ${JSON.stringify(data.error)}`);
    }

    return data;
  }

  async syncMembership(membershipId: string): Promise<ProvisioningResult> {
    const membership = await this.db.query.memberships.findFirst({
      where: eq(schema.memberships.id, membershipId),
    });

    if (!membership) {
      throw new Error(`Membership '${membershipId}' not found`);
    }

    const tenant = await this.db.query.tenants.findFirst({
      where: eq(schema.tenants.id, membership.tenantId),
    });

    if (!tenant) {
      throw new Error(`Tenant '${membership.tenantId}' not found`);
    }

    // Check if tenant has an Odoo database and system key
    const sysKeyRow = await this.db.query.tenantOdooSystemKeys.findFirst({
      where: eq(schema.tenantOdooSystemKeys.tenantId, tenant.id),
    });

    if (!sysKeyRow || !tenant.dbName) {
      // Tenant has no Odoo DB or system key yet -> mark pending
      await this.db
        .insert(schema.membershipOdooUsers)
        .values({
          membershipId: membership.id,
          tenantId: tenant.id,
          status: 'pending',
          syncedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: schema.membershipOdooUsers.membershipId,
          set: {
            status: 'pending',
            syncedAt: new Date(),
          },
        });

      return {
        membershipId: membership.id,
        status: 'pending',
      };
    }

    let systemKey: string;
    try {
      systemKey = decryptAesGcm(sysKeyRow.keyEnc, this.platformEncKey);
    } catch (err: unknown) {
      const errMsg = `Failed to decrypt tenant system key: ${err instanceof Error ? err.message : String(err)}`;
      await this.saveRecordStatus(membership.id, tenant.id, 'error', { lastError: errMsg });
      return { membershipId: membership.id, status: 'error', lastError: errMsg };
    }

    // Existing Odoo user record in platform
    const existingOdooUser = await this.db.query.membershipOdooUsers.findFirst({
      where: eq(schema.membershipOdooUsers.membershipId, membership.id),
    });

    // Check if membership is disabled
    if (membership.status === 'disabled') {
      try {
        if (existingOdooUser?.odooUid) {
          await this.callOdooJson2(
            tenant.dbName,
            systemKey,
            'iteso.provisioning',
            'disable_member',
            { uid: existingOdooUser.odooUid },
          );
        }

        await this.db
          .insert(schema.membershipOdooUsers)
          .values({
            membershipId: membership.id,
            tenantId: tenant.id,
            odooUid: existingOdooUser?.odooUid ?? null,
            odooLogin: existingOdooUser?.odooLogin ?? `iteso-${membership.id}`,
            apiKeyEnc: null,
            keyExpiresAt: null,
            status: 'disabled',
            lastError: null,
            syncedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: schema.membershipOdooUsers.membershipId,
            set: {
              apiKeyEnc: null,
              keyExpiresAt: null,
              status: 'disabled',
              lastError: null,
              syncedAt: new Date(),
            },
          });

        await this.natsService.publish('platform.odoo_credentials.changed', {
          membership_id: membership.id,
        });

        return {
          membershipId: membership.id,
          status: 'disabled',
          odooUid: existingOdooUser?.odooUid,
        };
      } catch (err: unknown) {
        const errMsg = `Error disabling Odoo user: ${err instanceof Error ? err.message : String(err)}`;
        await this.saveRecordStatus(membership.id, tenant.id, 'error', {
          odooUid: existingOdooUser?.odooUid,
          lastError: errMsg,
        });
        return {
          membershipId: membership.id,
          status: 'error',
          odooUid: existingOdooUser?.odooUid,
          lastError: errMsg,
        };
      }
    }

    // Active membership -> provision/update user and issue key
    try {
      const account = await this.db.query.accounts.findFirst({
        where: eq(schema.accounts.id, membership.accountId),
      });

      const displayName = account?.email || account?.phone || `Member ${membership.id.slice(0, 8)}`;

      // Compute union of odoo_groups from member's roles
      const roleLinks = await this.db
        .select({ roleId: schema.membershipRoles.roleId })
        .from(schema.membershipRoles)
        .where(eq(schema.membershipRoles.membershipId, membership.id));

      const roleIds = roleLinks.map((r) => r.roleId);
      const roleRows = roleIds.length > 0
        ? await this.db.query.roles.findMany({
            where: sql`${schema.roles.id} IN ${roleIds}`,
          })
        : [];

      const groupSet = new Set<string>();
      for (const r of roleRows) {
        for (const g of r.odooGroups || []) {
          groupSet.add(g);
        }
      }
      if (groupSet.size === 0) {
        groupSet.add('base.group_user');
      }
      const groupXmlids = Array.from(groupSet);

      // 1. Provision member
      const provRes = (await this.callOdooJson2(
        tenant.dbName,
        systemKey,
        'iteso.provisioning',
        'provision_member',
        {
          membership_id: membership.id,
          name: displayName,
          group_xmlids: groupXmlids,
        },
      )) as { uid: number; login: string };

      const odooUid = provRes.uid;
      const odooLogin = provRes.login;

      // 2. Issue member key
      const keyRes = (await this.callOdooJson2(
        tenant.dbName,
        systemKey,
        'iteso.provisioning',
        'issue_member_key',
        {
          uid: odooUid,
          ttl_days: this.defaultTtlDays,
        },
      )) as { key: string; expires_at: string };

      const rawKey = keyRes.key;
      const keyExpiresAt = new Date(keyRes.expires_at);

      // 3. Encrypt and save key
      const apiKeyEnc = encryptAesGcm(rawKey, this.odooCredentialsKey);

      await this.db
        .insert(schema.membershipOdooUsers)
        .values({
          membershipId: membership.id,
          tenantId: tenant.id,
          odooUid,
          odooLogin,
          apiKeyEnc,
          keyExpiresAt,
          status: 'active',
          lastError: null,
          syncedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: schema.membershipOdooUsers.membershipId,
          set: {
            odooUid,
            odooLogin,
            apiKeyEnc,
            keyExpiresAt,
            status: 'active',
            lastError: null,
            syncedAt: new Date(),
          },
        });

      // 4. Revoke old member keys keeping newest
      await this.callOdooJson2(
        tenant.dbName,
        systemKey,
        'iteso.provisioning',
        'revoke_member_keys',
        {
          uid: odooUid,
          keep_newest: true,
        },
      );

      // 5. Publish NATS event
      await this.natsService.publish('platform.odoo_credentials.changed', {
        membership_id: membership.id,
      });

      return {
        membershipId: membership.id,
        status: 'active',
        odooUid,
        odooLogin,
      };
    } catch (err: unknown) {
      const errMsg = `Error provisioning member to Odoo: ${err instanceof Error ? err.message : String(err)}`;
      await this.saveRecordStatus(membership.id, tenant.id, 'error', {
        odooUid: existingOdooUser?.odooUid,
        lastError: errMsg,
      });
      return {
        membershipId: membership.id,
        status: 'error',
        odooUid: existingOdooUser?.odooUid,
        lastError: errMsg,
      };
    }
  }

  private async saveRecordStatus(
    membershipId: string,
    tenantId: string,
    status: 'pending' | 'active' | 'disabled' | 'error',
    opts?: { odooUid?: number | null; lastError?: string | null },
  ): Promise<void> {
    await this.db
      .insert(schema.membershipOdooUsers)
      .values({
        membershipId,
        tenantId,
        odooUid: opts?.odooUid ?? null,
        status,
        lastError: opts?.lastError ?? null,
        syncedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.membershipOdooUsers.membershipId,
        set: {
          odooUid: opts?.odooUid !== undefined ? opts.odooUid : undefined,
          status,
          lastError: opts?.lastError ?? null,
          syncedAt: new Date(),
        },
      });
  }

  async runRotationCheck(): Promise<void> {
    console.log('[OdooProvisioningService] Running key rotation and retry check...');
    const now = new Date();
    const rotateThreshold = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000); // 14 days

    // Find active records expiring within 14 days, or records in 'error' state
    const candidates = await this.db.query.membershipOdooUsers.findMany({
      where: or(
        and(
          eq(schema.membershipOdooUsers.status, 'active'),
          lt(schema.membershipOdooUsers.keyExpiresAt, rotateThreshold),
        ),
        eq(schema.membershipOdooUsers.status, 'error'),
      ),
    });

    console.log(`[OdooProvisioningService] Found ${candidates.length} candidate(s) for rotation/retry.`);
    for (const c of candidates) {
      try {
        await this.syncMembership(c.membershipId);
      } catch (err: unknown) {
        console.error(`[OdooProvisioningService] Rotation/retry failed for membership ${c.membershipId}:`, err);
      }
    }
  }
}
