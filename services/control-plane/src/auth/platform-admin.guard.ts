import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { TokenService } from './token.service';

@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(private readonly tokenService: TokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers['authorization'];

    if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException({
        error: 'UNAUTHORIZED',
        message: 'Missing or invalid Authorization header',
      });
    }

    const token = authHeader.substring(7).trim();
    try {
      const payload = await this.tokenService.verifyAccessToken(token);

      // Verify that account is platform admin
      if (!payload.is_platform_admin) {
        throw new UnauthorizedException({
          error: 'UNAUTHORIZED',
          message: 'Access denied: Platform admin privileges required',
        });
      }

      // Verify that amr contains 'otp' (Super Admin requires 2FA)
      if (!Array.isArray(payload.amr) || !payload.amr.includes('otp')) {
        throw new UnauthorizedException({
          error: 'UNAUTHORIZED',
          message: 'Access denied: Two-factor authentication (OTP) required',
        });
      }

      // Attach user to request
      request.user = {
        id: payload.sub,
        email: payload.email,
        phone: payload.phone,
        isPlatformAdmin: true,
      };

      return true;
    } catch (err: unknown) {
      if (err instanceof UnauthorizedException) {
        throw err;
      }
      throw new UnauthorizedException({
        error: 'UNAUTHORIZED',
        message: 'Invalid or expired admin access token',
      });
    }
  }
}
