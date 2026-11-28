import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { cookies } from 'next/headers';

export const SESSION_COOKIE_NAME = 'iteso_admin_session';
export const AUTH_CHALLENGE_COOKIE_NAME = 'iteso_auth_challenge';

export interface SessionData {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // unix ms
  issuedAt?: number; // unix ms
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

export type AuthChallengeData =
  | { type: 'totp'; challengeToken: string; expiresAt: number }
  | { type: 'select_tenant'; selectionToken: string; expiresAt: number };

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

export function encryptAuthChallenge(data: AuthChallengeData, overrideKey?: Buffer): string {
  const key = overrideKey || getSessionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const json = JSON.stringify(data);
  const encrypted = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptAuthChallenge(cookieValue: string, overrideKey?: Buffer): AuthChallengeData | null {
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
    const parsed = JSON.parse(decrypted) as AuthChallengeData;
    if (Date.now() > parsed.expiresAt) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function setAuthChallengeCookie(data: { type: 'totp'; challengeToken: string } | { type: 'select_tenant'; selectionToken: string }): Promise<void> {
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes
  const payload: AuthChallengeData = { ...data, expiresAt };
  const encrypted = encryptAuthChallenge(payload);
  const cookieStore = await cookies();
  const isProd = process.env.NODE_ENV === 'production';
  const isSecure = isProd || process.env.COOKIE_SECURE === 'true';

  cookieStore.set(AUTH_CHALLENGE_COOKIE_NAME, encrypted, {
    httpOnly: true,
    secure: isSecure,
    sameSite: 'strict',
    path: '/',
    maxAge: 5 * 60, // 5 minutes
  });
}

export async function getAuthChallengeCookie(): Promise<AuthChallengeData | null> {
  const cookieStore = await cookies();
  const challengeCookie = cookieStore.get(AUTH_CHALLENGE_COOKIE_NAME);
  if (!challengeCookie?.value) {
    return null;
  }
  return decryptAuthChallenge(challengeCookie.value);
}

export async function clearAuthChallengeCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(AUTH_CHALLENGE_COOKIE_NAME, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true',
    sameSite: 'strict',
    path: '/',
    maxAge: 0,
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

export function isTokenExpiring(session: SessionData, now = Date.now()): boolean {
  const totalTtlMs = session.issuedAt ? session.expiresAt - session.issuedAt : 900_000;
  // If total TTL is short (<= 60s, e.g. test mode with 20s), refresh when within 3s of expiry or already expired.
  // If total TTL is normal (> 60s, e.g. 15 mins), refresh when within 60s of expiry.
  const bufferMs = totalTtlMs <= 60_000 ? 3_000 : 60_000;
  return now >= session.expiresAt - bufferMs;
}

interface CachedRefresh {
  session: SessionData;
  cachedAt: number;
}

export const refreshCache = new Map<string, CachedRefresh>();
export const inFlightRefreshes = new Map<string, Promise<SessionData | null>>();

export async function refreshSessionWithCoalescing(session: SessionData): Promise<SessionData | null> {
  const hash = crypto.createHash('sha256').update(session.refreshToken).digest('hex');

  // 1. Check 30-second cache
  const cached = refreshCache.get(hash);
  if (cached && Date.now() - cached.cachedAt < 30_000) {
    return cached.session;
  }

  // 2. Check in-flight promise
  const inFlight = inFlightRefreshes.get(hash);
  if (inFlight) {
    return inFlight;
  }

  // 3. Initiate refresh with control plane
  const promise = (async () => {
    try {
      const cpUrl = (process.env.CONTROL_PLANE_URL || 'http://control-plane:3100').replace(/\/+$/, '');
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
        issuedAt: Date.now(),
      };

      // Store in 30-second cache
      refreshCache.set(hash, {
        session: updated,
        cachedAt: Date.now(),
      });

      // Cleanup entries older than 60s
      const now = Date.now();
      for (const [key, val] of refreshCache.entries()) {
        if (now - val.cachedAt > 60_000) {
          refreshCache.delete(key);
        }
      }

      return updated;
    } catch {
      return null;
    } finally {
      inFlightRefreshes.delete(hash);
    }
  })();

  inFlightRefreshes.set(hash, promise);
  return promise;
}
