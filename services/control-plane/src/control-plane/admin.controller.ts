import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import { AdminAuthGuard } from '../auth/admin-auth.guard';
import { ControlPlaneService } from './control-plane.service';

@Controller('admin')
@UseGuards(AdminAuthGuard)
export class AdminController {
  constructor(private readonly cpService: ControlPlaneService) {}

  @Get('tenants')
  async getTenants() {
    return this.cpService.getTenants();
  }

  @Get('features')
  async getFeatures() {
    return this.cpService.getFeatures();
  }

  @Get('tenants/:code/features')
  async getTenantFeatures(@Param('code') code: string) {
    return this.cpService.getTenantFeatures(code);
  }

  @Put('features/:key/platform')
  async updatePlatformFeature(
    @Param('key') key: string,
    @Body() body: { enabled: boolean; note?: string },
  ) {
    return this.cpService.updatePlatformFeature(key, body.enabled, body.note);
  }

  @Put('tenants/:code/features/:key')
  async updateTenantFeature(
    @Param('code') code: string,
    @Param('key') key: string,
    @Body() body: { enabled: boolean; note?: string },
  ) {
    return this.cpService.updateTenantFeature(code, key, body.enabled, body.note);
  }
}
