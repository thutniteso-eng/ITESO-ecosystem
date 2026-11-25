import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

@Injectable()
export class AdminAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const token = req.headers['x-admin-token'];
    const expectedToken = process.env.CONTROL_PLANE_ADMIN_TOKEN;

    if (!expectedToken || !token || token !== expectedToken) {
      throw new UnauthorizedException({
        error: 'UNAUTHORIZED',
        message: 'Invalid or missing admin token',
      });
    }

    return true;
  }
}
