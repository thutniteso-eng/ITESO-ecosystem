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
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';

@ApiTags('Auth')
@Controller('v1')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly tokenService: TokenService,
  ) {}

  @Post('auth/login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with identifier (email/phone) and password' })
  @ApiResponse({ status: 200, description: 'Login successful or MFA/Tenant selection required' })
  async login(
    @Body() body: { identifier?: string; login?: string; password?: string },
    @Headers('x-forwarded-for') xForwardedFor?: string,
    @Headers('user-agent') userAgent?: string,
  ) {
    const ip = xForwardedFor ? xForwardedFor.split(',')[0].trim() : undefined;
    return this.authService.login(body?.identifier || body?.login, body?.password, { ip, userAgent });
  }

  @Post('auth/select-tenant')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Select active tenant after multi-tenant login' })
  @ApiResponse({ status: 200, description: 'Tokens issued for selected tenant' })
  async selectTenant(
    @Body() body: { selection_token?: string; tenant?: string; tenant_code?: string },
    @Headers('x-forwarded-for') xForwardedFor?: string,
    @Headers('user-agent') userAgent?: string,
  ) {
    const ip = xForwardedFor ? xForwardedFor.split(',')[0].trim() : undefined;
    return this.authService.selectTenant(body?.selection_token, body?.tenant || body?.tenant_code, { ip, userAgent });
  }

  @Post('auth/totp')
  @Post('auth/super-admin/mfa/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify 6-digit TOTP code for Super Admin MFA' })
  @ApiResponse({ status: 200, description: 'MFA verified, session tokens issued' })
  async verifyTotp(
    @Body() body: { challenge_token?: string; code?: string },
    @Headers('x-forwarded-for') xForwardedFor?: string,
    @Headers('user-agent') userAgent?: string,
  ) {
    const ip = xForwardedFor ? xForwardedFor.split(',')[0].trim() : undefined;
    return this.authService.verifyTotpAndLogin(body?.challenge_token, body?.code, { ip, userAgent });
  }

  @Post('auth/refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh access token using refresh token' })
  @ApiResponse({ status: 200, description: 'Tokens rotated and new access token issued' })
  async refresh(
    @Body() body: { refresh_token?: string },
    @Headers('x-forwarded-for') xForwardedFor?: string,
    @Headers('user-agent') userAgent?: string,
  ) {
    const ip = xForwardedFor ? xForwardedFor.split(',')[0].trim() : undefined;
    return this.authService.refresh(body?.refresh_token, { ip, userAgent });
  }

  @Post('auth/logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Logout and revoke refresh token family' })
  @ApiResponse({ status: 200, description: 'Logged out successfully' })
  async logout(@Body() body: { refresh_token?: string }) {
    return this.authService.logout(body?.refresh_token);
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current authenticated user info and roles' })
  @ApiResponse({ status: 200, description: 'User profile and permissions' })
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
