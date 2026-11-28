import { Controller, Get, INestApplication, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import * as crypto from 'crypto';
import * as jose from 'jose';
import { AppModule } from '../src/app.module';
import { GatewayNatsListener } from '../src/features/gateway-nats.listener';
import { OdooCredentialService } from '../src/odoo/odoo-credential.service';
import { DeviceVerificationService } from '../src/auth/device-verification.service';
import { PlatformService } from '../src/features/platform.service';
import { HealthService } from '../src/health/health.service';
import { OdooService } from '../src/odoo/odoo.service';
import { JwtVerifierService } from '../src/auth/jwt-verifier.service';
import { RequireFeature } from '../src/features/require-feature.decorator';
import { Public } from '../src/auth/public.decorator';

// Test controller missing @RequireFeature
@Controller('v1/test-no-feature')
class TestNoFeatureController {
  @Get()
  @Public()
  getTest(): { status: string } {
    return { status: 'ok' };
  }
}

// Test controller missing @RequirePermission / @Public()
@Controller('v1/test-no-permission')
class TestNoPermissionController {
  @Get()
  @RequireFeature('system.features')
  getTest(): { status: string } {
    return { status: 'ok' };
  }
}

describe('Gateway endpoints (TASK-003)', () => {
  let app: INestApplication;
  let healthService: HealthService;
  let odooService: OdooService;
  let platformService: PlatformService;
  let jwtVerifier: JwtVerifierService;

  // Test Ed25519 keypair
  let testPrivateKey: jose.KeyLike;
  let testPublicKey: jose.KeyLike;
  let otherPrivateKey: jose.KeyLike;
  const testKid = 'iteso-ed25519-key-1';

  beforeAll(async () => {
    process.env.INTERNAL_API_TOKEN =
      process.env.INTERNAL_API_TOKEN ||
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    // Generate valid test keypair
    const pair = crypto.generateKeyPairSync('ed25519');
    testPrivateKey = await jose.importPKCS8(
      pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      'EdDSA',
    );
    testPublicKey = await jose.importSPKI(
      pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      'EdDSA',
    );

    // Generate untrusted keypair
    const otherPair = crypto.generateKeyPairSync('ed25519');
    otherPrivateKey = await jose.importPKCS8(
      otherPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      'EdDSA',
    );
  });

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [TestNoFeatureController, TestNoPermissionController],
    })
      .overrideProvider(GatewayNatsListener)
      .useValue({
        onModuleInit: jest.fn(),
        onModuleDestroy: jest.fn(),
      })
      .overrideProvider(OdooCredentialService)
      .useValue({
        onModuleInit: jest.fn(),
        onModuleDestroy: jest.fn(),
        getMemberCredential: jest.fn(),
        evictCache: jest.fn(),
      })
      .overrideProvider(DeviceVerificationService)
      .useValue({
        onModuleInit: jest.fn(),
        onModuleDestroy: jest.fn(),
        verifyDeviceActive: jest.fn().mockResolvedValue({
          id: 'dev-1',
          tenantId: '11111111-1111-1111-1111-111111111111',
          branchId: 'b-1',
          status: 'active',
        }),
        evictCache: jest.fn(),
        clearCache: jest.fn(),
      })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    healthService = moduleRef.get(HealthService);
    odooService = moduleRef.get(OdooService);
    platformService = moduleRef.get(PlatformService);
    jwtVerifier = moduleRef.get(JwtVerifierService);

    jwtVerifier.setPublicKey(testPublicKey);
    jest.spyOn(platformService, 'getActiveTenant').mockResolvedValue({
      id: '11111111-1111-1111-1111-111111111111',
      code: 'demo_fnb',
      dbName: 't_demo_fnb',
      displayName: 'Demo FnB',
      status: 'active',
      industries: ['fnb'],
    });
  });

  afterEach(async () => {
    await app.close();
  });

  async function createToken(
    payload: Record<string, unknown>,
    options?: { key?: jose.KeyLike; kid?: string; exp?: string },
  ): Promise<string> {
    const signingKey = options?.key ?? testPrivateKey;
    const kid = options?.kid ?? testKid;
    const exp = options?.exp ?? '15m';

    const jwt = new jose.SignJWT({
      typ: 'access',
      ...payload,
    })
      .setProtectedHeader({ alg: 'EdDSA', kid })
      .setIssuer('iteso-control-plane')
      .setAudience('iteso-api')
      .setIssuedAt();

    if (exp === '0s') {
      jwt.setExpirationTime(Math.floor(Date.now() / 1000) - 10);
    } else {
      jwt.setExpirationTime(exp);
    }

    return jwt.sign(signingKey);
  }

  describe('GET /health', () => {
    it('returns 200 and ok for all 5 components without needing token or @RequireFeature', async () => {
      jest.spyOn(healthService, 'checkPostgres').mockResolvedValue({ status: 'ok' });
      jest.spyOn(healthService, 'checkOdoo').mockResolvedValue({ status: 'ok' });
      jest.spyOn(healthService, 'checkNats').mockResolvedValue({ status: 'ok' });
      jest.spyOn(healthService, 'checkRedis').mockResolvedValue({ status: 'ok' });

      const res = await request(app.getHttpServer()).get('/health').expect(200);

      expect(res.body.status).toBe('ok');
      expect(res.body.components.gateway).toEqual({ status: 'ok' });
    });
  });

  describe('AuthGuard & Token Verification on /v1', () => {
    it('returns 401 UNAUTHENTICATED when Authorization header is missing', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/odoo/version')
        .expect(401);

      expect(res.body.error).toBe('UNAUTHENTICATED');
    });

    it('returns 401 UNAUTHENTICATED when token is expired', async () => {
      const expiredToken = await createToken(
        { sub: 'user-1', tid: 'demo_fnb', mid: 'mem-1', perms: ['system.diagnostics.view'] },
        { exp: '0s' },
      );

      const res = await request(app.getHttpServer())
        .get('/v1/odoo/version')
        .set('Authorization', `Bearer ${expiredToken}`)
        .expect(401);

      expect(res.body.error).toBe('UNAUTHENTICATED');
    });

    it('returns 401 UNAUTHENTICATED when token is signed with a different key', async () => {
      const untrustedToken = await createToken(
        { sub: 'user-1', tid: 'demo_fnb', mid: 'mem-1', perms: ['system.diagnostics.view'] },
        { key: otherPrivateKey },
      );

      const res = await request(app.getHttpServer())
        .get('/v1/odoo/version')
        .set('Authorization', `Bearer ${untrustedToken}`)
        .expect(401);

      expect(res.body.error).toBe('UNAUTHENTICATED');
    });

    it('returns 401 UNAUTHENTICATED when token kid does not match', async () => {
      const wrongKidToken = await createToken(
        { sub: 'user-1', tid: 'demo_fnb', mid: 'mem-1', perms: ['system.diagnostics.view'] },
        { kid: 'wrong-key-id' },
      );

      const res = await request(app.getHttpServer())
        .get('/v1/odoo/version')
        .set('Authorization', `Bearer ${wrongKidToken}`)
        .expect(401);

      expect(res.body.error).toBe('UNAUTHENTICATED');
    });

    it('returns 401 UNAUTHENTICATED when challenge token is used as Bearer token', async () => {
      const challengeToken = await new jose.SignJWT({ sub: 'user-1', typ: 'challenge' })
        .setProtectedHeader({ alg: 'EdDSA', kid: testKid })
        .setIssuer('iteso-control-plane')
        .setAudience('iteso-api')
        .setExpirationTime('5m')
        .sign(testPrivateKey);

      const res = await request(app.getHttpServer())
        .get('/v1/odoo/version')
        .set('Authorization', `Bearer ${challengeToken}`)
        .expect(401);

      expect(res.body.error).toBe('UNAUTHENTICATED');
    });

    it('returns 403 PLATFORM_TOKEN_NOT_ALLOWED when Platform Admin token without tenant context is used', async () => {
      const platformAdminToken = await createToken({
        sub: 'admin-1',
        is_platform_admin: true,
        perms: ['*'],
      });

      const res = await request(app.getHttpServer())
        .get('/v1/odoo/version')
        .set('Authorization', `Bearer ${platformAdminToken}`)
        .expect(403);

      expect(res.body.error).toBe('PLATFORM_TOKEN_NOT_ALLOWED');
    });

    it('returns 403 PERMISSION_DENIED when user lacks required permission (e.g. cashier calling diagnostics)', async () => {
      const cashierToken = await createToken({
        sub: 'cashier-1',
        tid: 'demo_fnb',
        mid: 'mem-1',
        roles: ['Thu ngân'],
        perms: ['pos.order.create', 'pos.discount.apply', 'system.features.read'], // Missing system.diagnostics.view
      });

      const res = await request(app.getHttpServer())
        .get('/v1/odoo/version')
        .set('Authorization', `Bearer ${cashierToken}`)
        .expect(403);

      expect(res.body.error).toBe('PERMISSION_DENIED');
      expect(res.body.permission).toBe('system.diagnostics.view');
    });

    it('returns 403 TENANT_MISMATCH when X-Tenant header differs from tid in token', async () => {
      const ownerToken = await createToken({
        sub: 'owner-1',
        tid: 'demo_fnb',
        mid: 'mem-1',
        roles: ['Chủ'],
        perms: ['system.diagnostics.view'],
      });

      const res = await request(app.getHttpServer())
        .get('/v1/odoo/version')
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('X-Tenant', 'demo_fnb2') // Mismatch!
        .expect(403);

      expect(res.body.error).toBe('TENANT_MISMATCH');
      expect(res.body.message).toContain('does not match token tenant');
    });

    it('returns 403 PERMISSION_UNDECLARED when endpoint lacks @RequirePermission and @Public', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/test-no-permission')
        .expect(403);

      expect(res.body.error).toBe('PERMISSION_UNDECLARED');
    });

    it('returns 403 FEATURE_UNDECLARED when endpoint lacks @RequireFeature', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/test-no-feature')
        .expect(403);

      expect(res.body.error).toBe('FEATURE_UNDECLARED');
    });

    it('returns 200 when user has valid token, correct permission, and feature is enabled', async () => {
      const ownerToken = await createToken({
        sub: 'owner-1',
        tid: 'demo_fnb',
        mid: 'mem-1',
        roles: ['Chủ'],
        perms: ['system.diagnostics.view', 'system.features.read'],
      });

      jest.spyOn(platformService, 'isFeatureEnabled').mockResolvedValue(true);
      jest.spyOn(odooService, 'getVersionForTenant').mockResolvedValue({
        tenant: 'demo_fnb',
        database: 't_demo_fnb',
        api: 'json-2',
        version: '20.0',
        version_info: [20, 0, 0, 'final', 0, ''],
        base_module_version: '20.0.1.0',
      });

      const res = await request(app.getHttpServer())
        .get('/v1/odoo/version')
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);

      expect(res.body.tenant).toBe('demo_fnb');
    });

    it('returns 403 TENANT_MISMATCH when device tenant does not match token tenant (TASK-005 Round 2: Point 5)', async () => {
      const deviceVerifier = app.get(DeviceVerificationService);
      jest.spyOn(deviceVerifier, 'verifyDeviceActive').mockResolvedValueOnce({
        id: 'dev-other-tenant',
        tenantId: 'other-tenant-uuid', // Differs from demo_fnb tenant id '11111111-1111-1111-1111-111111111111'
        branchId: 'b-1',
        status: 'active',
        cachedAt: Date.now(),
      });

      const pinToken = await createToken({
        sub: 'cashier-1',
        tid: 'demo_fnb',
        mid: 'mem-1',
        did: 'dev-other-tenant',
        roles: ['Chủ'],
        perms: ['system.diagnostics.view'],
      });

      const res = await request(app.getHttpServer())
        .get('/v1/odoo/version')
        .set('Authorization', `Bearer ${pinToken}`)
        .expect(403);

      expect(res.body.error).toBe('TENANT_MISMATCH');
      expect(res.body.message).toContain('Device does not belong to token tenant');
    });

    it('returns 403 BRANCH_MISMATCH when token bid does not match device branch', async () => {
      const deviceVerifier = app.get(DeviceVerificationService);
      jest.spyOn(deviceVerifier, 'verifyDeviceActive').mockResolvedValueOnce({
        id: 'dev-1',
        tenantId: '11111111-1111-1111-1111-111111111111',
        branchId: 'branch-correct',
        status: 'active',
        cachedAt: Date.now(),
      });

      const pinToken = await createToken({
        sub: 'cashier-1',
        tid: 'demo_fnb',
        mid: 'mem-1',
        did: 'dev-1',
        bid: 'branch-wrong', // Mismatch!
        roles: ['Chủ'],
        perms: ['system.diagnostics.view'],
      });

      const res = await request(app.getHttpServer())
        .get('/v1/odoo/version')
        .set('Authorization', `Bearer ${pinToken}`)
        .expect(403);

      expect(res.body.error).toBe('BRANCH_MISMATCH');
    });

    it('returns 401 DEVICE_REVOKED when device is revoked in pos_devices', async () => {
      const deviceVerifier = app.get(DeviceVerificationService);
      jest.spyOn(deviceVerifier, 'verifyDeviceActive').mockRejectedValueOnce(
        new UnauthorizedException({ error: 'DEVICE_REVOKED', message: 'Device revoked' }),
      );

      const pinToken = await createToken({
        sub: 'cashier-1',
        tid: 'demo_fnb',
        mid: 'mem-1',
        did: 'dev-revoked',
        roles: ['Chủ'],
        perms: ['system.diagnostics.view'],
      });

      const res = await request(app.getHttpServer())
        .get('/v1/odoo/version')
        .set('Authorization', `Bearer ${pinToken}`)
        .expect(401);

      expect(res.body.error).toBe('DEVICE_REVOKED');
    });
  });

  describe('Feature Flag Evaluation Matrix (Real SQL simulation via mock Pool)', () => {
    const validTenant = {
      id: '11111111-1111-1111-1111-111111111111',
      code: 'demo_fnb',
      dbName: 't_demo_fnb',
      displayName: 'Demo FnB',
      status: 'active' as const,
      industries: ['fnb'],
    };

    let querySpy: jest.SpyInstance;

    beforeEach(() => {
      jest.spyOn(platformService, 'getActiveTenant').mockResolvedValue(validTenant);
      querySpy = jest.spyOn((platformService as unknown as { pgPool: { query: jest.Mock } }).pgPool, 'query');
      platformService.clearCache();
    });

    it('case 1: feature is platform_enabled = false -> returns false', async () => {
      querySpy.mockResolvedValueOnce({
        rows: [
          {
            key: 'system.odoo_version',
            implementationStatus: 'available',
            platformEnabled: false,
            defaultEnabled: true,
            tenantEnabled: true,
          },
        ],
      });

      const enabled = await platformService.isFeatureEnabled('demo_fnb', 'system.odoo_version');
      expect(enabled).toBe(false);
    });

    it('case 2: tenant override = false -> returns false', async () => {
      querySpy.mockResolvedValueOnce({
        rows: [
          {
            key: 'system.odoo_version',
            implementationStatus: 'available',
            platformEnabled: true,
            defaultEnabled: true,
            tenantEnabled: false,
          },
        ],
      });

      const enabled = await platformService.isFeatureEnabled('demo_fnb', 'system.odoo_version');
      expect(enabled).toBe(false);
    });

    it('case 3: no tenant row, default_enabled = true -> returns true', async () => {
      querySpy.mockResolvedValueOnce({
        rows: [
          {
            key: 'system.odoo_version',
            implementationStatus: 'available',
            platformEnabled: true,
            defaultEnabled: true,
            tenantEnabled: null,
          },
        ],
      });

      const enabled = await platformService.isFeatureEnabled('demo_fnb', 'system.odoo_version');
      expect(enabled).toBe(true);
    });

    it('case 4: no tenant row, default_enabled = false -> returns false', async () => {
      querySpy.mockResolvedValueOnce({
        rows: [
          {
            key: 'einvoice.viettel',
            implementationStatus: 'available',
            platformEnabled: true,
            defaultEnabled: false,
            tenantEnabled: null,
          },
        ],
      });

      const enabled = await platformService.isFeatureEnabled('demo_fnb', 'einvoice.viettel');
      expect(enabled).toBe(false);
    });

    it('case 5: implementation_status = not_implemented -> returns false', async () => {
      querySpy.mockResolvedValueOnce({
        rows: [
          {
            key: 'fnb.pos',
            implementationStatus: 'not_implemented',
            platformEnabled: true,
            defaultEnabled: true,
            tenantEnabled: true,
          },
        ],
      });

      const enabled = await platformService.isFeatureEnabled('demo_fnb', 'fnb.pos');
      expect(enabled).toBe(false);
    });

    it('case 6: feature key does not exist -> returns false', async () => {
      querySpy.mockResolvedValueOnce({ rows: [] });

      const enabled = await platformService.isFeatureEnabled('demo_fnb', 'non_existent_key');
      expect(enabled).toBe(false);
    });

    it('caching: does not query database again within 30 seconds', async () => {
      querySpy.mockResolvedValueOnce({
        rows: [
          {
            key: 'system.odoo_version',
            implementationStatus: 'available',
            platformEnabled: true,
            defaultEnabled: true,
            tenantEnabled: true,
          },
        ],
      });

      const first = await platformService.isFeatureEnabled('demo_fnb', 'system.odoo_version');
      expect(first).toBe(true);
      expect(querySpy).toHaveBeenCalledTimes(1);

      const second = await platformService.isFeatureEnabled('demo_fnb', 'system.odoo_version');
      expect(second).toBe(true);
      expect(querySpy).toHaveBeenCalledTimes(1);
    });

    it('caching: queries database again after clearCache (e.g. on NATS event)', async () => {
      querySpy
        .mockResolvedValueOnce({
          rows: [
            {
              key: 'system.odoo_version',
              implementationStatus: 'available',
              platformEnabled: true,
              defaultEnabled: true,
              tenantEnabled: true,
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              key: 'system.odoo_version',
              implementationStatus: 'available',
              platformEnabled: true,
              defaultEnabled: true,
              tenantEnabled: false,
            },
          ],
        });

      const first = await platformService.isFeatureEnabled('demo_fnb', 'system.odoo_version');
      expect(first).toBe(true);
      expect(querySpy).toHaveBeenCalledTimes(1);

      platformService.clearCache('demo_fnb', 'system.odoo_version');

      const second = await platformService.isFeatureEnabled('demo_fnb', 'system.odoo_version');
      expect(second).toBe(false);
      expect(querySpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('AuthProxyController client IP forwarding', () => {
    it('ignores client X-Forwarded-For and forwards socket remoteAddress to control-plane', async () => {
      jest.spyOn(platformService, 'isPlatformFeatureEnabled').mockResolvedValue(true);

      let forwardedHeaders: Headers | undefined;
      const originalFetch = global.fetch;

      global.fetch = jest.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (typeof url === 'string' && url.includes('/v1/auth/login')) {
          forwardedHeaders = new Headers(init?.headers as Record<string, string>);
          return Promise.resolve({
            status: 401,
            json: () => Promise.resolve({ error: 'INVALID_CREDENTIALS', message: 'Invalid credentials' }),
          } as unknown as Response);
        }
        return originalFetch(url, init);
      });

      try {
        await request(app.getHttpServer())
          .post('/v1/auth/login')
          .set('X-Forwarded-For', '1.2.3.4')
          .set('User-Agent', 'TestClient/1.0')
          .send({ email: 'user@test.local', password: 'password123' })
          .expect(401);

        expect(forwardedHeaders).toBeDefined();
        const headerIp = forwardedHeaders?.get('x-forwarded-for');
        // Must NOT be the spoofed IP '1.2.3.4'
        expect(headerIp).not.toBe('1.2.3.4');
      } finally {
        global.fetch = originalFetch;
      }
    });
  });
});
