import { Controller, Get, Headers } from '@nestjs/common';
import { OdooService, type OdooVersionResponse } from './odoo.service';

@Controller('v1/odoo')
export class OdooController {
  constructor(private readonly odooService: OdooService) {}

  @Get('version')
  async getVersion(
    @Headers('x-tenant') tenantCode?: string,
  ): Promise<OdooVersionResponse> {
    return this.odooService.getVersionForTenant(tenantCode);
  }
}
