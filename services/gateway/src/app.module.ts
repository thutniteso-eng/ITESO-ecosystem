import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth/auth.guard';
import { AuthProxyController } from './auth/auth-proxy.controller';
import { JwtVerifierService } from './auth/jwt-verifier.service';
import { FeatureFlagGuard } from './features/feature-flag.guard';
import { FeaturesController } from './features/features.controller';
import { GatewayNatsListener } from './features/gateway-nats.listener';
import { PlatformService } from './features/platform.service';
import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';
import { OdooController } from './odoo/odoo.controller';
import { OdooService } from './odoo/odoo.service';

@Module({
  controllers: [
    HealthController,
    OdooController,
    FeaturesController,
    AuthProxyController,
  ],
  providers: [
    HealthService,
    OdooService,
    PlatformService,
    GatewayNatsListener,
    JwtVerifierService,
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
