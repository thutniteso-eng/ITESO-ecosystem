import { Controller, Get, NotFoundException, Req } from '@nestjs/common';
import { Request } from 'express';
import { PlatformService } from './platform.service';
import { RequireFeature } from './require-feature.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';

interface RequestWithTenant extends Request {
  tenantCode?: string;
  user?: { tid?: string };
}

@Controller('v1/features')
export class FeaturesController {
  constructor(private readonly platformService: PlatformService) {}

  @Get()
  @RequireFeature('system.features')
  @RequirePermission('system.features.read')
  async getFeatures(@Req() req: RequestWithTenant): Promise<{
    tenant: string;
    features: string[];
  }> {
    const tenantCode = req.tenantCode || req.user?.tid || (req.headers['x-tenant'] as string);
    if (!tenantCode) {
      throw new NotFoundException({
        error: 'TENANT_NOT_FOUND',
        message: 'Missing X-Tenant header or tenant in token',
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
