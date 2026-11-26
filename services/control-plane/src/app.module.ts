import { Module } from '@nestjs/common';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { PlatformAdminGuard } from './auth/platform-admin.guard';
import { TokenService } from './auth/token.service';
import { AdminController } from './control-plane/admin.controller';
import { ControlPlaneService } from './control-plane/control-plane.service';
import { HealthController } from './health/health.controller';
import { NatsService } from './nats/nats.service';

@Module({
  controllers: [AdminController, AuthController, HealthController],
  providers: [
    AuthService,
    TokenService,
    PlatformAdminGuard,
    ControlPlaneService,
    NatsService,
  ],
  exports: [AuthService, TokenService, PlatformAdminGuard, ControlPlaneService, NatsService],
})
export class AppModule {}
