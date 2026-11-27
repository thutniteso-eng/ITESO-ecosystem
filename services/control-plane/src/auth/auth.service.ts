import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, and, or, inArray, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import * as schema from '../db/schema';
import {
  decryptAesGcm,
  generateRandomToken,
  hashPassword,
  sha256,
  verifyPassword,
  verifyTotp,
} from './crypto.util';
import { AccessTokenPayload, TokenService } from './token.service';

export interface LoginResultTokens {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
}

export interface LoginResultSelectTenant {
  next: 'select_tenant';
  selection_token: string;
  tenants: Array<{ code: string; displayName: string }>;
}

export interface LoginResultTotp {
  next: 'totp';
  challenge_token: string;
}

export type LoginResult = LoginResultTokens | LoginResultSelectTenant | LoginResultTotp;

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly db: NodePgDatabase<typeof schema>;
  private readonly pgPool: Pool;
  private readonly encryptionKey: string;
  private dummyHash!: string;

  constructor(private readonly tokenService: TokenService) {
    this.pgPool = new Pool({
      host: process.env.POSTGRES_HOST ?? 'postgres',
      port: Number(process.env.POSTGRES_PORT ?? 5432),
      user: process.env.POSTGRES_CONTROL_PLANE_USER ?? 'iteso_control_plane',
      password: process.env.POSTGRES_CONTROL_PLANE_PASSWORD ?? '',
      database: process.env.PLATFORM_DB ?? 'platform',
      connectionTimeoutMillis: 3000,
    });
    this.db = drizzle(this.pgPool, { schema });

    // Load and validate encryption key
    let key = process.env.PLATFORM_ENCRYPTION_KEY;
    const keyPath =
      process.env.PLATFORM_ENCRYPTION_KEY_PATH ||
      path.resolve(__dirname, '../../../../infra/secrets/platform_encryption.key');

    if (fs.existsSync(keyPath)) {
      key = fs.readFileSync(keyPath, 'utf8').trim();
    }

    if (key) {
      try {
        const decoded = Buffer.from(key, 'base64');
        if (decoded.length === 32) {
          this.encryptionKey = key;
        } else {
          throw new Error(`Decoded length is ${decoded.length}, expected 32 bytes.`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `FATAL: Invalid platform encryption key: ${msg}. Key must be 32 bytes base64 encoded.`,
        );
      }
    } else {
      throw new Error(
        `FATAL: Platform encryption key not found at ${keyPath} or via PLATFORM_ENCRYPTION_KEY.`,
      );
    }
  }

  getEncryptionKey(): string {
    return this.encryptionKey;
  }

  async onModuleInit(): Promise<void> {
    // Pre-calculate dummy password hash to defend against timing attacks on login
    this.dummyHash = await hashPassword('timing-defense-dummy-password-value-xyz');
  }

  async login(
    identifier?: string,
    password?: string,
    meta?: { ip?: string; userAgent?: string },
  ): Promise<LoginResult> {
    if (!identifier || typeof identifier !== 'string' || !password || typeof password !== 'string') {
      throw new BadRequestException({
        error: 'BAD_REQUEST',
        message: 'Identifier and password are required',
      });
    }

    // Find account by email or phone
    const cleanId = identifier.trim().toLowerCase();
    const account = await this.db.query.accounts.findFirst({
      where: or(eq(schema.accounts.email, cleanId), eq(schema.accounts.phone, cleanId)),
    });

    if (!account) {
      // Run dummy password verification to equalize response timing
      await verifyPassword(this.dummyHash, password);
      throw new UnauthorizedException({
        error: 'INVALID_CREDENTIALS',
        message: 'Invalid credentials',
      });
    }

    const now = new Date();

    // Check account lock
    if (account.lockedUntil && account.lockedUntil > now) {
      // Run dummy password verification to avoid timing leak
      await verifyPassword(account.passwordHash || this.dummyHash, password);
      throw new UnauthorizedException({
        error: 'INVALID_CREDENTIALS',
        message: 'Invalid credentials',
      });
    }

    // Check account status
    if (account.status !== 'active') {
      await verifyPassword(account.passwordHash || this.dummyHash, password);
      throw new UnauthorizedException({
        error: 'INVALID_CREDENTIALS',
        message: 'Invalid credentials',
      });
    }

    // Reset lockout if lockout duration has passed
    if (account.lockedUntil && account.lockedUntil <= now) {
      await this.db
        .update(schema.accounts)
        .set({
          failedAttempts: 0,
          lockedUntil: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.accounts.id, account.id));
      account.failedAttempts = 0;
      account.lockedUntil = null;
    }

    // Verify password
    const passwordValid = await verifyPassword(account.passwordHash, password);
    if (!passwordValid) {
      // Atomic increment and lock update
      await this.db
        .update(schema.accounts)
        .set({
          failedAttempts: sql`${schema.accounts.failedAttempts} + 1`,
          updatedAt: new Date(),
          lockedUntil: sql`CASE WHEN ${schema.accounts.failedAttempts} + 1 >= 5 THEN NOW() + INTERVAL '15 minutes' ELSE ${schema.accounts.lockedUntil} END`,
        })
        .where(eq(schema.accounts.id, account.id));

      throw new UnauthorizedException({
        error: 'INVALID_CREDENTIALS',
        message: 'Invalid credentials',
      });
    }

    // Reset failed attempts on success
    await this.db
      .update(schema.accounts)
      .set({
        failedAttempts: 0,
        lockedUntil: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.accounts.id, account.id));

    // Handle Super Admin
    if (account.isPlatformAdmin) {
      const challengeToken = await this.tokenService.createSingleUseToken({
        sub: account.id,
        typ: 'challenge',
      });
      return {
        next: 'totp',
        challenge_token: challengeToken,
      };
    }

    // Regular account: find active memberships and active tenants
    const memberships = await this.getAccountMemberships(account.id);

    if (memberships.length === 0) {
      throw new ForbiddenException({
        error: 'NO_ACTIVE_MEMBERSHIP',
        message: 'Account has no active tenant memberships',
      });
    }

    if (memberships.length > 1) {
      const selectionToken = await this.tokenService.createSingleUseToken({
        sub: account.id,
        typ: 'selection',
      });

      return {
        next: 'select_tenant',
        selection_token: selectionToken,
        tenants: memberships.map((m) => ({
          code: m.tenantCode,
          displayName: m.tenantDisplayName,
        })),
      };
    }

    // Exactly 1 membership
    const chosenMembership = memberships[0];
    return this.issueTokensForMembership(
      account,
      chosenMembership.membershipId,
      chosenMembership.tenantCode,
      meta,
    );
  }

  async selectTenant(
    selectionToken?: string,
    tenantCode?: string,
    meta?: { ip?: string; userAgent?: string },
  ): Promise<LoginResultTokens> {
    if (!selectionToken || !tenantCode) {
      throw new BadRequestException({
        error: 'BAD_REQUEST',
        message: 'selection_token and tenant are required',
      });
    }

    let payload;
    try {
      payload = await this.tokenService.consumeSingleUseToken(selectionToken, 'selection');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Invalid or expired selection token';
      throw new UnauthorizedException({
        error: 'INVALID_SELECTION_TOKEN',
        message: msg,
      });
    }

    const account = await this.db.query.accounts.findFirst({
      where: eq(schema.accounts.id, payload.sub),
    });

    if (!account || account.status !== 'active') {
      throw new UnauthorizedException({
        error: 'INVALID_CREDENTIALS',
        message: 'Account not active',
      });
    }

    const memberships = await this.getAccountMemberships(account.id);
    const chosen = memberships.find((m) => m.tenantCode === tenantCode);

    if (!chosen) {
      throw new ForbiddenException({
        error: 'TENANT_NOT_ALLOWED',
        message: `Account is not a member of tenant '${tenantCode}'`,
      });
    }

    return this.issueTokensForMembership(account, chosen.membershipId, chosen.tenantCode, meta);
  }

  async verifyTotpAndLogin(
    challengeToken?: string,
    code?: string,
    meta?: { ip?: string; userAgent?: string },
  ): Promise<LoginResultTokens> {
    if (!challengeToken || !code) {
      throw new BadRequestException({
        error: 'BAD_REQUEST',
        message: 'challenge_token and code are required',
      });
    }

    let payload;
    try {
      payload = await this.tokenService.consumeSingleUseToken(challengeToken, 'challenge');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Invalid or expired challenge token';
      throw new UnauthorizedException({
        error: 'INVALID_CHALLENGE_TOKEN',
        message: msg,
      });
    }

    const account = await this.db.query.accounts.findFirst({
      where: eq(schema.accounts.id, payload.sub),
    });

    if (!account || !account.isPlatformAdmin || account.status !== 'active') {
      throw new UnauthorizedException({
        error: 'UNAUTHORIZED',
        message: 'Invalid platform admin account',
      });
    }

    if (!account.totpSecretEnc) {
      throw new UnauthorizedException({
        error: 'TOTP_NOT_CONFIGURED',
        message: 'TOTP secret is not configured for platform admin',
      });
    }

    const totpSecret = decryptAesGcm(account.totpSecretEnc, this.encryptionKey);
    const validStep = verifyTotp(code.trim(), totpSecret);

    if (validStep === false) {
      throw new UnauthorizedException({
        error: 'INVALID_TOTP_CODE',
        message: 'Invalid or expired TOTP code',
      });
    }

    // Atomic single-use time-step tracking to prevent concurrent reuse
    const updateResult = await this.db
      .update(schema.accounts)
      .set({
        lastTotpStep: String(validStep),
        updatedAt: new Date(),
      })
      .where(
        sql`${schema.accounts.id} = ${account.id} AND (${schema.accounts.lastTotpStep} IS NULL OR ${schema.accounts.lastTotpStep}::bigint < ${validStep})`,
      )
      .returning({ id: schema.accounts.id });

    if (updateResult.length === 0) {
      throw new UnauthorizedException({
        error: 'TOTP_CODE_ALREADY_USED',
        message: 'This TOTP code has already been used. Please wait for the next time-step.',
      });
    }

    // Issue platform admin token
    const accessTokenPayload: AccessTokenPayload = {
      sub: account.id,
      email: account.email ?? undefined,
      phone: account.phone ?? undefined,
      is_platform_admin: true,
      amr: ['pwd', 'otp'],
      roles: ['platform_admin'],
      perms: ['*'],
    };

    const accessToken = await this.tokenService.signAccessToken(accessTokenPayload);
    const rawRefreshToken = generateRandomToken(32);
    const tokenHash = sha256(rawRefreshToken);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
    const now = new Date();

    await this.db.insert(schema.refreshTokens).values({
      accountId: account.id,
      membershipId: null,
      familyId: sql`gen_random_uuid()`,
      tokenHash,
      sessionStartedAt: now,
      expiresAt,
      ip: meta?.ip,
      userAgent: meta?.userAgent,
    });

    return {
      access_token: accessToken,
      refresh_token: rawRefreshToken,
      token_type: 'Bearer',
      expires_in: 900,
    };
  }

  async refresh(
    rawRefreshToken?: string,
    meta?: { ip?: string; userAgent?: string },
  ): Promise<LoginResultTokens> {
    if (!rawRefreshToken || typeof rawRefreshToken !== 'string') {
      throw new BadRequestException({
        error: 'BAD_REQUEST',
        message: 'refresh_token is required',
      });
    }

    const tokenHash = sha256(rawRefreshToken.trim());
    const tokenRecord = await this.db.query.refreshTokens.findFirst({
      where: eq(schema.refreshTokens.tokenHash, tokenHash),
    });

    if (!tokenRecord) {
      throw new UnauthorizedException({
        error: 'INVALID_REFRESH_TOKEN',
        message: 'Invalid refresh token',
      });
    }

    // Reuse detection: If token was already revoked or replaced, revoke entire family!
    if (tokenRecord.revokedAt || tokenRecord.replacedBy) {
      await this.db
        .update(schema.refreshTokens)
        .set({ revokedAt: new Date() })
        .where(eq(schema.refreshTokens.familyId, tokenRecord.familyId));

      throw new UnauthorizedException({
        error: 'TOKEN_REUSE_DETECTED',
        message: 'Refresh token reuse detected. All tokens revoked.',
      });
    }

    // Check expiration
    if (tokenRecord.expiresAt < new Date()) {
      throw new UnauthorizedException({
        error: 'REFRESH_TOKEN_EXPIRED',
        message: 'Refresh token has expired',
      });
    }

    // Check account status
    const account = await this.db.query.accounts.findFirst({
      where: eq(schema.accounts.id, tokenRecord.accountId),
    });

    if (!account || account.status !== 'active') {
      throw new UnauthorizedException({
        error: 'ACCOUNT_DISABLED',
        message: 'Account is disabled or does not exist',
      });
    }

    // Check 12-hour session limit for Platform Admin
    const isPlatformAdmin = account.isPlatformAdmin || !tokenRecord.membershipId;
    if (isPlatformAdmin) {
      const sessionStart = tokenRecord.sessionStartedAt
        ? new Date(tokenRecord.sessionStartedAt).getTime()
        : new Date(tokenRecord.createdAt).getTime();
      if (Date.now() - sessionStart > 12 * 60 * 60 * 1000) {
        await this.db
          .update(schema.refreshTokens)
          .set({ revokedAt: new Date() })
          .where(eq(schema.refreshTokens.familyId, tokenRecord.familyId));

        throw new UnauthorizedException({
          error: 'SESSION_EXPIRED',
          message: 'Platform admin session expired after 12 hours. Please log in again.',
        });
      }
    }

    // Generate new refresh token
    const newRawRefreshToken = generateRandomToken(32);
    const newTokenHash = sha256(newRawRefreshToken);
    const newExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    let newAccessToken: string;

    if (tokenRecord.membershipId) {
      const membership = await this.db.query.memberships.findFirst({
        where: eq(schema.memberships.id, tokenRecord.membershipId),
      });

      if (!membership || membership.status !== 'active') {
        throw new ForbiddenException({
          error: 'MEMBERSHIP_DISABLED',
          message: 'Membership is disabled',
        });
      }

      const tenant = await this.db.query.tenants.findFirst({
        where: eq(schema.tenants.id, membership.tenantId),
      });

      if (!tenant || tenant.status !== 'active') {
        throw new ForbiddenException({
          error: 'TENANT_DISABLED',
          message: 'Tenant is disabled',
        });
      }

      const { roles, perms } = await this.getMembershipRolesAndPerms(membership.id);

      const accessPayload: AccessTokenPayload = {
        sub: account.id,
        tid: tenant.code,
        mid: membership.id,
        roles,
        perms,
        amr: ['pwd'],
        email: account.email ?? undefined,
        phone: account.phone ?? undefined,
      };

      newAccessToken = await this.tokenService.signAccessToken(accessPayload);
    } else {
      // Platform admin token
      if (!account.isPlatformAdmin) {
        throw new UnauthorizedException({
          error: 'UNAUTHORIZED',
          message: 'Account is not a platform admin',
        });
      }

      const accessPayload: AccessTokenPayload = {
        sub: account.id,
        is_platform_admin: true,
        amr: ['pwd', 'otp'],
        roles: ['platform_admin'],
        perms: ['*'],
        email: account.email ?? undefined,
        phone: account.phone ?? undefined,
      };

      newAccessToken = await this.tokenService.signAccessToken(accessPayload);
    }

    // Rotate token atomically in transaction to prevent race conditions
    let reuseDetected = false;
    try {
      await this.db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(schema.refreshTokens)
          .values({
            accountId: account.id,
            membershipId: tokenRecord.membershipId,
            familyId: tokenRecord.familyId,
            tokenHash: newTokenHash,
            sessionStartedAt: tokenRecord.sessionStartedAt,
            expiresAt: newExpiresAt,
            ip: meta?.ip,
            userAgent: meta?.userAgent,
          })
          .returning({ id: schema.refreshTokens.id });

        const revokedOld = await tx
          .update(schema.refreshTokens)
          .set({
            revokedAt: new Date(),
            replacedBy: inserted.id,
          })
          .where(
            and(
              eq(schema.refreshTokens.id, tokenRecord.id),
              sql`${schema.refreshTokens.revokedAt} IS NULL`,
            ),
          )
          .returning({ id: schema.refreshTokens.id });

        if (revokedOld.length === 0) {
          // Concurrently rotated! Mark flag and abort tx
          reuseDetected = true;
          throw new Error('CONCURRENT_ROTATION_ABORT');
        }
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (reuseDetected || errMsg === 'CONCURRENT_ROTATION_ABORT') {
        // Revoke whole family in a separate, committed transaction!
        await this.db
          .update(schema.refreshTokens)
          .set({ revokedAt: new Date() })
          .where(eq(schema.refreshTokens.familyId, tokenRecord.familyId));

        throw new UnauthorizedException({
          error: 'TOKEN_REUSE_DETECTED',
          message: 'Refresh token reuse detected. All tokens revoked.',
        });
      }
      throw err;
    }

    return {
      access_token: newAccessToken,
      refresh_token: newRawRefreshToken,
      token_type: 'Bearer',
      expires_in: 900,
    };
  }

  async logout(rawRefreshToken?: string): Promise<{ success: boolean }> {
    if (!rawRefreshToken || typeof rawRefreshToken !== 'string') {
      return { success: true };
    }

    const tokenHash = sha256(rawRefreshToken.trim());
    const tokenRecord = await this.db.query.refreshTokens.findFirst({
      where: eq(schema.refreshTokens.tokenHash, tokenHash),
    });

    if (tokenRecord) {
      await this.db
        .update(schema.refreshTokens)
        .set({ revokedAt: new Date() })
        .where(eq(schema.refreshTokens.familyId, tokenRecord.familyId));
    }

    return { success: true };
  }

  async getMe(payload: AccessTokenPayload): Promise<Record<string, unknown>> {
    const account = await this.db.query.accounts.findFirst({
      where: eq(schema.accounts.id, payload.sub),
    });

    if (!account) {
      throw new UnauthorizedException({
        error: 'USER_NOT_FOUND',
        message: 'Account not found',
      });
    }

    if (payload.is_platform_admin) {
      return {
        account: {
          id: account.id,
          email: account.email,
          phone: account.phone,
          isPlatformAdmin: true,
        },
        roles: payload.roles ?? ['platform_admin'],
        perms: payload.perms ?? ['*'],
      };
    }

    return {
      account: {
        id: account.id,
        email: account.email,
        phone: account.phone,
        isPlatformAdmin: false,
      },
      tenant: payload.tid,
      membershipId: payload.mid,
      roles: payload.roles ?? [],
      perms: payload.perms ?? [],
    };
  }

  private async getAccountMemberships(accountId: string) {
    const mems = await this.db
      .select({
        membershipId: schema.memberships.id,
        status: schema.memberships.status,
        tenantCode: schema.tenants.code,
        tenantDisplayName: schema.tenants.displayName,
        tenantStatus: schema.tenants.status,
      })
      .from(schema.memberships)
      .innerJoin(schema.tenants, eq(schema.memberships.tenantId, schema.tenants.id))
      .where(
        and(
          eq(schema.memberships.accountId, accountId),
          eq(schema.memberships.status, 'active'),
          eq(schema.tenants.status, 'active'),
        ),
      );

    return mems;
  }

  private async getMembershipRolesAndPerms(membershipId: string) {
    const roleRows = await this.db
      .select({
        roleId: schema.roles.id,
        roleName: schema.roles.name,
        isOwner: schema.roles.isOwner,
      })
      .from(schema.membershipRoles)
      .innerJoin(schema.roles, eq(schema.membershipRoles.roleId, schema.roles.id))
      .where(eq(schema.membershipRoles.membershipId, membershipId));

    const roles = roleRows.map((r) => r.roleName);
    const roleIds = roleRows.map((r) => r.roleId);

    if (roleIds.length === 0) {
      return { roles: [], perms: [] };
    }

    const permRows = await this.db
      .select({
        permissionKey: schema.rolePermissions.permissionKey,
      })
      .from(schema.rolePermissions)
      .where(inArray(schema.rolePermissions.roleId, roleIds));

    const perms = Array.from(new Set(permRows.map((p) => p.permissionKey)));
    return { roles, perms };
  }

  private async issueTokensForMembership(
    account: typeof schema.accounts.$inferSelect,
    membershipId: string,
    tenantCode: string,
    meta?: { ip?: string; userAgent?: string },
  ): Promise<LoginResultTokens> {
    const { roles, perms } = await this.getMembershipRolesAndPerms(membershipId);

    const accessPayload: AccessTokenPayload = {
      sub: account.id,
      tid: tenantCode,
      mid: membershipId,
      roles,
      perms,
      amr: ['pwd'],
      email: account.email ?? undefined,
      phone: account.phone ?? undefined,
    };

    const accessToken = await this.tokenService.signAccessToken(accessPayload);
    const rawRefreshToken = generateRandomToken(32);
    const tokenHash = sha256(rawRefreshToken);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const now = new Date();

    await this.db.insert(schema.refreshTokens).values({
      accountId: account.id,
      membershipId,
      familyId: sql`gen_random_uuid()`,
      tokenHash,
      sessionStartedAt: now,
      expiresAt,
      ip: meta?.ip,
      userAgent: meta?.userAgent,
    });

    return {
      access_token: accessToken,
      refresh_token: rawRefreshToken,
      token_type: 'Bearer',
      expires_in: 900,
    };
  }
}
