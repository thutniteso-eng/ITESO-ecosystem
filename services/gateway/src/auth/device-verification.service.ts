import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { connect, NatsConnection, StringCodec } from 'nats';

interface CachedDevice {
  id: string;
  tenantId: string;
  branchId: string;
  status: string;
  cachedAt: number;
}

@Injectable()
export class DeviceVerificationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeviceVerificationService.name);
  readonly pgPool: Pool;
  private readonly cache = new Map<string, CachedDevice>(); // deviceId -> CachedDevice
  private readonly CACHE_TTL_MS = 30 * 1000; // 30 seconds cache
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
  }

  async onModuleInit(): Promise<void> {
    const natsUrl = process.env.NATS_URL ?? 'nats://nats:4222';
    try {
      this.nc = await connect({ servers: natsUrl, timeout: 3000, reconnect: true });
      this.subscribeToDeviceChanges();
    } catch (err) {
      this.logger.warn(`Gateway: NATS connection failed for device listener: ${err}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.nc) {
      await this.nc.drain();
      await this.nc.close();
    }
    await this.pgPool.end();
  }

  private subscribeToDeviceChanges(): void {
    if (!this.nc) return;
    const sub = this.nc.subscribe('platform.devices.changed');
    const sc = StringCodec();

    (async () => {
      for await (const m of sub) {
        try {
          const payload = JSON.parse(sc.decode(m.data));
          if (payload?.device_id) {
            this.evictCache(payload.device_id);
          } else {
            this.cache.clear();
          }
        } catch {
          this.cache.clear();
        }
      }
    })().catch((err) => {
      this.logger.warn(`Gateway: NATS devices subscription loop error: ${err}`);
    });
  }

  evictCache(deviceId: string): void {
    this.cache.delete(deviceId);
  }

  clearCache(): void {
    this.cache.clear();
  }

  async verifyDeviceActive(deviceId: string): Promise<CachedDevice> {
    const now = Date.now();
    const cached = this.cache.get(deviceId);
    if (cached && now - cached.cachedAt < this.CACHE_TTL_MS) {
      if (cached.status !== 'active') {
        throw new UnauthorizedException({
          error: 'DEVICE_REVOKED',
          message: 'POS device has been revoked',
        });
      }
      return cached;
    }

    // Query platform database (only permitted columns: id, tenant_id, branch_id, status)
    const res = await this.pgPool.query(
      `SELECT id, tenant_id, branch_id, status FROM pos_devices WHERE id = $1`,
      [deviceId],
    );

    if (res.rows.length === 0) {
      throw new UnauthorizedException({
        error: 'DEVICE_REVOKED',
        message: 'POS device not found or revoked',
      });
    }

    const row = res.rows[0];
    const device: CachedDevice = {
      id: row.id,
      tenantId: row.tenant_id,
      branchId: row.branch_id,
      status: row.status,
      cachedAt: now,
    };

    this.cache.set(deviceId, device);

    if (device.status !== 'active') {
      throw new UnauthorizedException({
        error: 'DEVICE_REVOKED',
        message: 'POS device has been revoked',
      });
    }

    return device;
  }
}
