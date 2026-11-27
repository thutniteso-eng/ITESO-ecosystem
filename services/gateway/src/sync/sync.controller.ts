import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { RequireFeature } from '../features/require-feature.decorator';
import { RequireDeviceSession } from '../auth/require-device-session.decorator';
import { PushOperation, SyncService } from './sync.service';

interface AuthenticatedRequest extends Request {
  user: {
    sub: string;
    tid: string;
    did: string;
    bid: string;
    roles: string[];
    perms: string[];
    amr: string[];
  };
  tenantCode?: string;
}

@Controller('v1/sync')
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  @Post('push')
  @HttpCode(HttpStatus.OK)
  @RequireFeature('sync.offline')
  @RequireDeviceSession()
  async push(@Req() req: AuthenticatedRequest, @Body() body: { operations: PushOperation[] }) {
    const user = req.user;
    const tenantCode = req.tenantCode || user.tid;
    const deviceId = user.did;

    return this.syncService.push(tenantCode, deviceId, body?.operations);
  }

  @Get('pull')
  @RequireFeature('sync.offline')
  @RequireDeviceSession()
  async pull(
    @Req() req: AuthenticatedRequest,
    @Query('dataset') dataset: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const user = req.user;
    const tenantCode = req.tenantCode || user.tid;
    const deviceId = user.did;

    const parsedCursor = cursor ? parseInt(cursor, 10) : 0;
    const parsedLimit = limit ? parseInt(limit, 10) : 500;

    return this.syncService.pull(tenantCode, deviceId, dataset, parsedCursor, parsedLimit);
  }
}
