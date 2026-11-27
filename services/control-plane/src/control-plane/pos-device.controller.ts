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
  UnauthorizedException,
} from '@nestjs/common';
import { PosDeviceService } from './pos-device.service';
import { TokenService } from '../auth/token.service';

@Controller('v1')
export class PosDeviceController {
  constructor(
    private readonly posDeviceService: PosDeviceService,
    private readonly tokenService: TokenService,
  ) {}

  private async getAuthPayload(authHeader?: string) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException({
        error: 'UNAUTHENTICATED',
        message: 'Missing or invalid Authorization header',
      });
    }
    const token = authHeader.substring(7).trim();
    try {
      return await this.tokenService.verifyAccessToken(token);
    } catch {
      throw new UnauthorizedException({
        error: 'UNAUTHENTICATED',
        message: 'Invalid or expired token',
      });
    }
  }

  @Post('pos/pairing-codes')
  @HttpCode(HttpStatus.OK)
  async createPairingCode(
    @Headers('authorization') authHeader: string | undefined,
    @Body() body: { branch_code?: string; device_name?: string },
  ) {
    const authPayload = await this.getAuthPayload(authHeader);
    return this.posDeviceService.createPairingCode(
      authPayload,
      body?.branch_code || '',
      body?.device_name || '',
    );
  }

  @Post('pos/devices/pair')
  @HttpCode(HttpStatus.OK)
  async pairDevice(
    @Body() body: { pairing_code?: string },
    @Headers('x-forwarded-for') xForwardedFor?: string,
  ) {
    const clientIp = xForwardedFor ? xForwardedFor.split(',')[0].trim() : undefined;
    return this.posDeviceService.pairDevice(body?.pairing_code || '', clientIp);
  }

  @Get('pos/devices')
  async listDevices(@Headers('authorization') authHeader: string | undefined) {
    const authPayload = await this.getAuthPayload(authHeader);
    return this.posDeviceService.listDevices(authPayload);
  }

  @Delete('pos/devices/:id')
  async revokeDevice(
    @Headers('authorization') authHeader: string | undefined,
    @Param('id') id: string,
  ) {
    const authPayload = await this.getAuthPayload(authHeader);
    return this.posDeviceService.revokeDevice(authPayload, id);
  }

  @Put('me/pin')
  @HttpCode(HttpStatus.OK)
  async setMyPin(
    @Headers('authorization') authHeader: string | undefined,
    @Body() body: { pin?: string; password?: string },
  ) {
    const authPayload = await this.getAuthPayload(authHeader);
    return this.posDeviceService.setMyPin(authPayload, body?.pin, body?.password);
  }

  @Delete('staff/:membership_id/pin')
  async resetStaffPin(
    @Headers('authorization') authHeader: string | undefined,
    @Param('membership_id') membershipId: string,
  ) {
    const authPayload = await this.getAuthPayload(authHeader);
    return this.posDeviceService.resetStaffPin(authPayload, membershipId);
  }

  @Post('pos/auth/pin')
  @HttpCode(HttpStatus.OK)
  async loginWithPin(
    @Headers('authorization') deviceAuthHeader: string | undefined,
    @Body() body: { membership_id?: string; pin?: string },
    @Headers('x-forwarded-for') xForwardedFor?: string,
    @Headers('user-agent') userAgent?: string,
  ) {
    const ip = xForwardedFor ? xForwardedFor.split(',')[0].trim() : undefined;
    return this.posDeviceService.loginWithPin(
      deviceAuthHeader,
      body?.membership_id,
      body?.pin,
      { ip, userAgent },
    );
  }

  @Post('pos/auth/refresh')
  @HttpCode(HttpStatus.OK)
  async refreshPinSession(
    @Headers('authorization') deviceAuthHeader: string | undefined,
    @Body() body: { refresh_token?: string },
    @Headers('x-forwarded-for') xForwardedFor?: string,
    @Headers('user-agent') userAgent?: string,
  ) {
    const ip = xForwardedFor ? xForwardedFor.split(',')[0].trim() : undefined;
    return this.posDeviceService.refreshPinSession(
      deviceAuthHeader,
      body?.refresh_token,
      { ip, userAgent },
    );
  }

  @Get('pos/roster')
  async getRoster(@Headers('authorization') deviceAuthHeader: string | undefined) {
    return this.posDeviceService.getRoster(deviceAuthHeader);
  }
}
