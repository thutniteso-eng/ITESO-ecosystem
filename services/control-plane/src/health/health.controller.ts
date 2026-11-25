import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ControlPlaneService } from '../control-plane/control-plane.service';

@Controller('health')
export class HealthController {
  constructor(private readonly cpService: ControlPlaneService) {}

  @Get()
  async getHealth(@Res() res: Response): Promise<void> {
    const { database, nats } = await this.cpService.checkHealth();
    const ok = database && nats;

    res.status(ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE).json({
      status: ok ? 'ok' : 'error',
      components: {
        control_plane: { status: 'ok' },
        database: { status: database ? 'ok' : 'error' },
        nats: { status: nats ? 'ok' : 'error' },
      },
    });
  }
}
