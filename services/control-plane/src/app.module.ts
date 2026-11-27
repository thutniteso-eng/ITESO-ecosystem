import { Module } from '@nestjs/common';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { PlatformAdminGuard } from './auth/platform-admin.guard';
import { TokenService } from './auth/token.service';
import { AdminController } from './control-plane/admin.controller';
import { ControlPlaneService } from './control-plane/control-plane.service';
import { OdooProvisioningService } from './control-plane/odoo-provisioning.service';
import { HealthController } from './health/health.controller';
import { NatsService } from './nats/nats.service';

@Module({
  controllers: [AdminController, AuthController, HealthController],
  providers: [
    AuthService,
    TokenService,
    PlatformAdminGuard,
    ControlPlaneService,
    OdooProvisioningService,
    NatsService,
  ],
  exports: [AuthService, TokenService, PlatformAdminGuard, ControlPlaneService, OdooProvisioningService, NatsService],
})
export class AppModule {}
