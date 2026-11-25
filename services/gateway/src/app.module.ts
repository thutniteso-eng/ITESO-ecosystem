import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { FeatureFlagGuard } from './features/feature-flag.guard';
import { FeaturesController } from './features/features.controller';
import { GatewayNatsListener } from './features/gateway-nats.listener';
import { PlatformService } from './features/platform.service';
import { TestUndeclaredController } from './features/test-undeclared.controller';
import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';
import { OdooController } from './odoo/odoo.controller';
import { OdooService } from './odoo/odoo.service';

@Module({
  controllers: [
    HealthController,
    OdooController,
    FeaturesController,
    TestUndeclaredController,
  ],
  providers: [
    HealthService,
    OdooService,
    PlatformService,
    GatewayNatsListener,
    {
      provide: APP_GUARD,
      useClass: FeatureFlagGuard,
    },
  ],
})
export class AppModule {}
