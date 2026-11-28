import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as jose from 'jose';
import * as crypto from 'crypto';
import Redis from 'ioredis';

export interface AccessTokenPayload {
  sub: string;
  tid?: string;
  mid?: string;
  did?: string;
  bid?: string;
  roles?: string[];
  perms?: string[];
  amr?: string[];
  is_platform_admin?: boolean;
  email?: string;
  phone?: string;
  typ?: string;
  iss?: string;
  aud?: string;
}

export interface ShortLivedTokenPayload {
  sub: string;
  typ: 'challenge' | 'selection';
  tenants?: Array<{ code: string; displayName: string }>;
}

@Injectable()
export class TokenService implements OnModuleInit, OnModuleDestroy {
  private privateKeyObj!: jose.KeyLike | Uint8Array;
  private publicKeyObj!: jose.KeyLike | Uint8Array;
  private kid: string = process.env.JWT_KEY_ID || 'iteso-ed25519-key-1';
  private redis?: Redis;

  // Fallback in-memory map for unit tests where Redis is not available
  private readonly usedJtis = new Map<string, number>();

  async onModuleInit(): Promise<void> {
    await this.loadKeys();
    const redisUrl = process.env.REDIS_URL;
    if (redisUrl) {
      try {
        this.redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
        await this.redis.connect();
      } catch (err) {
        if (process.env.NODE_ENV !== 'test') {
          throw new Error(
            `FATAL: Failed to connect to Redis at ${redisUrl}. Single-use token tracking requires Redis in non-test environments: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } else if (process.env.NODE_ENV !== 'test') {
      throw new Error(
        'FATAL: REDIS_URL environment variable is required in non-test environments for single-use token tracking.',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis) {
      await this.redis.quit().catch(() => {});
    }
  }

  async loadKeys(): Promise<void> {
    const defaultPrivPath = path.resolve(__dirname, '../../../../infra/secrets/ed25519_private.pem');
    const defaultPubPath = path.resolve(__dirname, '../../../../infra/secrets/ed25519_public.pem');

    const privPath = process.env.JWT_PRIVATE_KEY_PATH || defaultPrivPath;
    const pubPath = process.env.JWT_PUBLIC_KEY_PATH || defaultPubPath;

    if (fs.existsSync(privPath)) {
      const privPem = fs.readFileSync(privPath, 'utf8');
      this.privateKeyObj = await jose.importPKCS8(privPem, 'EdDSA');
      // Derive public key from private key if public key file is missing
      const pubKey = crypto.createPublicKey(privPem);
      const pubPem = pubKey.export({ type: 'spki', format: 'pem' });
      this.publicKeyObj = await jose.importSPKI(pubPem.toString(), 'EdDSA');
    } else if (process.env.NODE_ENV === 'test') {
      // In tests only, generate an ephemeral pair if files not found
      const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
      const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
      const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
      this.privateKeyObj = await jose.importPKCS8(privPem.toString(), 'EdDSA');
      this.publicKeyObj = await jose.importSPKI(pubPem.toString(), 'EdDSA');
      return;
    } else {
      throw new Error(
        `FATAL: Ed25519 private key file not found at ${privPath}. Ephemeral keys are strictly forbidden in non-test environments.`,
      );
    }

    if (fs.existsSync(pubPath)) {
      const pubPem = fs.readFileSync(pubPath, 'utf8');
      this.publicKeyObj = await jose.importSPKI(pubPem, 'EdDSA');
    } else if (!this.publicKeyObj && process.env.NODE_ENV !== 'test') {
      throw new Error(
        `FATAL: Ed25519 public key file not found at ${pubPath}.`,
      );
    }
  }

  // Method to allow tests to inject keys if needed
  setKeys(privateKey: jose.KeyLike | Uint8Array, publicKey: jose.KeyLike | Uint8Array): void {
    this.privateKeyObj = privateKey;
    this.publicKeyObj = publicKey;
  }

  async signAccessToken(payload: AccessTokenPayload): Promise<string> {
    return new jose.SignJWT({
      ...payload,
      typ: 'access',
    })
      .setProtectedHeader({ alg: 'EdDSA', kid: this.kid })
      .setIssuer('iteso-control-plane')
      .setAudience('iteso-api')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(this.privateKeyObj);
  }

  async verifyAccessToken(token: string): Promise<AccessTokenPayload> {
    const verified = await jose.jwtVerify(token, this.publicKeyObj, {
      algorithms: ['EdDSA'],
      audience: 'iteso-api',
      issuer: 'iteso-control-plane',
    });

    if (!verified.protectedHeader.kid || verified.protectedHeader.kid !== this.kid) {
      throw new Error(`Invalid token kid: ${verified.protectedHeader.kid}`);
    }

    if (verified.payload.typ !== 'access') {
      throw new Error(`Invalid token typ: ${verified.payload.typ}, expected 'access'`);
    }

    return verified.payload as unknown as AccessTokenPayload;
  }

  async createSingleUseToken(payload: ShortLivedTokenPayload): Promise<string> {
    const jti = crypto.randomUUID();
    return new jose.SignJWT({ ...payload })
      .setProtectedHeader({ alg: 'EdDSA', kid: this.kid })
      .setIssuer('iteso-control-plane')
      .setJti(jti)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(this.privateKeyObj);
  }

  async consumeSingleUseToken(
    token: string,
    expectedTyp: 'challenge' | 'selection',
  ): Promise<ShortLivedTokenPayload> {
    const verified = await jose.jwtVerify(token, this.publicKeyObj, {
      algorithms: ['EdDSA'],
      issuer: 'iteso-control-plane',
    });

    const jti = verified.payload.jti;
    const typ = verified.payload.typ;

    if (!jti) {
      throw new Error('Token is missing jti claim');
    }
    if (typ !== expectedTyp) {
      throw new Error(`Invalid token type, expected ${expectedTyp}`);
    }

    if (this.redis) {
      // Redis atomic single-use tracking: SET jti:<jti> 1 EX 300 NX
      const result = await this.redis.set(`jti:${jti}`, '1', 'EX', 300, 'NX');
      if (result !== 'OK') {
        throw new Error('Token has already been used');
      }
    } else {
      // Clean up expired jtis
      const now = Date.now();
      for (const [key, exp] of this.usedJtis.entries()) {
        if (exp <= now) {
          this.usedJtis.delete(key);
        }
      }

      if (this.usedJtis.has(jti)) {
        throw new Error('Token has already been used');
      }

      // Mark as used until token's expiration
      const expMs = (verified.payload.exp ?? Math.floor(now / 1000) + 300) * 1000;
      this.usedJtis.set(jti, expMs);
    }

    return verified.payload as unknown as ShortLivedTokenPayload;
  }

  async signRosterJws(payload: Record<string, unknown>): Promise<string> {
    const jti = (payload.jti as string) || crypto.randomUUID();
    const jwt = new jose.SignJWT({ ...payload, jti })
      .setProtectedHeader({ alg: 'EdDSA', kid: this.kid })
      .setIssuer('iteso-control-plane')
      .setAudience('iteso-pos')
      .setJti(jti)
      .setIssuedAt()
      .setExpirationTime('24h');

    if (payload.did) {
      jwt.setSubject(String(payload.did));
    }

    return jwt.sign(this.privateKeyObj);
  }

  async getPublicJwk(): Promise<jose.JWK> {
    return jose.exportJWK(this.publicKeyObj);
  }
}
