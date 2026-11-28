import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { cookies } from 'next/headers';

export const SESSION_COOKIE_NAME = 'iteso_admin_session';

export interface SessionData {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // unix ms
  account: {
    id: string;
    email?: string;
    phone?: string;
    isPlatformAdmin: boolean;
  };
  tenant?: string;
  tenantName?: string;
  roles: string[];
  perms: string[];
}

let cachedSessionKey: Buffer | null = null;

export function getSessionKey(): Buffer {
  if (cachedSessionKey) {
    return cachedSessionKey;
  }

  let rawKey = process.env.ADMIN_WEB_SESSION_KEY?.trim();
  if (!rawKey) {
    const keyPath =
      process.env.ADMIN_WEB_SESSION_KEY_PATH ||
      process.env.SESSION_SECRET_PATH ||
      path.resolve(process.cwd(), '../../infra/secrets/admin_web_session.key');

    if (fs.existsSync(keyPath)) {
      try {
        rawKey = fs.readFileSync(keyPath, 'utf8').trim();
      } catch (err) {
        throw new Error(`FATAL: Failed to read session key at ${keyPath}: ${err}`);
      }
    }
  }

  if (!rawKey) {
    throw new Error(
      'FATAL: admin_web_session.key not found. Missing ADMIN_WEB_SESSION_KEY or ADMIN_WEB_SESSION_KEY_PATH.',
    );
  }

  // Support base64 or raw/hex
  let keyBuf: Buffer;
  if (/^[A-Za-z0-9+/=]+$/.test(rawKey) && rawKey.length === 44) {
    keyBuf = Buffer.from(rawKey, 'base64');
  } else if (/^[0-9a-fA-F]{64}$/.test(rawKey)) {
    keyBuf = Buffer.from(rawKey, 'hex');
  } else {
    keyBuf = Buffer.from(rawKey, 'utf8');
  }

  if (keyBuf.length !== 32) {
    throw new Error(
      `FATAL: Session key must be exactly 32 bytes (got ${keyBuf.length} bytes). Admin web cannot start.`,
    );
  }

  cachedSessionKey = keyBuf;
  return keyBuf;
}

export function encryptSession(session: SessionData, overrideKey?: Buffer): string {
  const key = overrideKey || getSessionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const json = JSON.stringify(session);
  const encrypted = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptSession(cookieValue: string, overrideKey?: Buffer): SessionData | null {
  if (!cookieValue) return null;

  try {
    const key = overrideKey || getSessionKey();
    const parts = cookieValue.split(':');
    if (parts.length !== 3) return null;

    const [ivHex, tagHex, dataHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const data = Buffer.from(dataHex, 'hex');

    if (iv.length !== 12 || tag.length !== 16) {
      return null;
    }

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    return JSON.parse(decrypted) as SessionData;
  } catch {
    return null;
  }
}

export async function getSession(): Promise<SessionData | null> {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get(SESSION_COOKIE_NAME);
  if (!sessionCookie?.value) {
    return null;
  }

  const session = decryptSession(sessionCookie.value);
  if (!session) {
    return null;
  }

  // Check if access token is nearing expiration (within 60 seconds)
  const now = Date.now();
  if (now > session.expiresAt - 60_000) {
    // Attempt automatic refresh
    const refreshed = await refreshSessionToken(session);
    if (!refreshed) {
      await clearSessionCookie();
      return null;
    }
    return refreshed;
  }

  return session;
}

export async function setSessionCookie(session: SessionData): Promise<void> {
  const encrypted = encryptSession(session);
  const cookieStore = await cookies();
  const isProd = process.env.NODE_ENV === 'production';
  const isSecure = isProd || process.env.COOKIE_SECURE === 'true';

  cookieStore.set(SESSION_COOKIE_NAME, encrypted, {
    httpOnly: true,
    secure: isSecure,
    sameSite: 'strict',
    path: '/',
    maxAge: 12 * 60 * 60, // 12 hours
  });
}

export async function clearSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true',
    sameSite: 'strict',
    path: '/',
    maxAge: 0,
  });
}

async function refreshSessionToken(session: SessionData): Promise<SessionData | null> {
  const cpUrl = (process.env.CONTROL_PLANE_URL || 'http://control-plane:3100').replace(/\/+$/, '');
  try {
    const res = await fetch(`${cpUrl}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: session.refreshToken }),
    });

    if (!res.ok) {
      return null;
    }

    const data = await res.json();
    const updated: SessionData = {
      ...session,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in || 900) * 1000,
    };

    await setSessionCookie(updated);
    return updated;
  } catch {
    return null;
  }
}
