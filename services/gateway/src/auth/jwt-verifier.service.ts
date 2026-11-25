import { Injectable, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as jose from 'jose';

export interface TokenPayload {
  sub: string;
  tid?: string;
  mid?: string;
  roles?: string[];
  perms?: string[];
  amr?: string[];
  is_platform_admin?: boolean;
  email?: string;
  phone?: string;
}

@Injectable()
export class JwtVerifierService implements OnModuleInit {
  private publicKeyObj!: jose.KeyLike | Uint8Array;
  private readonly expectedKid: string = process.env.JWT_KEY_ID || 'iteso-ed25519-key-1';

  async onModuleInit(): Promise<void> {
    await this.loadPublicKey();
  }

  async loadPublicKey(): Promise<void> {
    const defaultPubPath = path.resolve(__dirname, '../../../../infra/secrets/ed25519_public.pem');
    const pubPath = process.env.JWT_PUBLIC_KEY_PATH || defaultPubPath;

    if (fs.existsSync(pubPath)) {
      const pubPem = fs.readFileSync(pubPath, 'utf8');
      this.publicKeyObj = await jose.importSPKI(pubPem, 'EdDSA');
    }
  }

  // Method to allow tests to inject a specific public key
  setPublicKey(key: jose.KeyLike | Uint8Array): void {
    this.publicKeyObj = key;
  }

  async verify(token: string): Promise<TokenPayload> {
    if (!this.publicKeyObj) {
      await this.loadPublicKey();
    }

    const verified = await jose.jwtVerify(token, this.publicKeyObj, {
      algorithms: ['EdDSA'],
    });

    if (verified.protectedHeader.kid && verified.protectedHeader.kid !== this.expectedKid) {
      throw new Error(`Invalid token kid: ${verified.protectedHeader.kid}`);
    }

    return verified.payload as unknown as TokenPayload;
  }
}
