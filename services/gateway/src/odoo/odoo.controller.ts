import { Controller, Get, Req } from '@nestjs/common';
import { Request } from 'express';
import { RequireFeature } from '../features/require-feature.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import { OdooService, type OdooVersionResponse } from './odoo.service';

interface RequestWithTenant extends Request {
  tenantCode?: string;
  user?: { tid?: string };
}

@Controller('v1/odoo')
export class OdooController {
  constructor(private readonly odooService: OdooService) {}

  @Get('version')
  @RequireFeature('system.odoo_version')
  @RequirePermission('system.diagnostics.view')
  async getVersion(@Req() req: RequestWithTenant): Promise<OdooVersionResponse> {
    const tenantCode = req.tenantCode || req.user?.tid || (req.headers['x-tenant'] as string);
    return this.odooService.getVersionForTenant(tenantCode);
  }
}
