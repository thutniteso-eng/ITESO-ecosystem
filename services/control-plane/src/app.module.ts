import { Module } from '@nestjs/common';
import { AdminController } from './control-plane/admin.controller';
import { ControlPlaneService } from './control-plane/control-plane.service';
import { HealthController } from './health/health.controller';
import { NatsService } from './nats/nats.service';

@Module({
  controllers: [AdminController, HealthController],
  providers: [ControlPlaneService, NatsService],
  exports: [ControlPlaneService, NatsService],
})
export class AppModule {}
