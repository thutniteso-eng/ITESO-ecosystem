import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import { Response, Request } from 'express';
import { RequireFeature } from '../features/require-feature.decorator';
import { Public } from './public.decorator';
import { RequirePermission } from './require-permission.decorator';

@Controller('v1')
export class AuthProxyController {
  private readonly controlPlaneUrl: string =
    process.env.CONTROL_PLANE_URL || 'http://control-plane:3100';

  private async forwardRequest(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body: unknown,
    headers: Record<string, string | string[] | undefined>,
    req: Request,
    res: Response,
  ) {
    try {
      // Forward real client IP from socket and User-Agent; ignore client-supplied X-Forwarded-For
      const clientIp = req.socket.remoteAddress || '';
      const userAgent = (headers['user-agent'] as string) || '';

      const fetchOptions: RequestInit = {
        method,
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': clientIp,
          'user-agent': userAgent,
          ...(headers['authorization']
            ? { authorization: String(headers['authorization']) }
            : {}),
        },
      };

      if (method !== 'GET') {
        fetchOptions.body = JSON.stringify(body ?? {});
      }

      const response = await fetch(`${this.controlPlaneUrl}${path}`, fetchOptions);

      const data = await response.json().catch(() => ({}));
      return res.status(response.status).json(data);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Control Plane unavailable';
      return res.status(HttpStatus.BAD_GATEWAY).json({
        error: 'BAD_GATEWAY',
        message: `Error connecting to control plane: ${message}`,
      });
    }
  }

  private async forwardPost(
    path: string,
    body: unknown,
    headers: Record<string, string | string[] | undefined>,
    req: Request,
    res: Response,
  ) {
    return this.forwardRequest('POST', path, body, headers, req, res);
  }

  @Post('auth/login')
  @HttpCode(HttpStatus.OK)
  @RequireFeature('system.auth')
  @Public()
  async login(@Body() body: unknown, @Req() req: Request, @Res() res: Response) {
    return this.forwardPost('/v1/auth/login', body, req.headers, req, res);
  }

  @Post('auth/select-tenant')
  @HttpCode(HttpStatus.OK)
  @RequireFeature('system.auth')
  @Public()
  async selectTenant(@Body() body: unknown, @Req() req: Request, @Res() res: Response) {
    return this.forwardPost('/v1/auth/select-tenant', body, req.headers, req, res);
  }

  @Post('auth/totp')
  @HttpCode(HttpStatus.OK)
  @RequireFeature('system.auth')
  @Public()
  async totp(@Body() body: unknown, @Req() req: Request, @Res() res: Response) {
    return this.forwardPost('/v1/auth/totp', body, req.headers, req, res);
  }

  @Post('auth/refresh')
  @HttpCode(HttpStatus.OK)
  @RequireFeature('system.auth')
  @Public()
  async refresh(@Body() body: unknown, @Req() req: Request, @Res() res: Response) {
    return this.forwardPost('/v1/auth/refresh', body, req.headers, req, res);
  }

  @Post('auth/logout')
  @HttpCode(HttpStatus.OK)
  @RequireFeature('system.auth')
  @Public()
  async logout(@Body() body: unknown, @Req() req: Request, @Res() res: Response) {
    return this.forwardPost('/v1/auth/logout', body, req.headers, req, res);
  }

  @Get('me')
  @RequireFeature('system.auth')
  @RequirePermission('system.features.read')
  async getMe(@Headers('authorization') authHeader: string, @Res() res: Response) {
    try {
      const response = await fetch(`${this.controlPlaneUrl}/v1/me`, {
        method: 'GET',
        headers: {
          authorization: authHeader,
        },
      });

      const data = await response.json().catch(() => ({}));
      return res.status(response.status).json(data);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Control Plane unavailable';
      return res.status(HttpStatus.BAD_GATEWAY).json({
        error: 'BAD_GATEWAY',
        message: `Error connecting to control plane: ${message}`,
      });
    }
  }

  // ==========================================
  // TASK-005 POS Device & PIN endpoints
  // ==========================================

  @Post('pos/pairing-codes')
  @HttpCode(HttpStatus.OK)
  @RequireFeature('pos.devices')
  @RequirePermission('pos.device.manage')
  async createPairingCode(@Body() body: unknown, @Req() req: Request, @Res() res: Response) {
    return this.forwardPost('/v1/pos/pairing-codes', body, req.headers, req, res);
  }

  @Post('pos/devices/pair')
  @HttpCode(HttpStatus.OK)
  @RequireFeature('pos.devices')
  @Public()
  async pairDevice(@Body() body: unknown, @Req() req: Request, @Res() res: Response) {
    return this.forwardPost('/v1/pos/devices/pair', body, req.headers, req, res);
  }

  @Get('pos/devices')
  @RequireFeature('pos.devices')
  @RequirePermission('pos.device.manage')
  async listDevices(@Req() req: Request, @Res() res: Response) {
    return this.forwardRequest('GET', '/v1/pos/devices', null, req.headers, req, res);
  }

  @Delete('pos/devices/:id')
  @RequireFeature('pos.devices')
  @RequirePermission('pos.device.manage')
  async revokeDevice(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    return this.forwardRequest('DELETE', `/v1/pos/devices/${id}`, null, req.headers, req, res);
  }

  @Put('me/pin')
  @HttpCode(HttpStatus.OK)
  @RequireFeature('pos.devices')
  @RequirePermission('system.features.read')
  async setMyPin(@Body() body: unknown, @Req() req: Request, @Res() res: Response) {
    return this.forwardRequest('PUT', '/v1/me/pin', body, req.headers, req, res);
  }

  @Delete('staff/:membership_id/pin')
  @RequireFeature('pos.devices')
  @RequirePermission('staff.pin.reset')
  async resetStaffPin(@Param('membership_id') membershipId: string, @Req() req: Request, @Res() res: Response) {
    return this.forwardRequest('DELETE', `/v1/staff/${membershipId}/pin`, null, req.headers, req, res);
  }

  @Post('pos/auth/pin')
  @HttpCode(HttpStatus.OK)
  @RequireFeature('pos.devices')
  @Public()
  async loginWithPin(@Body() body: unknown, @Req() req: Request, @Res() res: Response) {
    return this.forwardPost('/v1/pos/auth/pin', body, req.headers, req, res);
  }

  @Post('pos/auth/refresh')
  @HttpCode(HttpStatus.OK)
  @RequireFeature('pos.devices')
  @Public()
  async refreshPinSession(@Body() body: unknown, @Req() req: Request, @Res() res: Response) {
    return this.forwardPost('/v1/pos/auth/refresh', body, req.headers, req, res);
  }

  @Get('pos/roster')
  @RequireFeature('pos.devices')
  @Public()
  async getRoster(@Req() req: Request, @Res() res: Response) {
    return this.forwardRequest('GET', '/v1/pos/roster', null, req.headers, req, res);
  }

  // TASK-006: Device session token & number blocks proxying
  @Post('pos/auth/device-session')
  @HttpCode(HttpStatus.OK)
  @RequireFeature('pos.devices')
  @Public()
  async issueDeviceSession(@Req() req: Request, @Res() res: Response) {
    return this.forwardPost('/v1/pos/auth/device-session', null, req.headers, req, res);
  }

  @Post('pos/number-blocks')
  @HttpCode(HttpStatus.OK)
  @RequireFeature('pos.devices')
  @Public()
  async allocateNumberBlock(@Body() body: unknown, @Req() req: Request, @Res() res: Response) {
    return this.forwardPost('/v1/pos/number-blocks', body, req.headers, req, res);
  }
}
