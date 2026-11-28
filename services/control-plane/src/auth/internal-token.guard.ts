import {
  CanActivate,
  ExecutionContext,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class InternalTokenGuard implements CanActivate {
  private internalToken: string | null = null;

  constructor() {
    this.loadToken();
  }

  private loadToken(): void {
    if (process.env.INTERNAL_API_TOKEN) {
      this.internalToken = process.env.INTERNAL_API_TOKEN.trim();
      return;
    }

    const tokenPath =
      process.env.INTERNAL_API_TOKEN_PATH ||
      path.resolve(__dirname, '../../../../infra/secrets/internal_api.token');

    if (fs.existsSync(tokenPath)) {
      try {
        this.internalToken = fs.readFileSync(tokenPath, 'utf8').trim();
      } catch {
        this.internalToken = null;
      }
    }
  }

  canActivate(context: ExecutionContext): boolean {
    if (!this.internalToken) {
      this.loadToken();
    }

    if (!this.internalToken) {
      throw new InternalServerErrorException({
        error: 'INTERNAL_TOKEN_NOT_CONFIGURED',
        message: 'Internal API token is not configured on server',
      });
    }

    const request = context.switchToHttp().getRequest();
    const headerToken = request.headers['x-internal-token'];

    if (!headerToken || typeof headerToken !== 'string') {
      throw new UnauthorizedException({
        error: 'MISSING_INTERNAL_TOKEN',
        message: 'X-Internal-Token header is required',
      });
    }

    const providedBuffer = Buffer.from(headerToken.trim());
    const expectedBuffer = Buffer.from(this.internalToken);

    if (
      providedBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
    ) {
      throw new UnauthorizedException({
        error: 'INVALID_INTERNAL_TOKEN',
        message: 'Invalid X-Internal-Token provided',
      });
    }

    return true;
  }
}
