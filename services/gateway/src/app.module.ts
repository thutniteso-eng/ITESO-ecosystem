import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth/auth.guard';
import { AuthProxyController } from './auth/auth-proxy.controller';
import { JwtVerifierService } from './auth/jwt-verifier.service';
import { DeviceVerificationService } from './auth/device-verification.service';
import { FeatureFlagGuard } from './features/feature-flag.guard';
import { FeaturesController } from './features/features.controller';
import { GatewayNatsListener } from './features/gateway-nats.listener';
import { PlatformService } from './features/platform.service';
import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';
import { OdooController } from './odoo/odoo.controller';
import { OdooService } from './odoo/odoo.service';
import { OdooCredentialService } from './odoo/odoo-credential.service';
import { SyncController } from './sync/sync.controller';
import { SyncService } from './sync/sync.service';

@Module({
  controllers: [
    HealthController,
    OdooController,
    FeaturesController,
    AuthProxyController,
    SyncController,
  ],
  providers: [
    HealthService,
    OdooService,
    OdooCredentialService,
    DeviceVerificationService,
    PlatformService,
    GatewayNatsListener,
    JwtVerifierService,
    SyncService,
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: FeatureFlagGuard,
    },
  ],
})
export class AppModule {}
