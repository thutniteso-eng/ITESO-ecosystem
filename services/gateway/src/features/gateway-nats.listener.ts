import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { connect, NatsConnection, StringCodec } from 'nats';
import { PlatformService } from './platform.service';

@Injectable()
export class GatewayNatsListener implements OnModuleInit, OnModuleDestroy {
  private nc?: NatsConnection;

  constructor(private readonly platformService: PlatformService) {}

  async onModuleInit(): Promise<void> {
    const natsUrl = process.env.NATS_URL ?? 'nats://nats:4222';
    try {
      this.nc = await connect({ servers: natsUrl, timeout: 3000, reconnect: true });
      this.subscribeToChanges();
    } catch (err) {
      console.warn('Gateway: NATS listener connection failed on init:', err);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.nc) {
      await this.nc.drain();
      await this.nc.close();
    }
  }

  private async subscribeToChanges(): Promise<void> {
    if (!this.nc) return;
    const sub = this.nc.subscribe('platform.features.changed');
    const sc = StringCodec();

    (async () => {
      for await (const m of sub) {
        try {
          const payload = JSON.parse(sc.decode(m.data));
          this.platformService.clearCache(payload.tenant, payload.key);
        } catch {
          this.platformService.clearCache();
        }
      }
    })().catch((err) => {
      console.error('Error listening to platform.features.changed:', err);
    });
  }
}
