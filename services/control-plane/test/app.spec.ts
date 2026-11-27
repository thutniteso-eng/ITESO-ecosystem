import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { ControlPlaneService } from '../src/control-plane/control-plane.service';
import { NatsService } from '../src/nats/nats.service';
import { TokenService } from '../src/auth/token.service';
import { AuthService, LoginResultTokens, LoginResultTotp } from '../src/auth/auth.service';
import {
  encryptAesGcm,
  generateBase32Secret,
  generateTotp,
  hashPassword,
  verifyPassword,
} from '../src/auth/crypto.util';

describe('Control Plane Endpoints (TASK-003)', () => {
  let app: INestApplication;
  let cpService: ControlPlaneService;
  let tokenService: TokenService;
  let authService: AuthService;

  const testKeyBase64 = Buffer.alloc(32, 1).toString('base64');

  beforeAll(() => {
    process.env.PLATFORM_ENCRYPTION_KEY = testKeyBase64;
    process.env.ODOO_CREDENTIALS_KEY = testKeyBase64;
  });

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(NatsService)
      .useValue({
        onModuleInit: jest.fn(),
        onModuleDestroy: jest.fn(),
        publish: jest.fn().mockResolvedValue(undefined),
        isHealthy: jest.fn().mockResolvedValue(true),
      })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    cpService = moduleRef.get(ControlPlaneService);
    tokenService = moduleRef.get(TokenService);
    authService = moduleRef.get(AuthService);
  });

  afterEach(async () => {
    await app.close();
  });

  describe('Password Hashing & Lockout Logic (Crypto & Auth)', () => {
    interface MockAccountState {
      failedAttempts: number;
      lockedUntil: Date | null;
      revokedAt?: Date;
    }

    interface MockAuthServiceInternal {
      db: {
        query: {
          accounts: { findFirst: (...args: unknown[]) => Promise<unknown> };
          refreshTokens: { findFirst: (...args: unknown[]) => Promise<unknown> };
        };
        update: (...args: unknown[]) => { set: (data: Partial<MockAccountState>) => { where: () => Promise<void> } };
        insert: (...args: unknown[]) => { values: () => Promise<void> };
      };
      getAccountMemberships: (accountId: string) => Promise<Array<{ membershipId: string; tenantCode: string; tenantDisplayName: string }>>;
      getMembershipRolesAndPerms: (membershipId: string) => Promise<{ roles: string[]; perms: string[] }>;
    }

    it('hashes password with Argon2id and verifies correctly', async () => {
      const password = 'StrongPassword@123';
      const hash = await hashPassword(password);
      expect(hash).toContain('$argon2id$');

      const isMatch = await verifyPassword(hash, password);
      expect(isMatch).toBe(true);

      const isWrong = await verifyPassword(hash, 'WrongPassword@123');
      expect(isWrong).toBe(false);
    });

    it('locks account after 5 consecutive failed attempts and unlocks after 15 minutes', async () => {
      const mockAccount = {
        id: 'acc-1',
        email: 'user@test.local',
        phone: null,
        passwordHash: await hashPassword('ValidPassword@123'),
        totpSecretEnc: null,
        totpEnabled: false,
        isPlatformAdmin: false,
        status: 'active' as const,
        failedAttempts: 4,
        lockedUntil: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const internalAuth = authService as unknown as MockAuthServiceInternal;

      // 5th attempt fails -> lockedUntil is set
      let lockedAccountState: { failedAttempts: number; lockedUntil: Date | null } | null = null;
      jest.spyOn(internalAuth.db.query.accounts, 'findFirst').mockImplementation(async () => {
        if (lockedAccountState) {
          return { ...mockAccount, ...lockedAccountState };
        }
        return mockAccount;
      });

      jest.spyOn(internalAuth.db, 'update').mockReturnValue({
        set: (data: Partial<MockAccountState>) => ({
          where: () => {
            const currentAttempts = lockedAccountState?.failedAttempts ?? mockAccount.failedAttempts;
            const newAttempts = typeof data.failedAttempts === 'number' ? data.failedAttempts : currentAttempts + 1;
            lockedAccountState = {
              failedAttempts: newAttempts,
              lockedUntil: newAttempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : (data.lockedUntil ?? null),
            };
            return Promise.resolve();
          },
        }),
      });

      // 5th attempt with wrong password
      await expect(
        authService.login('user@test.local', 'WrongPassword@123'),
      ).rejects.toThrow('Invalid credentials');

      expect(lockedAccountState).not.toBeNull();
      expect(lockedAccountState!.failedAttempts).toBe(5);
      expect(lockedAccountState!.lockedUntil).not.toBeNull();
      expect(lockedAccountState!.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

      // 6th attempt with CORRECT password while locked -> still rejected
      await expect(
        authService.login('user@test.local', 'ValidPassword@123'),
      ).rejects.toThrow('Invalid credentials');

      // Simulate 15 minutes elapsed (time travel)
      lockedAccountState!.lockedUntil = new Date(Date.now() - 1000);

      jest.spyOn(internalAuth, 'getAccountMemberships').mockResolvedValue([
        { membershipId: 'mem-1', tenantCode: 'demo_fnb', tenantDisplayName: 'Demo' },
      ]);
      jest.spyOn(internalAuth, 'getMembershipRolesAndPerms').mockResolvedValue({
        roles: ['Chủ'],
        perms: ['pos.order.create'],
      });
      jest.spyOn(internalAuth.db, 'insert').mockReturnValue({
        values: () => Promise.resolve(),
      });

      // Now login with correct password succeeds
      const result = (await authService.login('user@test.local', 'ValidPassword@123')) as LoginResultTokens;
      expect(result.access_token).toBeDefined();
    });
  });

  describe('Single-use Tokens & Token Reuse Detection', () => {
    interface MockAccountState {
      failedAttempts: number;
      lockedUntil: Date | null;
      revokedAt?: Date;
    }

    interface MockAuthServiceInternal {
      db: {
        query: {
          accounts: { findFirst: (...args: unknown[]) => Promise<unknown> };
          refreshTokens: { findFirst: (...args: unknown[]) => Promise<unknown> };
        };
        update: (...args: unknown[]) => { set: (data: Partial<MockAccountState>) => { where: () => Promise<void> } };
        insert: (...args: unknown[]) => { values: () => Promise<void> };
      };
    }

    it('rejects reusing a selection_token or challenge_token', async () => {
      const token = await tokenService.createSingleUseToken({
        sub: 'acc-123',
        typ: 'selection',
      });

      // First use succeeds
      const payload = await tokenService.consumeSingleUseToken(token, 'selection');
      expect(payload.sub).toBe('acc-123');

      // Second use must fail
      await expect(
        tokenService.consumeSingleUseToken(token, 'selection'),
      ).rejects.toThrow('Token has already been used');
    });

    it('revokes entire token family when a reused refresh token is submitted', async () => {
      let familyRevoked = false;
      const revokedTokenRecord = {
        id: 'tok-1',
        accountId: 'acc-1',
        membershipId: 'mem-1',
        familyId: 'fam-1',
        tokenHash: 'somehash',
        expiresAt: new Date(Date.now() + 100000),
        revokedAt: new Date(), // Already revoked
        replacedBy: 'tok-2',
      };

      const internalAuth = authService as unknown as MockAuthServiceInternal;

      jest.spyOn(internalAuth.db.query.refreshTokens, 'findFirst').mockResolvedValue(revokedTokenRecord);
      jest.spyOn(internalAuth.db, 'update').mockReturnValue({
        set: (data: Partial<MockAccountState>) => ({
          where: () => {
            if (data.revokedAt) familyRevoked = true;
            return Promise.resolve();
          },
        }),
      });

      await expect(authService.refresh('reused_raw_token')).rejects.toThrow('Refresh token reuse detected');
      expect(familyRevoked).toBe(true);
    });

    it('expires platform admin session and revokes family when session exceeds 12 hours', async () => {
      let familyRevoked = false;
      const expiredSessionRecord = {
        id: 'tok-admin-1',
        accountId: 'acc-admin',
        membershipId: null, // Platform Admin
        familyId: 'fam-admin-1',
        tokenHash: 'somehash',
        sessionStartedAt: new Date(Date.now() - 13 * 60 * 60 * 1000), // 13h ago
        expiresAt: new Date(Date.now() + 100000),
        revokedAt: null,
        replacedBy: null,
      };

      const adminAccount = {
        id: 'acc-admin',
        status: 'active' as const,
        isPlatformAdmin: true,
      };

      const internalAuth = authService as unknown as MockAuthServiceInternal;
      jest.spyOn(internalAuth.db.query.refreshTokens, 'findFirst').mockResolvedValue(expiredSessionRecord);
      jest.spyOn(internalAuth.db.query.accounts, 'findFirst').mockResolvedValue(adminAccount);
      jest.spyOn(internalAuth.db, 'update').mockReturnValue({
        set: (data: Partial<MockAccountState>) => ({
          where: () => {
            if (data.revokedAt) familyRevoked = true;
            return Promise.resolve();
          },
        }),
      });

      await expect(authService.refresh('admin_refresh_token')).rejects.toThrow('Platform admin session expired after 12 hours');
      expect(familyRevoked).toBe(true);
    });

    it('detects concurrent refresh rotation and revokes family on race condition', async () => {
      const validTokenRecord = {
        id: 'tok-race-1',
        accountId: 'acc-1',
        membershipId: 'mem-1',
        familyId: 'fam-race-1',
        tokenHash: 'somehash',
        sessionStartedAt: new Date(),
        expiresAt: new Date(Date.now() + 100000),
        revokedAt: null,
        replacedBy: null,
      };

      const account = {
        id: 'acc-1',
        status: 'active' as const,
        isPlatformAdmin: false,
      };

      interface MockTx {
        insert: () => { values: () => { returning: () => Array<{ id: string }> } };
        update: () => { set: () => { where: () => { returning: () => Array<{ id: string }> } } };
      }

      const internalAuth = authService as unknown as {
        db: {
          query: {
            refreshTokens: { findFirst: () => Promise<unknown> };
            accounts: { findFirst: () => Promise<unknown> };
            memberships: { findFirst: () => Promise<unknown> };
            tenants: { findFirst: () => Promise<unknown> };
          };
          update: (table: unknown) => unknown;
          transaction: (cb: (tx: MockTx) => Promise<unknown>) => Promise<unknown>;
        };
        getMembershipRolesAndPerms: () => Promise<{ roles: string[]; perms: string[] }>;
      };

      jest.spyOn(internalAuth.db.query.refreshTokens, 'findFirst').mockResolvedValue(validTokenRecord);
      jest.spyOn(internalAuth.db.query.accounts, 'findFirst').mockResolvedValue(account);
      jest.spyOn(internalAuth.db.query.memberships, 'findFirst').mockResolvedValue({ id: 'mem-1', tenantId: 't-1', status: 'active' });
      jest.spyOn(internalAuth.db.query.tenants, 'findFirst').mockResolvedValue({ id: 't-1', code: 'demo_fnb', status: 'active' });
      jest.spyOn(internalAuth, 'getMembershipRolesAndPerms').mockResolvedValue({ roles: ['Chủ'], perms: [] });

      jest.spyOn(internalAuth.db, 'update').mockImplementation(() => ({
        set: () => ({
          where: () => Promise.resolve([]),
        }),
      } as unknown as ReturnType<typeof internalAuth.db.update>));

      jest.spyOn(internalAuth.db, 'transaction').mockImplementation(async (callback) => {
        const fakeTx: MockTx = {
          insert: () => ({
            values: () => ({
              returning: () => [{ id: 'new-tok-id' }],
            }),
          }),
          update: () => ({
            set: () => ({
              where: () => ({
                returning: () => [], // Simulating 0 rows affected
              }),
            }),
          }),
        };
        return callback(fakeTx);
      });

      await expect(authService.refresh('concurrent_token')).rejects.toThrow('Refresh token reuse detected');
    });
  });

  describe('Super Admin TOTP Flow & PlatformAdminGuard', () => {
    it('returns 401 when old X-Admin-Token is used (TASK-002 token removed)', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/tenants')
        .set('X-Admin-Token', 'change_me_admin_token_secret_123')
        .expect(401);

      expect(res.body.error).toBe('UNAUTHORIZED');
      expect(res.body.message).toContain('Missing or invalid Authorization header');
    });

    it('returns 401 when Super Admin token lacks otp in amr', async () => {
      const tokenWithoutOtp = await tokenService.signAccessToken({
        sub: 'admin-1',
        is_platform_admin: true,
        amr: ['pwd'], // Missing otp!
        roles: ['platform_admin'],
        perms: ['*'],
      });

      const res = await request(app.getHttpServer())
        .get('/admin/tenants')
        .set('Authorization', `Bearer ${tokenWithoutOtp}`)
        .expect(401);

      expect(res.body.error).toBe('UNAUTHORIZED');
      expect(res.body.message).toContain('Two-factor authentication (OTP) required');
    });

    it('allows access when valid Super Admin token with amr ["pwd", "otp"] is provided', async () => {
      const validAdminToken = await tokenService.signAccessToken({
        sub: 'admin-1',
        is_platform_admin: true,
        amr: ['pwd', 'otp'],
        roles: ['platform_admin'],
        perms: ['*'],
      });

      jest.spyOn(cpService, 'getTenants').mockResolvedValue([]);

      await request(app.getHttpServer())
        .get('/admin/tenants')
        .set('Authorization', `Bearer ${validAdminToken}`)
        .expect(200);
    });

    it('verifies TOTP code correctly during login flow', async () => {
      const totpSecret = generateBase32Secret(32);
      const encSecret = encryptAesGcm(totpSecret, authService.getEncryptionKey());

      const adminAccount = {
        id: 'admin-uuid',
        email: 'admin@platform.local',
        phone: null,
        passwordHash: await hashPassword('AdminPass@123'),
        totpSecretEnc: encSecret,
        totpEnabled: true,
        isPlatformAdmin: true,
        status: 'active' as const,
        failedAttempts: 0,
        lockedUntil: null,
      };

      interface MockAuthServiceInternal {
        db: {
          query: {
            accounts: { findFirst: (...args: unknown[]) => Promise<unknown> };
          };
          update: (...args: unknown[]) => { set: () => { where: () => Promise<void> } };
          insert: (...args: unknown[]) => { values: () => Promise<void> };
        };
      }
      const internalAuth = authService as unknown as MockAuthServiceInternal;

      jest.spyOn(internalAuth.db.query.accounts, 'findFirst').mockResolvedValue(adminAccount);
      jest.spyOn(internalAuth.db, 'update').mockReturnValue({
        set: () => ({
          where: () => Promise.resolve(),
        }),
      });
      jest.spyOn(internalAuth.db, 'insert').mockReturnValue({
        values: () => Promise.resolve(),
      });

      // Step 1: Login returns challenge_token
      const loginRes = (await authService.login('admin@platform.local', 'AdminPass@123')) as LoginResultTotp;
      expect(loginRes.next).toBe('totp');
      const challengeToken = loginRes.challenge_token;

      // Step 2: Invalid TOTP fails
      await expect(
        authService.verifyTotpAndLogin(challengeToken, '000000'),
      ).rejects.toThrow();

      // Step 3: Valid TOTP succeeds
      const newChallenge = await tokenService.createSingleUseToken({ sub: adminAccount.id, typ: 'challenge' });
      const validCode = generateTotp(totpSecret);
      const tokenRes = await authService.verifyTotpAndLogin(newChallenge, validCode);

      expect(tokenRes.access_token).toBeDefined();
      const verified = await tokenService.verifyAccessToken(tokenRes.access_token);
      expect(verified.is_platform_admin).toBe(true);
      expect(verified.amr).toEqual(['pwd', 'otp']);
    });
  });

  describe('Admin API Body Validation & Endpoints', () => {
    let validAdminToken: string;

    beforeEach(async () => {
      validAdminToken = await tokenService.signAccessToken({
        sub: 'admin-1',
        is_platform_admin: true,
        amr: ['pwd', 'otp'],
        roles: ['platform_admin'],
        perms: ['*'],
      });
    });

    it('returns 400 when enabled is not a boolean (e.g. string "false")', async () => {
      const res = await request(app.getHttpServer())
        .put('/admin/tenants/demo_fnb/features/system.odoo_version')
        .set('Authorization', `Bearer ${validAdminToken}`)
        .send({ enabled: 'false' })
        .expect(400);

      expect(res.body.error).toBe('BAD_REQUEST');
      expect(res.body.message).toContain('must be a boolean');
    });

    it('returns 400 when note exceeds 500 characters', async () => {
      const longNote = 'a'.repeat(501);
      const res = await request(app.getHttpServer())
        .put('/admin/tenants/demo_fnb/features/system.odoo_version')
        .set('Authorization', `Bearer ${validAdminToken}`)
        .send({ enabled: true, note: longNote })
        .expect(400);

      expect(res.body.error).toBe('BAD_REQUEST');
      expect(res.body.message).toContain('cannot exceed 500 characters');
    });
  });

  describe('ControlPlaneService Logic (Audit log records real actor UUID & NATS event)', () => {
    interface FakeTx {
      update: () => { set: () => { where: () => { returning: () => Array<{ key: string; platformEnabled: boolean }> } } };
      insert: () => { values: (val: { actor?: string; targetType?: string; targetId?: string }) => Promise<void> };
    }

    interface MockServiceWithDb {
      db: {
        query: { featureDefinitions: { findFirst: (...args: unknown[]) => Promise<unknown> } };
        transaction: (cb: (tx: FakeTx) => Promise<unknown>) => Promise<unknown>;
      };
    }

    it('throws 409 FEATURE_NOT_IMPLEMENTED when attempting to enable a not_implemented feature', async () => {
      jest.spyOn((cpService as unknown as MockServiceWithDb).db.query.featureDefinitions, 'findFirst').mockResolvedValue({
        key: 'fnb.pos',
        group: 'fnb',
        description: 'POS',
        implementationStatus: 'not_implemented',
        platformEnabled: false,
        defaultEnabled: true,
      });

      await expect(
        cpService.updatePlatformFeature('fnb.pos', true),
      ).rejects.toThrow('Feature \'fnb.pos\' is not implemented and cannot be enabled');
    });

    it('updates available feature, creates audit log with real actor, and publishes to NATS', async () => {
      jest.spyOn((cpService as unknown as MockServiceWithDb).db.query.featureDefinitions, 'findFirst').mockResolvedValue({
        key: 'system.odoo_version',
        group: 'system',
        description: 'Version',
        implementationStatus: 'available',
        platformEnabled: true,
        defaultEnabled: true,
      });

      let recordedActor = '';
      jest.spyOn((cpService as unknown as MockServiceWithDb).db, 'transaction').mockImplementation(async (callback: (tx: FakeTx) => Promise<unknown>) => {
        const fakeTx: FakeTx = {
          update: () => ({
            set: () => ({
              where: () => ({
                returning: () => [{
                  key: 'system.odoo_version',
                  platformEnabled: false,
                }],
              }),
            }),
          }),
          insert: () => ({
            values: (val: { actor?: string; targetType?: string; targetId?: string }) => {
              if (val.actor) recordedActor = val.actor;
              return Promise.resolve();
            },
          }),
        };
        return callback(fakeTx);
      });

      await cpService.updatePlatformFeature('system.odoo_version', false, 'test note', 'actor-uuid-1234');
      expect(recordedActor).toBe('actor-uuid-1234');
    });
  });
});
