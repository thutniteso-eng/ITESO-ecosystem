import { Injectable, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as jose from 'jose';
import * as crypto from 'crypto';

export interface AccessTokenPayload {
  sub: string;
  tid?: string;
  mid?: string;
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
export class TokenService implements OnModuleInit {
  private privateKeyObj!: jose.KeyLike | Uint8Array;
  private publicKeyObj!: jose.KeyLike | Uint8Array;
  private kid: string = process.env.JWT_KEY_ID || 'iteso-ed25519-key-1';

  // In-memory single-use tracking: jti -> expiresAtMs
  private readonly usedJtis = new Map<string, number>();

  async onModuleInit(): Promise<void> {
    await this.loadKeys();
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

    return verified.payload as unknown as ShortLivedTokenPayload;
  }
}
