import { Controller, Get, Headers, NotFoundException } from '@nestjs/common';
import { PlatformService } from './platform.service';
import { RequireFeature } from './require-feature.decorator';

@Controller('v1/features')
export class FeaturesController {
  constructor(private readonly platformService: PlatformService) {}

  @Get()
  @RequireFeature('system.features')
  async getFeatures(@Headers('x-tenant') tenantCode?: string): Promise<{
    tenant: string;
    features: string[];
  }> {
    if (!tenantCode) {
      throw new NotFoundException({
        error: 'TENANT_NOT_FOUND',
        message: 'Missing X-Tenant header',
      });
    }

    const enabledFeatures = await this.platformService.getEnabledFeaturesForTenant(
      tenantCode,
    );

    return {
      tenant: tenantCode,
      features: enabledFeatures,
    };
  }
}
