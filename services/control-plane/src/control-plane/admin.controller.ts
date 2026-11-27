import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { PlatformAdminGuard } from '../auth/platform-admin.guard';
import { ControlPlaneService } from './control-plane.service';

interface UpdateFeatureDto {
  enabled: boolean;
  note?: string;
}

interface RequestWithUser {
  user?: {
    id: string;
    email?: string;
    isPlatformAdmin?: boolean;
  };
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
@UseGuards(PlatformAdminGuard)
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
    @Req() req: RequestWithUser,
  ) {
    const validBody = validateFeatureBody(body);
    const actor = req.user?.id || 'super_admin';
    return this.cpService.updatePlatformFeature(key, validBody.enabled, validBody.note, actor);
  }

  @Put('tenants/:code/features/:key')
  async updateTenantFeature(
    @Param('code') code: string,
    @Param('key') key: string,
    @Body() body: unknown,
    @Req() req: RequestWithUser,
  ) {
    const validBody = validateFeatureBody(body);
    const actor = req.user?.id || 'super_admin';
    return this.cpService.updateTenantFeature(code, key, validBody.enabled, validBody.note, actor);
  }

  // --- TASK-003 Admin APIs ---

  @Post('accounts')
  async createAccount(
    @Body() body: { email?: string; phone?: string; password?: string; isPlatformAdmin?: boolean },
    @Req() req: RequestWithUser,
  ) {
    const actor = req.user?.id || 'super_admin';
    if (!body?.password) {
      throw new BadRequestException({
        error: 'BAD_REQUEST',
        message: 'Password is required',
      });
    }
    return this.cpService.createAccount(
      {
        email: body.email,
        phone: body.phone,
        password: body.password,
        isPlatformAdmin: body.isPlatformAdmin,
      },
      actor,
    );
  }

  @Post('tenants/:code/memberships')
  async createMembership(
    @Param('code') code: string,
    @Body() body: { accountId?: string; roleNames?: string[] },
    @Req() req: RequestWithUser,
  ) {
    const actor = req.user?.id || 'super_admin';
    if (!body?.accountId || !body?.roleNames) {
      throw new BadRequestException({
        error: 'BAD_REQUEST',
        message: 'accountId and roleNames are required',
      });
    }
    return this.cpService.createMembership(code, { accountId: body.accountId, roleNames: body.roleNames }, actor);
  }

  @Put('accounts/:id/password')
  async resetPassword(
    @Param('id') id: string,
    @Body() body: { password?: string },
    @Req() req: RequestWithUser,
  ) {
    const actor = req.user?.id || 'super_admin';
    if (!body?.password) {
      throw new BadRequestException({
        error: 'BAD_REQUEST',
        message: 'Password is required',
      });
    }
    return this.cpService.resetPassword(id, body.password, actor);
  }

  @Put('tenants/:code/memberships/:id')
  async updateMembership(
    @Param('code') code: string,
    @Param('id') id: string,
    @Body() body: { status?: 'active' | 'disabled'; roleNames?: string[] },
    @Req() req: RequestWithUser,
  ) {
    const actor = req.user?.id || 'super_admin';
    return this.cpService.updateMembership(code, id, body, actor);
  }

  @Post('tenants/:code/memberships/:id/odoo-sync')
  async syncMembershipOdoo(
    @Param('code') code: string,
    @Param('id') id: string,
  ) {
    return this.cpService.syncMembershipOdoo(code, id);
  }

  @Get('tenants/:code/roles')
  async getTenantRoles(@Param('code') code: string) {
    return this.cpService.getTenantRoles(code);
  }
}

