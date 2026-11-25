import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import { AdminAuthGuard } from '../auth/admin-auth.guard';
import { ControlPlaneService } from './control-plane.service';

interface UpdateFeatureDto {
  enabled: boolean;
  note?: string;
}

function validateFeatureBody(body: unknown): UpdateFeatureDto {
  if (!body || typeof body !== 'object') {
    throw new BadRequestException({
      error: 'BAD_REQUEST',
      message: 'Body must be an object',
    });
  }

  const b = body as Record<string, unknown>;
  if (typeof b.enabled !== 'boolean') {
    throw new BadRequestException({
      error: 'BAD_REQUEST',
      message: "Field 'enabled' must be a boolean",
    });
  }

  if (b.note !== undefined && b.note !== null) {
    if (typeof b.note !== 'string') {
      throw new BadRequestException({
        error: 'BAD_REQUEST',
        message: "Field 'note' must be a string",
      });
    }
    if (b.note.length > 500) {
      throw new BadRequestException({
        error: 'BAD_REQUEST',
        message: "Field 'note' cannot exceed 500 characters",
      });
    }
  }

  return {
    enabled: b.enabled,
    note: b.note as string | undefined,
  };
}

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
    @Body() body: unknown,
  ) {
    const validBody = validateFeatureBody(body);
    return this.cpService.updatePlatformFeature(key, validBody.enabled, validBody.note);
  }

  @Put('tenants/:code/features/:key')
  async updateTenantFeature(
    @Param('code') code: string,
    @Param('key') key: string,
    @Body() body: unknown,
  ) {
    const validBody = validateFeatureBody(body);
    return this.cpService.updateTenantFeature(code, key, validBody.enabled, validBody.note);
  }
}
