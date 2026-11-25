import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { connect, NatsConnection } from 'nats';

@Injectable()
export class NatsService implements OnModuleInit, OnModuleDestroy {
  private nc?: NatsConnection;

  async onModuleInit(): Promise<void> {
    const natsUrl = process.env.NATS_URL ?? 'nats://nats:4222';
    try {
      this.nc = await connect({
        servers: natsUrl,
        timeout: 3000,
        reconnect: true,
      });
    } catch (err) {
      console.warn('Control Plane: NATS connection failed on init:', err);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.nc) {
      await this.nc.drain();
      await this.nc.close();
    }
  }

  async publish(subject: string, data: Record<string, unknown>): Promise<void> {
    if (!this.nc) {
      const natsUrl = process.env.NATS_URL ?? 'nats://nats:4222';
      this.nc = await connect({ servers: natsUrl, timeout: 3000 });
    }
    this.nc.publish(subject, Buffer.from(JSON.stringify(data)));
    await this.nc.flush();
  }

  async isHealthy(): Promise<boolean> {
    try {
      if (!this.nc) {
        const natsUrl = process.env.NATS_URL ?? 'nats://nats:4222';
        this.nc = await connect({ servers: natsUrl, timeout: 3000 });
      }
      await this.nc.flush();
      return true;
    } catch {
      return false;
    }
  }
}
