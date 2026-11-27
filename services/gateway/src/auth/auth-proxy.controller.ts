import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
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

  private async forwardPost(
    path: string,
    body: unknown,
    headers: Record<string, string | string[] | undefined>,
    req: Request,
    res: Response,
  ) {
    try {
      // Forward real client IP and User-Agent
      const clientIp =
        (headers['x-forwarded-for'] as string) ||
        req.socket.remoteAddress ||
        '';
      const userAgent = (headers['user-agent'] as string) || '';

      const response = await fetch(`${this.controlPlaneUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': clientIp,
          'user-agent': userAgent,
          ...(headers['authorization']
            ? { authorization: String(headers['authorization']) }
            : {}),
        },
        body: JSON.stringify(body ?? {}),
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
}
