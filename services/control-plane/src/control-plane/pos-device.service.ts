import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import * as argon2 from 'argon2';
import * as schema from '../db/schema';
import {
  generatePairingCode,
  generateRandomToken,
  sha256,
  validatePinComplexity,
  verifyPassword,
} from '../auth/crypto.util';
import { AccessTokenPayload, TokenService } from '../auth/token.service';
import { NatsService } from '../nats/nats.service';

export interface PosPairingCodeResult {
  pairing_code: string;
  expires_at: string;
  device_name: string;
  branch_code: string;
}

export interface PosDevicePairResult {
  device_id: string;
  device_token: string;
  branch: {
    id: string;
    code: string;
    name: string;
  };
  roster_public_jwk: Record<string, unknown>;
}

export interface PosPinLoginResult {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
}

@Injectable()
export class PosDeviceService {
  private readonly db: NodePgDatabase<typeof schema>;
  private readonly pgPool: Pool;
  private readonly dummyPinHash =
    '$argon2id$v=19$m=19456,t=2,p=1$ZHVtbXlzYWx0MTIzNDU2Nw$dummyhashdummyhashdummyhashdummyhashdummyhash';

  // In-memory IP rate limiter for /v1/pos/devices/pair (10 requests / minute / IP)
  private readonly pairAttempts = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly tokenService: TokenService,
    private readonly natsService: NatsService,
  ) {
    this.pgPool = new Pool({
      host: process.env.POSTGRES_HOST ?? 'postgres',
      port: Number(process.env.POSTGRES_PORT ?? 5432),
      user: process.env.POSTGRES_CONTROL_PLANE_USER ?? 'iteso_control_plane',
      password: process.env.POSTGRES_CONTROL_PLANE_PASSWORD ?? '',
      database: process.env.PLATFORM_DB ?? 'platform',
      connectionTimeoutMillis: 3000,
    });
    this.db = drizzle(this.pgPool, { schema });
  }

  async onModuleDestroy(): Promise<void> {
    await this.pgPool.end();
  }

  // -------------------------------------------------------------
  // 1. Pairing Codes
  // -------------------------------------------------------------

  async createPairingCode(
    authPayload: AccessTokenPayload,
    branchCode: string,
    deviceName: string,
  ): Promise<PosPairingCodeResult> {
    if (!branchCode || !deviceName) {
      throw new BadRequestException({
        error: 'BAD_REQUEST',
        message: 'branch_code and device_name are required',
      });
    }

    if (!authPayload.tid) {
      throw new ForbiddenException({
        error: 'TENANT_REQUIRED',
        message: 'Tenant context required to create pairing code',
      });
    }

    const tenant = await this.db.query.tenants.findFirst({
      where: eq(schema.tenants.code, authPayload.tid),
    });
    if (!tenant || tenant.status !== 'active') {
      throw new ForbiddenException({
        error: 'TENANT_DISABLED',
        message: 'Tenant not active',
      });
    }

    const branch = await this.db.query.branches.findFirst({
      where: and(
        eq(schema.branches.tenantId, tenant.id),
        eq(schema.branches.code, branchCode),
      ),
    });
    if (!branch || branch.status !== 'active') {
      throw new NotFoundException({
        error: 'BRANCH_NOT_FOUND',
        message: `Active branch with code '${branchCode}' not found`,
      });
    }

    const rawCode = generatePairingCode(8);
    const codeHash = sha256(rawCode);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    await this.db.insert(schema.posPairingCodes).values({
      tenantId: tenant.id,
      branchId: branch.id,
      deviceName: deviceName.trim(),
      codeHash,
      createdByMembershipId: authPayload.mid ?? null,
      expiresAt,
    });

    return {
      pairing_code: rawCode,
      expires_at: expiresAt.toISOString(),
      device_name: deviceName.trim(),
      branch_code: branch.code,
    };
  }

  // -------------------------------------------------------------
  // 2. Device Pairing
  // -------------------------------------------------------------

  async pairDevice(pairingCode: string, clientIp?: string): Promise<PosDevicePairResult> {
    // IP Rate limiting: 10 per minute
    if (clientIp) {
      const now = Date.now();
      const ipEntry = this.pairAttempts.get(clientIp);
      if (ipEntry && ipEntry.resetAt > now) {
        if (ipEntry.count >= 10) {
          throw new BadRequestException({
            error: 'RATE_LIMIT_EXCEEDED',
            message: 'Too many pairing attempts. Please wait 1 minute.',
          });
        }
        ipEntry.count++;
      } else {
        this.pairAttempts.set(clientIp, { count: 1, resetAt: now + 60 * 1000 });
      }
    }

    if (!pairingCode) {
      throw new BadRequestException({
        error: 'BAD_REQUEST',
        message: 'pairing_code is required',
      });
    }

    const codeHash = sha256(pairingCode.trim());
    const now = new Date();

    // Atomic update of used_at to ensure single-use even under concurrent requests
    const updated = await this.db
      .update(schema.posPairingCodes)
      .set({ usedAt: now })
      .where(
        and(
          eq(schema.posPairingCodes.codeHash, codeHash),
          sql`${schema.posPairingCodes.usedAt} IS NULL`,
          sql`${schema.posPairingCodes.expiresAt} > ${now}`,
        ),
      )
      .returning();

    if (updated.length === 0) {
      throw new UnauthorizedException({
        error: 'INVALID_PAIRING_CODE',
        message: 'Pairing code is invalid, expired, or already used',
      });
    }

    const record = updated[0];

    const branch = await this.db.query.branches.findFirst({
      where: eq(schema.branches.id, record.branchId),
    });
    if (!branch || branch.status !== 'active') {
      throw new ForbiddenException({
        error: 'BRANCH_DISABLED',
        message: 'Branch is not active',
      });
    }

    // Generate 32-byte raw device token
    const rawDeviceToken = generateRandomToken(32);
    const tokenHash = sha256(rawDeviceToken);

    const [device] = await this.db
      .insert(schema.posDevices)
      .values({
        tenantId: record.tenantId,
        branchId: record.branchId,
        name: record.deviceName,
        tokenHash,
        status: 'active',
        pairedByMembershipId: record.createdByMembershipId,
        pairedAt: now,
        lastSeenAt: now,
      })
      .returning();

    const rosterJwk = (await this.tokenService.getPublicJwk()) as unknown as Record<string, unknown>;

    return {
      device_id: device.id,
      device_token: rawDeviceToken,
      branch: {
        id: branch.id,
        code: branch.code,
        name: branch.name,
      },
      roster_public_jwk: rosterJwk,
    };
  }

  // -------------------------------------------------------------
  // 3. List & Revoke Devices
  // -------------------------------------------------------------

  async listDevices(authPayload: AccessTokenPayload) {
    if (!authPayload.tid) {
      throw new ForbiddenException({
        error: 'TENANT_REQUIRED',
        message: 'Tenant context required',
      });
    }

    const tenant = await this.db.query.tenants.findFirst({
      where: eq(schema.tenants.code, authPayload.tid),
    });
    if (!tenant) {
      throw new NotFoundException({ error: 'TENANT_NOT_FOUND', message: 'Tenant not found' });
    }

    const devices = await this.db
      .select({
        id: schema.posDevices.id,
        name: schema.posDevices.name,
        status: schema.posDevices.status,
        pairedAt: schema.posDevices.pairedAt,
        lastSeenAt: schema.posDevices.lastSeenAt,
        revokedAt: schema.posDevices.revokedAt,
        branchId: schema.posDevices.branchId,
        branchCode: schema.branches.code,
        branchName: schema.branches.name,
      })
      .from(schema.posDevices)
      .innerJoin(schema.branches, eq(schema.posDevices.branchId, schema.branches.id))
      .where(eq(schema.posDevices.tenantId, tenant.id));

    return devices;
  }

  async revokeDevice(authPayload: AccessTokenPayload, deviceId: string) {
    if (!authPayload.tid) {
      throw new ForbiddenException({
        error: 'TENANT_REQUIRED',
        message: 'Tenant context required',
      });
    }

    const tenant = await this.db.query.tenants.findFirst({
      where: eq(schema.tenants.code, authPayload.tid),
    });
    if (!tenant) {
      throw new NotFoundException({ error: 'TENANT_NOT_FOUND', message: 'Tenant not found' });
    }

    const device = await this.db.query.posDevices.findFirst({
      where: and(
        eq(schema.posDevices.id, deviceId),
        eq(schema.posDevices.tenantId, tenant.id),
      ),
    });

    if (!device) {
      throw new NotFoundException({ error: 'DEVICE_NOT_FOUND', message: 'Device not found' });
    }

    const now = new Date();

    // 1. Mark device revoked
    await this.db
      .update(schema.posDevices)
      .set({
        status: 'revoked',
        revokedAt: now,
      })
      .where(eq(schema.posDevices.id, device.id));

    // 2. Revoke all refresh tokens tied to this device
    await this.db
      .update(schema.refreshTokens)
      .set({ revokedAt: now })
      .where(eq(schema.refreshTokens.deviceId, device.id));

    // 3. Publish NATS event for immediate gateway cache eviction
    await this.natsService.publish('platform.devices.changed', {
      device_id: device.id,
      tenant_id: tenant.id,
      status: 'revoked',
    });

    // 4. Record audit log
    await this.db.insert(schema.adminAuditLog).values({
      actor: authPayload.sub,
      action: 'pos.device.revoke',
      targetType: 'pos_device',
      targetId: device.id,
      before: {
        status: device.status,
      },
      after: {
        status: 'revoked',
        device_name: device.name,
        branch_id: device.branchId,
        tenant_id: tenant.id,
      },
      note: `Revoked by membership ${authPayload.mid || 'none'}`,
    });

    return { revoked: true, device_id: device.id };
  }

  // -------------------------------------------------------------
  // 4. PIN Management
  // -------------------------------------------------------------

  async setMyPin(authPayload: AccessTokenPayload, pin?: string, password?: string) {
    if (!authPayload.mid) {
      throw new ForbiddenException({
        error: 'MEMBERSHIP_REQUIRED',
        message: 'Membership context required',
      });
    }

    // AMR must include 'pwd' (must not be PIN token)
    if (!authPayload.amr || !authPayload.amr.includes('pwd')) {
      throw new ForbiddenException({
        error: 'PASSWORD_LOGIN_REQUIRED',
        message: 'Must be logged in with password to set or update PIN',
      });
    }

    if (!pin || !password) {
      throw new BadRequestException({
        error: 'BAD_REQUEST',
        message: 'pin and password are required',
      });
    }

    // Verify account password
    const account = await this.db.query.accounts.findFirst({
      where: eq(schema.accounts.id, authPayload.sub),
    });
    if (!account || account.status !== 'active') {
      throw new UnauthorizedException({
        error: 'INVALID_CREDENTIALS',
        message: 'Invalid credentials',
      });
    }

    const passwordValid = await verifyPassword(account.passwordHash, password);
    if (!passwordValid) {
      throw new UnauthorizedException({
        error: 'INVALID_CREDENTIALS',
        message: 'Invalid password',
      });
    }

    // Check PIN complexity
    const complexity = validatePinComplexity(pin, account.phone);
    if (!complexity.valid) {
      throw new BadRequestException({
        error: 'WEAK_PIN',
        message: complexity.reason || 'PIN does not meet complexity requirements',
      });
    }

    // Hash PIN using argon2id with same params as password
    const pinHash = await argon2.hash(pin, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });

    await this.db
      .insert(schema.membershipPins)
      .values({
        membershipId: authPayload.mid,
        pinHash,
        failedAttempts: 0,
        lockedUntil: null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.membershipPins.membershipId,
        set: {
          pinHash,
          failedAttempts: 0,
          lockedUntil: null,
          updatedAt: new Date(),
        },
      });

    return { success: true };
  }

  async resetStaffPin(authPayload: AccessTokenPayload, targetMembershipId: string) {
    if (!authPayload.tid) {
      throw new ForbiddenException({
        error: 'TENANT_REQUIRED',
        message: 'Tenant context required',
      });
    }

    const tenant = await this.db.query.tenants.findFirst({
      where: eq(schema.tenants.code, authPayload.tid),
    });
    if (!tenant) {
      throw new NotFoundException({ error: 'TENANT_NOT_FOUND', message: 'Tenant not found' });
    }

    const targetMembership = await this.db.query.memberships.findFirst({
      where: and(
        eq(schema.memberships.id, targetMembershipId),
        eq(schema.memberships.tenantId, tenant.id),
      ),
    });

    if (!targetMembership) {
      throw new NotFoundException({
        error: 'MEMBERSHIP_NOT_FOUND',
        message: 'Staff membership not found in tenant',
      });
    }

    await this.db
      .delete(schema.membershipPins)
      .where(eq(schema.membershipPins.membershipId, targetMembershipId));

    return { reset: true, membership_id: targetMembershipId };
  }

  // -------------------------------------------------------------
  // 5. Device Authentication (Authorization: Device <token>)
  // -------------------------------------------------------------

  async authenticateDevice(deviceAuthHeader?: string) {
    if (!deviceAuthHeader || !deviceAuthHeader.startsWith('Device ')) {
      throw new UnauthorizedException({
        error: 'UNAUTHENTICATED_DEVICE',
        message: 'Missing or invalid Authorization: Device <token> header',
      });
    }

    const rawToken = deviceAuthHeader.substring(7).trim();
    const tokenHash = sha256(rawToken);

    const device = await this.db.query.posDevices.findFirst({
      where: eq(schema.posDevices.tokenHash, tokenHash),
    });

    if (!device || device.status !== 'active') {
      throw new UnauthorizedException({
        error: 'DEVICE_REVOKED',
        message: 'Device not found or revoked',
      });
    }

    const tenant = await this.db.query.tenants.findFirst({
      where: eq(schema.tenants.id, device.tenantId),
    });
    if (!tenant || tenant.status !== 'active') {
      throw new ForbiddenException({
        error: 'TENANT_DISABLED',
        message: 'Tenant is not active',
      });
    }

    const branch = await this.db.query.branches.findFirst({
      where: eq(schema.branches.id, device.branchId),
    });
    if (!branch || branch.status !== 'active') {
      throw new ForbiddenException({
        error: 'BRANCH_DISABLED',
        message: 'Branch is not active',
      });
    }

    return { device, tenant, branch };
  }

  // -------------------------------------------------------------
  // 6. Login with PIN
  // -------------------------------------------------------------

  async loginWithPin(
    deviceAuthHeader: string | undefined,
    membershipId: string | undefined,
    pin: string | undefined,
    meta?: { ip?: string; userAgent?: string },
  ): Promise<PosPinLoginResult> {
    const { device, tenant, branch } = await this.authenticateDevice(deviceAuthHeader);

    if (!membershipId || !pin) {
      await verifyPassword(this.dummyPinHash, '000000');
      throw new UnauthorizedException({
        error: 'INVALID_PIN',
        message: 'Invalid PIN or credentials',
      });
    }

    const now = new Date();

    // 1. Check membership
    const membership = await this.db.query.memberships.findFirst({
      where: and(
        eq(schema.memberships.id, membershipId),
        eq(schema.memberships.tenantId, tenant.id),
      ),
    });

    if (!membership || membership.status !== 'active') {
      await verifyPassword(this.dummyPinHash, pin);
      throw new UnauthorizedException({
        error: 'INVALID_PIN',
        message: 'Invalid PIN or credentials',
      });
    }

    // 2. Check branch scope: either empty array or includes branch.code
    if (membership.branchScope.length > 0 && !membership.branchScope.includes(branch.code)) {
      await verifyPassword(this.dummyPinHash, pin);
      throw new UnauthorizedException({
        error: 'INVALID_PIN',
        message: 'Invalid PIN or credentials',
      });
    }

    // 3. Check pos.session.open permission
    const { roles, perms } = await this.getMembershipRolesAndPerms(membership.id);
    if (!perms.includes('pos.session.open')) {
      await verifyPassword(this.dummyPinHash, pin);
      throw new UnauthorizedException({
        error: 'INVALID_PIN',
        message: 'Invalid PIN or credentials',
      });
    }

    // 4. Check PIN entry in membership_pins
    const pinRecord = await this.db.query.membershipPins.findFirst({
      where: eq(schema.membershipPins.membershipId, membership.id),
    });

    if (!pinRecord) {
      await verifyPassword(this.dummyPinHash, pin);
      throw new UnauthorizedException({
        error: 'INVALID_PIN',
        message: 'Invalid PIN or credentials',
      });
    }

    // Check lockout
    if (pinRecord.lockedUntil && pinRecord.lockedUntil > now) {
      await verifyPassword(this.dummyPinHash, pin);
      throw new UnauthorizedException({
        error: 'INVALID_PIN',
        message: 'Invalid PIN or credentials',
      });
    }

    // Reset lockout if lockout duration has passed
    if (pinRecord.lockedUntil && pinRecord.lockedUntil <= now) {
      await this.db
        .update(schema.membershipPins)
        .set({
          failedAttempts: 0,
          lockedUntil: null,
          updatedAt: now,
        })
        .where(eq(schema.membershipPins.membershipId, membership.id));
      pinRecord.failedAttempts = 0;
      pinRecord.lockedUntil = null;
    }

    // Verify PIN with argon2id
    const pinValid = await verifyPassword(pinRecord.pinHash, pin);
    if (!pinValid) {
      // Atomic increment failedAttempts and lock for 5 minutes if >= 5
      await this.db
        .update(schema.membershipPins)
        .set({
          failedAttempts: sql`${schema.membershipPins.failedAttempts} + 1`,
          updatedAt: now,
          lockedUntil: sql`CASE WHEN ${schema.membershipPins.failedAttempts} + 1 >= 5 THEN NOW() + INTERVAL '5 minutes' ELSE ${schema.membershipPins.lockedUntil} END`,
        })
        .where(eq(schema.membershipPins.membershipId, membership.id));

      throw new UnauthorizedException({
        error: 'INVALID_PIN',
        message: 'Invalid PIN or credentials',
      });
    }

    // Reset failed attempts on successful login
    if (pinRecord.failedAttempts > 0) {
      await this.db
        .update(schema.membershipPins)
        .set({
          failedAttempts: 0,
          lockedUntil: null,
          updatedAt: now,
        })
        .where(eq(schema.membershipPins.membershipId, membership.id));
    }

    // 5. Issue access token and device-bound refresh token
    const account = await this.db.query.accounts.findFirst({
      where: eq(schema.accounts.id, membership.accountId),
    });

    const accessPayload: AccessTokenPayload = {
      sub: membership.accountId,
      tid: tenant.code,
      mid: membership.id,
      did: device.id,
      bid: branch.id,
      roles,
      perms,
      amr: ['pin'],
      email: account?.email ?? undefined,
      phone: account?.phone ?? undefined,
    };

    const accessToken = await this.tokenService.signAccessToken(accessPayload);

    // Refresh token lives for up to 12 hours from PIN entry
    const rawRefreshToken = generateRandomToken(32);
    const refreshTokenHash = sha256(rawRefreshToken);
    const sessionExpiresAt = new Date(now.getTime() + 12 * 60 * 60 * 1000); // 12 hours max

    await this.db.insert(schema.refreshTokens).values({
      accountId: membership.accountId,
      membershipId: membership.id,
      deviceId: device.id,
      tokenHash: refreshTokenHash,
      sessionStartedAt: now,
      expiresAt: sessionExpiresAt,
      ip: meta?.ip,
      userAgent: meta?.userAgent,
    });

    // Update last_seen_at for device
    await this.db
      .update(schema.posDevices)
      .set({ lastSeenAt: now })
      .where(eq(schema.posDevices.id, device.id));

    return {
      access_token: accessToken,
      refresh_token: rawRefreshToken,
      token_type: 'Bearer',
      expires_in: 900,
    };
  }

  // -------------------------------------------------------------
  // 7. Refresh PIN Session
  // -------------------------------------------------------------

  async refreshPinSession(
    deviceAuthHeader: string | undefined,
    rawRefreshToken: string | undefined,
    meta?: { ip?: string; userAgent?: string },
  ): Promise<PosPinLoginResult> {
    const { device, tenant, branch } = await this.authenticateDevice(deviceAuthHeader);

    if (!rawRefreshToken) {
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

    // Must be bound to this device
    if (tokenRecord.deviceId !== device.id) {
      throw new UnauthorizedException({
        error: 'DEVICE_MISMATCH',
        message: 'Refresh token does not belong to this device',
      });
    }

    // Reuse detection
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

    // Check expiration (max 12h from session start)
    const now = new Date();
    if (tokenRecord.expiresAt < now) {
      throw new UnauthorizedException({
        error: 'REFRESH_TOKEN_EXPIRED',
        message: 'PIN session expired after 12 hours. Please re-enter PIN.',
      });
    }

    const membership = await this.db.query.memberships.findFirst({
      where: eq(schema.memberships.id, tokenRecord.membershipId!),
    });
    if (!membership || membership.status !== 'active') {
      throw new ForbiddenException({
        error: 'MEMBERSHIP_DISABLED',
        message: 'Membership is disabled',
      });
    }

    const { roles, perms } = await this.getMembershipRolesAndPerms(membership.id);
    if (!perms.includes('pos.session.open')) {
      throw new ForbiddenException({
        error: 'PERMISSION_REVOKED',
        message: 'Permission pos.session.open has been revoked',
      });
    }

    const account = await this.db.query.accounts.findFirst({
      where: eq(schema.accounts.id, membership.accountId),
    });

    const accessPayload: AccessTokenPayload = {
      sub: membership.accountId,
      tid: tenant.code,
      mid: membership.id,
      did: device.id,
      bid: branch.id,
      roles,
      perms,
      amr: ['pin'],
      email: account?.email ?? undefined,
      phone: account?.phone ?? undefined,
    };

    const newAccessToken = await this.tokenService.signAccessToken(accessPayload);

    // Rotate refresh token
    const newRawRefreshToken = generateRandomToken(32);
    const newTokenHash = sha256(newRawRefreshToken);

    let reuseDetected = false;
    try {
      await this.db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(schema.refreshTokens)
          .values({
            accountId: membership.accountId,
            membershipId: membership.id,
            deviceId: device.id,
            familyId: tokenRecord.familyId,
            tokenHash: newTokenHash,
            sessionStartedAt: tokenRecord.sessionStartedAt,
            expiresAt: tokenRecord.expiresAt, // preserve original 12h expiration
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
          reuseDetected = true;
          throw new Error('CONCURRENT_ROTATION_ABORT');
        }
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (reuseDetected || errMsg === 'CONCURRENT_ROTATION_ABORT') {
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

  // -------------------------------------------------------------
  // 8. Roster for Offline POS Mode
  // -------------------------------------------------------------

  async getRoster(deviceAuthHeader: string | undefined): Promise<{
    roster: string;
    roster_jws: string;
    roster_public_jwk: Record<string, unknown>;
  }> {
    const { device, tenant, branch } = await this.authenticateDevice(deviceAuthHeader);

    // Find all active memberships in this tenant
    const memberships = await this.db.query.memberships.findMany({
      where: and(
        eq(schema.memberships.tenantId, tenant.id),
        eq(schema.memberships.status, 'active'),
      ),
    });

    const staffList: Array<{
      membership_id: string;
      display_name: string;
      perms: string[];
      pin_hash: string;
    }> = [];

    for (const m of memberships) {
      // Must match branch scope
      if (m.branchScope.length > 0 && !m.branchScope.includes(branch.code)) {
        continue;
      }

      // Must have pos.session.open permission
      const { perms } = await this.getMembershipRolesAndPerms(m.id);
      if (!perms.includes('pos.session.open')) {
        continue;
      }

      // Must have a PIN set
      const pinRecord = await this.db.query.membershipPins.findFirst({
        where: eq(schema.membershipPins.membershipId, m.id),
      });
      if (!pinRecord) {
        continue;
      }

      // Display name from account
      const account = await this.db.query.accounts.findFirst({
        where: eq(schema.accounts.id, m.accountId),
      });

      const displayName = account?.email || account?.phone || `Staff ${m.id.slice(0, 8)}`;

      staffList.push({
        membership_id: m.id,
        display_name: displayName,
        perms,
        pin_hash: pinRecord.pinHash,
      });
    }

    // Sign roster as JWS with 24h expiration
    const rosterPayload = {
      tid: tenant.code,
      bid: branch.id,
      did: device.id,
      staff: staffList,
      members: staffList,
    };

    const rosterJws = await this.tokenService.signRosterJws(rosterPayload);

    // Update last_seen_at for device
    await this.db
      .update(schema.posDevices)
      .set({ lastSeenAt: new Date() })
      .where(eq(schema.posDevices.id, device.id));

    const publicJwk = (await this.tokenService.getPublicJwk()) as unknown as Record<string, unknown>;

    return {
      roster: rosterJws,
      roster_jws: rosterJws,
      roster_public_jwk: publicJwk,
    };
  }

  // Helper
  private async getMembershipRolesAndPerms(membershipId: string): Promise<{ roles: string[]; perms: string[] }> {
    const roleLinks = await this.db
      .select({ roleId: schema.membershipRoles.roleId })
      .from(schema.membershipRoles)
      .where(eq(schema.membershipRoles.membershipId, membershipId));

    if (roleLinks.length === 0) {
      return { roles: [], perms: [] };
    }

    const roleIds = roleLinks.map((r) => r.roleId);
    const roleRows = await this.db.query.roles.findMany({
      where: inArray(schema.roles.id, roleIds),
    });

    const roles = roleRows.map((r) => r.name);
    const permLinks = await this.db
      .select({ permKey: schema.rolePermissions.permissionKey })
      .from(schema.rolePermissions)
      .where(inArray(schema.rolePermissions.roleId, roleIds));

    const perms = Array.from(new Set(permLinks.map((p) => p.permKey)));
    return { roles, perms };
  }
}
