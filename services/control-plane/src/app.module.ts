import { Module } from '@nestjs/common';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { PlatformAdminGuard } from './auth/platform-admin.guard';
import { TokenService } from './auth/token.service';
import { InternalTokenGuard } from './auth/internal-token.guard';
import { AdminController } from './control-plane/admin.controller';
import { ControlPlaneService } from './control-plane/control-plane.service';
import { OdooProvisioningService } from './control-plane/odoo-provisioning.service';
import { PosDeviceController } from './control-plane/pos-device.controller';
import { PosDeviceService } from './control-plane/pos-device.service';
import { HealthController } from './health/health.controller';
import { NatsService } from './nats/nats.service';

@Module({
  controllers: [AdminController, AuthController, PosDeviceController, HealthController],
  providers: [
    AuthService,
    TokenService,
    PlatformAdminGuard,
    InternalTokenGuard,
    ControlPlaneService,
    OdooProvisioningService,
    PosDeviceService,
    NatsService,
  ],
  exports: [
    AuthService,
    TokenService,
    PlatformAdminGuard,
    InternalTokenGuard,
    ControlPlaneService,
    OdooProvisioningService,
    PosDeviceService,
    NatsService,
  ],
})
export class AppModule {}
