import {
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Pool } from 'pg';
import { connect, NatsConnection, StringCodec } from 'nats';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

interface CachedCredential {
  apiKey: string;
  odooUid: number;
  cachedAt: number;
}

function decryptAesGcm(cipherText: string, base64Key: string): string {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== 32) {
    throw new Error('Encryption key must be exactly 32 bytes');
  }
  const parts = cipherText.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted ciphertext format');
  }
  const [ivHex, tagHex, dataHex] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return decipher.update(Buffer.from(dataHex, 'hex'), undefined, 'utf8') + decipher.final('utf8');
}

@Injectable()
export class OdooCredentialService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OdooCredentialService.name);
  readonly pgPool: Pool;
  private readonly cache = new Map<string, CachedCredential>(); // membershipId -> CachedCredential
  private readonly CACHE_TTL_MS = 60 * 1000; // 60 seconds
  private readonly odooCredentialsKey: string;
  private nc?: NatsConnection;

  constructor() {
    this.pgPool = new Pool({
      host: process.env.POSTGRES_HOST ?? 'postgres',
      port: Number(process.env.POSTGRES_PORT ?? 5432),
      user: process.env.POSTGRES_USER ?? 'iteso_gateway',
      password: process.env.POSTGRES_PASSWORD ?? '',
      database: process.env.POSTGRES_DB ?? 'platform',
      connectionTimeoutMillis: 3000,
    });

    let cKey = process.env.ODOO_CREDENTIALS_KEY;
    const cKeyPath =
      process.env.ODOO_CREDENTIALS_KEY_PATH ||
      path.resolve(__dirname, '../../../../infra/secrets/odoo_credentials.key');
    if (!cKey && fs.existsSync(cKeyPath)) {
      cKey = fs.readFileSync(cKeyPath, 'utf8').trim();
    }
    if (!cKey) {
      throw new Error(
        `FATAL: Odoo credentials key not found at ${cKeyPath} or via ODOO_CREDENTIALS_KEY.`,
      );
    }
    const decodedCKey = Buffer.from(cKey, 'base64');
    if (decodedCKey.length !== 32) {
      throw new Error(`FATAL: Odoo credentials key must be exactly 32 bytes (got ${decodedCKey.length}).`);
    }
    this.odooCredentialsKey = cKey;
  }

  async onModuleInit(): Promise<void> {
    const natsUrl = process.env.NATS_URL ?? 'nats://nats:4222';
    try {
      this.nc = await connect({ servers: natsUrl, timeout: 3000, reconnect: true });
      this.subscribeToCredentialChanges();
    } catch (err) {
      this.logger.warn(`Gateway: NATS connection failed for credential listener: ${err}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.nc) {
      await this.nc.drain();
      await this.nc.close();
    }
    await this.pgPool.end();
  }

  private subscribeToCredentialChanges(): void {
    if (!this.nc) return;
    const sub = this.nc.subscribe('platform.odoo_credentials.changed');
    const sc = StringCodec();

    (async () => {
      for await (const m of sub) {
        try {
          const payload = JSON.parse(sc.decode(m.data));
          if (payload?.membership_id) {
            this.evictCache(payload.membership_id);
          } else if (payload?.device_id) {
            this.evictCache(`device:${payload.device_id}`);
          } else {
            this.cache.clear();
          }
        } catch {
          this.cache.clear();
        }
      }
    })().catch((err) => {
      this.logger.error(`Error in platform.odoo_credentials.changed listener: ${err}`);
    });
  }

  evictCache(membershipId: string): void {
    this.cache.delete(membershipId);
  }

  async getMemberCredential(
    membershipId: string,
    tokenTenantCode: string,
    expectedTenantId: string,
  ): Promise<{ apiKey: string; odooUid: number }> {
    const cached = this.cache.get(membershipId);
    const now = Date.now();
    if (cached && now - cached.cachedAt < this.CACHE_TTL_MS) {
      return { apiKey: cached.apiKey, odooUid: cached.odooUid };
    }

    // Query platform database restricted columns on membership_odoo_users
    const result = await this.pgPool.query(
      `SELECT membership_id, tenant_id, odoo_uid, api_key_enc, key_expires_at, status
       FROM membership_odoo_users
       WHERE membership_id = $1`,
      [membershipId],
    );

    if (result.rows.length === 0) {
      throw new ForbiddenException({
        error: 'ODOO_USER_NOT_PROVISIONED',
        message: `Odoo user not provisioned for membership ${membershipId}`,
      });
    }

    const row = result.rows[0];

    // Check tenant mismatch
    if (row.tenant_id !== expectedTenantId) {
      this.logger.warn(
        `TENANT_MISMATCH: membership ${membershipId} belongs to tenant ${row.tenant_id}, but token has ${expectedTenantId} (${tokenTenantCode})`,
      );
      throw new ForbiddenException({
        error: 'TENANT_MISMATCH',
        message: 'Membership does not belong to the requested tenant',
      });
    }

    // Check status
    if (row.status !== 'active') {
      throw new ForbiddenException({
        error: 'ODOO_USER_NOT_PROVISIONED',
        message: `Odoo user status is ${row.status}`,
      });
    }

    // Check key expiration
    if (!row.key_expires_at || new Date(row.key_expires_at).getTime() <= now) {
      throw new ForbiddenException({
        error: 'ODOO_USER_NOT_PROVISIONED',
        message: 'Odoo user API key has expired',
      });
    }

    if (!row.api_key_enc || !row.odoo_uid) {
      throw new ForbiddenException({
        error: 'ODOO_USER_NOT_PROVISIONED',
        message: 'Odoo user API key is missing',
      });
    }

    // Decrypt key
    let decryptedKey: string;
    try {
      decryptedKey = decryptAesGcm(row.api_key_enc, this.odooCredentialsKey);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to decrypt Odoo key for membership ${membershipId}: ${errMsg}`);
      throw new ForbiddenException({
        error: 'ODOO_USER_NOT_PROVISIONED',
        message: 'Failed to decrypt member Odoo API key',
      });
    }

    const cred: CachedCredential = {
      apiKey: decryptedKey,
      odooUid: row.odoo_uid,
      cachedAt: now,
    };

    this.cache.set(membershipId, cred);

    return { apiKey: cred.apiKey, odooUid: cred.odooUid };
  }

  async getDeviceCredential(
    deviceId: string,
    tokenTenantCode: string,
    expectedTenantId: string,
  ): Promise<{ apiKey: string; odooUid: number }> {
    const cacheKey = `device:${deviceId}`;
    const cached = this.cache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.cachedAt < this.CACHE_TTL_MS) {
      return { apiKey: cached.apiKey, odooUid: cached.odooUid };
    }

    const result = await this.pgPool.query(
      `SELECT device_id, tenant_id, odoo_uid, api_key_enc, key_expires_at, status
       FROM device_odoo_users
       WHERE device_id = $1`,
      [deviceId],
    );

    if (result.rows.length === 0) {
      throw new ForbiddenException({
        error: 'DEVICE_ODOO_USER_NOT_PROVISIONED',
        message: `Odoo user not provisioned for device ${deviceId}`,
      });
    }

    const row = result.rows[0];

    if (row.tenant_id !== expectedTenantId) {
      this.logger.warn(
        `TENANT_MISMATCH: device ${deviceId} belongs to tenant ${row.tenant_id}, but token has ${expectedTenantId} (${tokenTenantCode})`,
      );
      throw new ForbiddenException({
        error: 'TENANT_MISMATCH',
        message: 'Device does not belong to the requested tenant',
      });
    }

    if (row.status !== 'active') {
      throw new ForbiddenException({
        error: 'DEVICE_ODOO_USER_NOT_PROVISIONED',
        message: `Device Odoo user status is ${row.status}`,
      });
    }

    if (!row.key_expires_at || new Date(row.key_expires_at).getTime() <= now) {
      throw new ForbiddenException({
        error: 'DEVICE_ODOO_USER_NOT_PROVISIONED',
        message: 'Device Odoo user API key has expired',
      });
    }

    if (!row.api_key_enc || !row.odoo_uid) {
      throw new ForbiddenException({
        error: 'DEVICE_ODOO_USER_NOT_PROVISIONED',
        message: 'Device Odoo user API key is missing',
      });
    }

    let decryptedKey: string;
    try {
      decryptedKey = decryptAesGcm(row.api_key_enc, this.odooCredentialsKey);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to decrypt Odoo key for device ${deviceId}: ${errMsg}`);
      throw new ForbiddenException({
        error: 'DEVICE_ODOO_USER_NOT_PROVISIONED',
        message: 'Failed to decrypt device Odoo API key',
      });
    }

    const cred: CachedCredential = {
      apiKey: decryptedKey,
      odooUid: row.odoo_uid,
      cachedAt: now,
    };

    this.cache.set(cacheKey, cred);

    return { apiKey: cred.apiKey, odooUid: cred.odooUid };
  }
}
