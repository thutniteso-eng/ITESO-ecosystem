import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { connect } from 'nats';
import { Pool } from 'pg';

export interface ComponentStatus {
  status: 'ok' | 'error';
  reason?: string;
}

export interface HealthResponse {
  status: 'ok' | 'error';
  components: {
    gateway: ComponentStatus;
    postgres: ComponentStatus;
    odoo: ComponentStatus;
    nats: ComponentStatus;
    redis: ComponentStatus;
  };
}

@Injectable()
export class HealthService implements OnModuleDestroy {
  private readonly pgPool: Pool;
  private readonly odooUrl: string;
  private readonly natsUrl: string;
  private readonly redisUrl: string;

  constructor() {
    this.pgPool = new Pool({
      host: process.env.POSTGRES_HOST ?? 'postgres',
      port: Number(process.env.POSTGRES_PORT ?? 5432),
      user: process.env.POSTGRES_USER ?? 'odoo',
      password: process.env.POSTGRES_PASSWORD ?? '',
      database: process.env.POSTGRES_DB ?? 'postgres',
      connectionTimeoutMillis: 3000,
    });
    this.odooUrl = process.env.ODOO_URL ?? 'http://odoo:8069';
    this.natsUrl = process.env.NATS_URL ?? 'nats://nats:4222';
    this.redisUrl = process.env.REDIS_URL ?? 'redis://redis:6379';
  }

  async onModuleDestroy(): Promise<void> {
    await this.pgPool.end();
  }

  async checkAll(): Promise<HealthResponse> {
    const [postgres, odoo, nats, redis] = await Promise.all([
      this.checkPostgres(),
      this.checkOdoo(),
      this.checkNats(),
      this.checkRedis(),
    ]);

    const components = {
      gateway: { status: 'ok' as const },
      postgres,
      odoo,
      nats,
      redis,
    };

    const allOk = Object.values(components).every((c) => c.status === 'ok');

    return {
      status: allOk ? 'ok' : 'error',
      components,
    };
  }

  async checkPostgres(): Promise<ComponentStatus> {
    try {
      await this.pgPool.query('SELECT 1');
      return { status: 'ok' };
    } catch (err) {
      return { status: 'error', reason: this.formatError(err) };
    }
  }

  async checkOdoo(): Promise<ComponentStatus> {
    try {
      const response = await fetch(`${this.odooUrl}/web/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) {
        return {
          status: 'error',
          reason: `Odoo /web/health returned HTTP ${response.status}`,
        };
      }
      return { status: 'ok' };
    } catch (err) {
      return { status: 'error', reason: this.formatError(err) };
    }
  }

  async checkNats(): Promise<ComponentStatus> {
    try {
      const nc = await connect({
        servers: this.natsUrl,
        timeout: 3000,
        reconnect: false,
      });
      try {
        await nc.flush();
      } finally {
        await nc.close();
      }
      return { status: 'ok' };
    } catch (err) {
      return { status: 'error', reason: this.formatError(err) };
    }
  }

  async checkRedis(): Promise<ComponentStatus> {
    const client = new Redis(this.redisUrl, {
      connectTimeout: 3000,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
      lazyConnect: true,
    });
    // Prevent unhandled error event warnings
    client.on('error', () => undefined);

    try {
      await client.connect();
      const pong = await client.ping();
      if (pong !== 'PONG') {
        return { status: 'error', reason: `Unexpected PING response: ${pong}` };
      }
      return { status: 'ok' };
    } catch (err) {
      return { status: 'error', reason: this.formatError(err) };
    } finally {
      client.disconnect();
    }
  }

  private formatError(err: unknown): string {
    if (err instanceof Error) {
      return err.message;
    }
    return String(err);
  }
}
