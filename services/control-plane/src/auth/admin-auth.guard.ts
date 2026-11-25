import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as crypto from 'crypto';

@Injectable()
export class AdminAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const token = req.headers['x-admin-token'];
    const expectedToken = process.env.CONTROL_PLANE_ADMIN_TOKEN;

    if (!expectedToken || !token || typeof token !== 'string') {
      throw new UnauthorizedException({
        error: 'UNAUTHORIZED',
        message: 'Invalid or missing admin token',
      });
    }

    const tokenBuf = Buffer.from(token);
    const expectedBuf = Buffer.from(expectedToken);

    if (
      tokenBuf.length !== expectedBuf.length ||
      !crypto.timingSafeEqual(tokenBuf, expectedBuf)
    ) {
      throw new UnauthorizedException({
        error: 'UNAUTHORIZED',
        message: 'Invalid or missing admin token',
      });
    }

    return true;
  }
}
