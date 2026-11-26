import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { REQUIRE_FEATURE_KEY } from './require-feature.decorator';
import { PlatformService } from './platform.service';

@Injectable()
export class FeatureFlagGuard implements CanActivate {
  private readonly logger = new Logger(FeatureFlagGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly platformService: PlatformService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const path: string = req.path ?? req.url ?? '';

    // Only apply checks for routes under /v1
    if (!path.startsWith('/v1')) {
      return true;
    }

    const featureKey = this.reflector.getAllAndOverride<string | undefined>(
      REQUIRE_FEATURE_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!featureKey) {
      this.logger.error(`Undeclared feature on v1 endpoint: ${req.method} ${path}`);
      throw new ForbiddenException({
        error: 'FEATURE_UNDECLARED',
        message: `Endpoint '${path}' does not declare a required feature flag`,
      });
    }

    // Read exclusively from req.tenantCode or req.user.tid (set by AuthGuard from token)
    const tenantCode: string | undefined = req.tenantCode || req.user?.tid;

    const isEnabled = await this.platformService.isFeatureEnabled(
      tenantCode,
      featureKey,
    );

    if (!isEnabled) {
      throw new ForbiddenException({
        error: 'FEATURE_DISABLED',
        feature: featureKey,
      });
    }

    return true;
  }
}
