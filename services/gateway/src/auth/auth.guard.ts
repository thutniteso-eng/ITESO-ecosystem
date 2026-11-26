import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from './public.decorator';
import { REQUIRE_PERMISSION_KEY } from './require-permission.decorator';
import { JwtVerifierService } from './jwt-verifier.service';

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly jwtVerifier: JwtVerifierService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const path: string = req.path ?? req.url ?? '';

    // Only apply auth checks to routes under /v1
    if (!path.startsWith('/v1')) {
      return true;
    }

    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(
      IS_PUBLIC_KEY,
      [context.getHandler(), context.getClass()],
    );

    const requiredPermission = this.reflector.getAllAndOverride<string | undefined>(
      REQUIRE_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );

    // Rule 5: Every /v1 route MUST declare either @Public() or @RequirePermission('<key>')
    if (!isPublic && !requiredPermission) {
      this.logger.error(`Undeclared permission on v1 endpoint: ${req.method} ${path}`);
      throw new ForbiddenException({
        error: 'PERMISSION_UNDECLARED',
        message: `Endpoint '${path}' does not declare a required permission or @Public()`,
      });
    }

    // Public route passes auth check
    if (isPublic) {
      return true;
    }

    // Non-public route requires Bearer token
    const authHeader = req.headers['authorization'];
    if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException({
        error: 'UNAUTHENTICATED',
        message: 'Missing or invalid Authorization header',
      });
    }

    const token = authHeader.substring(7).trim();
    let payload;
    try {
      payload = await this.jwtVerifier.verify(token);
    } catch {
      throw new UnauthorizedException({
        error: 'UNAUTHENTICATED',
        message: 'Invalid or expired token',
      });
    }

    // Tenant endpoints require tenant token with both tid and mid
    if (!payload.tid || !payload.mid) {
      throw new ForbiddenException({
        error: 'PLATFORM_TOKEN_NOT_ALLOWED',
        message: 'Platform tokens without tenant context are not permitted on tenant endpoints',
      });
    }

    // Tenant mismatch check
    const headerTenant = req.headers['x-tenant'];
    if (headerTenant && headerTenant !== payload.tid) {
      throw new ForbiddenException({
        error: 'TENANT_MISMATCH',
        message: `X-Tenant header '${headerTenant}' does not match token tenant '${payload.tid}'`,
      });
    }

    // Permission check: strictly check permission against payload.perms (no wildcard bypass)
    const userPerms: string[] = Array.isArray(payload.perms) ? payload.perms : [];
    if (requiredPermission && !userPerms.includes(requiredPermission)) {
      throw new ForbiddenException({
        error: 'PERMISSION_DENIED',
        permission: requiredPermission,
      });
    }

    // Attach to request
    req.user = payload;
    req.tenantCode = payload.tid;

    return true;
  }
}
