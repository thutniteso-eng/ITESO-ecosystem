import { Controller, Get, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { RequireFeature } from '../features/require-feature.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import { OdooService, type OdooVersionResponse } from './odoo.service';

interface RequestWithTenant extends Request {
  tenantCode?: string;
  user?: { tid?: string; mid?: string };
}

@ApiTags('Odoo')
@ApiBearerAuth()
@Controller('v1/odoo')
export class OdooController {
  constructor(private readonly odooService: OdooService) {}

  @Get('version')
  @RequireFeature('system.odoo_version')
  @RequirePermission('system.diagnostics.view')
  @ApiOperation({ summary: 'Get Odoo version info for authenticated tenant' })
  @ApiResponse({ status: 200, description: 'Odoo version details' })
  async getVersion(@Req() req: RequestWithTenant): Promise<OdooVersionResponse> {
    const tenantCode = req.tenantCode || req.user?.tid;
    const membershipId = req.user?.mid;
    return this.odooService.getVersionForTenant(tenantCode, membershipId);
  }
}
