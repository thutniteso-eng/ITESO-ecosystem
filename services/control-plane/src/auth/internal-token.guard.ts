import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class InternalTokenGuard implements CanActivate {
  private internalToken: string;

  constructor() {
    this.internalToken = this.loadAndValidateToken();
  }

  private loadAndValidateToken(): string {
    let token = process.env.INTERNAL_API_TOKEN?.trim();

    if (!token) {
      const tokenPath =
        process.env.INTERNAL_API_TOKEN_PATH ||
        path.resolve(__dirname, '../../../../infra/secrets/internal_api.token');

      if (fs.existsSync(tokenPath)) {
        try {
          token = fs.readFileSync(tokenPath, 'utf8').trim();
        } catch {
          token = undefined;
        }
      }
    }

    if (!token) {
      throw new Error(
        'FATAL: Internal API token is not configured or not found. Service cannot start.',
      );
    }

    const bufHex = Buffer.from(token, 'hex');
    const bufRaw = Buffer.from(token, 'utf8');
    const is32Bytes = (token.length === 64 && bufHex.length === 32) || bufRaw.length === 32;

    if (!is32Bytes) {
      throw new Error(
        `FATAL: Internal API token must be exactly 32 bytes (got ${bufRaw.length} raw bytes / length ${token.length}). Service cannot start.`,
      );
    }

    return token;
  }

  canActivate(context: ExecutionContext): boolean {
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
