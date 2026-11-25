import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';

@Controller('v1')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly tokenService: TokenService,
  ) {}

  @Post('auth/login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() body: { identifier?: string; login?: string; password?: string }) {
    return this.authService.login(body?.identifier || body?.login, body?.password);
  }

  @Post('auth/select-tenant')
  @HttpCode(HttpStatus.OK)
  async selectTenant(@Body() body: { selection_token?: string; tenant?: string; tenant_code?: string }) {
    return this.authService.selectTenant(body?.selection_token, body?.tenant || body?.tenant_code);
  }

  @Post('auth/totp')
  @HttpCode(HttpStatus.OK)
  async verifyTotp(@Body() body: { challenge_token?: string; code?: string }) {
    return this.authService.verifyTotpAndLogin(body?.challenge_token, body?.code);
  }

  @Post('auth/refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() body: { refresh_token?: string }) {
    return this.authService.refresh(body?.refresh_token);
  }

  @Post('auth/logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Body() body: { refresh_token?: string }) {
    return this.authService.logout(body?.refresh_token);
  }

  @Get('me')
  async getMe(@Headers('authorization') authHeader?: string) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException({
        error: 'UNAUTHENTICATED',
        message: 'Missing or invalid Authorization header',
      });
    }

    const token = authHeader.substring(7).trim();
    try {
      const payload = await this.tokenService.verifyAccessToken(token);
      return await this.authService.getMe(payload);
    } catch {
      throw new UnauthorizedException({
        error: 'UNAUTHENTICATED',
        message: 'Invalid or expired token',
      });
    }
  }
}
