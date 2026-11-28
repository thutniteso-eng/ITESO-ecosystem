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
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
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

@ApiTags('Sync')
@ApiBearerAuth()
@Controller('v1/sync')
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  @Post('push')
  @HttpCode(HttpStatus.OK)
  @RequireFeature('sync.offline')
  @RequireDeviceSession()
  @ApiOperation({ summary: 'Push offline operations ledger batch from POS device' })
  @ApiResponse({ status: 200, description: 'Batch operation results' })
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
    @Query('snapshot_after_id') snapshotAfterId?: string,
    @Query('snapshot_until_outbox_id') snapshotUntilOutboxId?: string,
  ) {
    const user = req.user;
    const tenantCode = req.tenantCode || user.tid;
    const deviceId = user.did;

    const parsedCursor = cursor ? parseInt(cursor, 10) : 0;
    const parsedLimit = limit ? parseInt(limit, 10) : 500;
    const parsedSnapshotAfterId = snapshotAfterId ? parseInt(snapshotAfterId, 10) : 0;
    const parsedSnapshotUntilOutboxId = snapshotUntilOutboxId ? parseInt(snapshotUntilOutboxId, 10) : 0;

    return this.syncService.pull(
      tenantCode,
      deviceId,
      dataset,
      parsedCursor,
      parsedLimit,
      parsedSnapshotAfterId,
      parsedSnapshotUntilOutboxId,
    );
  }
}
