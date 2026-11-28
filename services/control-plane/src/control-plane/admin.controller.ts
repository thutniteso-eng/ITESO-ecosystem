import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { PlatformAdminGuard } from '../auth/platform-admin.guard';
import { ControlPlaneService } from './control-plane.service';

interface UpdateFeatureDto {
  enabled: boolean | null;
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
  if (typeof b.enabled !== 'boolean' && b.enabled !== null) {
    throw new BadRequestException({
      error: 'BAD_REQUEST',
      message: "Field 'enabled' must be a boolean or null",
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
    enabled: b.enabled as boolean | null,
    note: b.note as string | undefined,
  };
}

@ApiTags('Admin')
@ApiBearerAuth()
@Controller('admin')
@UseGuards(PlatformAdminGuard)
export class AdminController {
  constructor(private readonly cpService: ControlPlaneService) {}

  @Get('tenants')
  @ApiOperation({ summary: 'List all businesses/tenants with member counts and created date' })
  @ApiResponse({ status: 200, description: 'List of tenants' })
  async getTenants() {
    return this.cpService.getTenants();
  }

  @Get('features')
  @ApiOperation({ summary: 'List all platform feature definitions' })
  @ApiResponse({ status: 200, description: 'List of feature definitions' })
  async getFeatures() {
    return this.cpService.getFeatures();
  }

  @Get('tenants/:code/features')
  @ApiOperation({ summary: 'Get effective features and overrides for a tenant' })
  @ApiParam({ name: 'code', description: 'Tenant code (e.g. demo_fnb)' })
  @ApiResponse({ status: 200, description: 'List of tenant features with effective status' })
  async getTenantFeatures(@Param('code') code: string) {
    return this.cpService.getTenantFeatures(code);
  }

  @Put('features/:key/platform')
  @Patch('features/:key/platform')
  @ApiOperation({ summary: 'Update platform-wide feature toggle' })
  @ApiParam({ name: 'key', description: 'Feature key (e.g. pos.devices)' })
  @ApiResponse({ status: 200, description: 'Feature updated' })
  async updatePlatformFeature(
    @Param('key') key: string,
    @Body() body: unknown,
    @Req() req: RequestWithUser,
  ) {
    const validBody = validateFeatureBody(body);
    if (typeof validBody.enabled !== 'boolean') {
      throw new BadRequestException({
        error: 'BAD_REQUEST',
        message: 'Platform feature toggle requires a boolean value',
      });
    }
    const actor = req.user?.id || 'super_admin';
    return this.cpService.updatePlatformFeature(key, validBody.enabled, validBody.note, actor);
  }

  @Put('tenants/:code/features/:key')
  @Patch('tenants/:code/features/:key')
  @ApiOperation({ summary: 'Update tenant-level feature override (true, false, or null for default)' })
  @ApiParam({ name: 'code', description: 'Tenant code' })
  @ApiParam({ name: 'key', description: 'Feature key' })
  @ApiResponse({ status: 200, description: 'Tenant feature updated' })
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

  @Get('audit-log')
  @ApiOperation({ summary: 'Get administrative audit log with filtering and pagination' })
  @ApiQuery({ name: 'from', required: false, description: 'From ISO date' })
  @ApiQuery({ name: 'to', required: false, description: 'To ISO date' })
  @ApiQuery({ name: 'actor', required: false, description: 'Filter by actor ID or email' })
  @ApiQuery({ name: 'action', required: false, description: 'Filter by action name' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number (default 1)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Page size (default 50)' })
  @ApiResponse({ status: 200, description: 'Paginated audit logs' })
  async getAuditLog(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('actor') actor?: string,
    @Query('action') action?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.cpService.getAuditLog({
      from,
      to,
      actor,
      action,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 50,
    });
  }

  // --- TASK-003 Admin APIs ---

  @Post('accounts')
  @ApiOperation({ summary: 'Create user account' })
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
  @ApiOperation({ summary: 'Add account membership to a tenant' })
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
  @ApiOperation({ summary: 'Reset account password' })
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
  @ApiOperation({ summary: 'Update tenant membership status and roles' })
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
  @ApiOperation({ summary: 'Sync membership Odoo user credential' })
  async syncMembershipOdoo(
    @Param('code') code: string,
    @Param('id') id: string,
  ) {
    return this.cpService.syncMembershipOdoo(code, id);
  }

  @Get('tenants/:code/roles')
  @ApiOperation({ summary: 'List roles available in tenant' })
  async getTenantRoles(@Param('code') code: string) {
    return this.cpService.getTenantRoles(code);
  }
}

