import { INestApplication, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { GatewayNatsListener } from '../src/features/gateway-nats.listener';
import { PlatformService } from '../src/features/platform.service';
import { HealthService } from '../src/health/health.service';
import { OdooService } from '../src/odoo/odoo.service';

describe('Gateway endpoints (TASK-002)', () => {
  let app: INestApplication;
  let healthService: HealthService;
  let odooService: OdooService;
  let platformService: PlatformService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(GatewayNatsListener)
      .useValue({
        onModuleInit: jest.fn(),
        onModuleDestroy: jest.fn(),
      })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    healthService = moduleRef.get(HealthService);
    odooService = moduleRef.get(OdooService);
    platformService = moduleRef.get(PlatformService);
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /health', () => {
    it('returns 200 and ok for all 5 components without needing @RequireFeature', async () => {
      jest.spyOn(healthService, 'checkPostgres').mockResolvedValue({ status: 'ok' });
      jest.spyOn(healthService, 'checkOdoo').mockResolvedValue({ status: 'ok' });
      jest.spyOn(healthService, 'checkNats').mockResolvedValue({ status: 'ok' });
      jest.spyOn(healthService, 'checkRedis').mockResolvedValue({ status: 'ok' });

      const res = await request(app.getHttpServer()).get('/health').expect(200);

      expect(res.body.status).toBe('ok');
      expect(res.body.components.gateway).toEqual({ status: 'ok' });
    });
  });

  describe('Feature Flag Evaluation Matrix', () => {
    const validTenant = {
      id: '11111111-1111-1111-1111-111111111111',
      code: 'demo_fnb',
      dbName: 't_demo_fnb',
      displayName: 'Demo FnB',
      status: 'active' as const,
      industries: ['fnb'],
    };

    it('allows access when feature is available, platform enabled, and enabled for tenant', async () => {
      jest.spyOn(platformService, 'getActiveTenant').mockResolvedValue(validTenant);
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
        .set('X-Tenant', 'demo_fnb')
        .expect(200);

      expect(res.body.tenant).toBe('demo_fnb');
    });

    it('returns 403 FEATURE_DISABLED when feature is disabled at platform level', async () => {
      jest.spyOn(platformService, 'getActiveTenant').mockResolvedValue(validTenant);
      jest.spyOn(platformService, 'isFeatureEnabled').mockResolvedValue(false);

      const res = await request(app.getHttpServer())
        .get('/v1/odoo/version')
        .set('X-Tenant', 'demo_fnb')
        .expect(403);

      expect(res.body).toEqual({
        error: 'FEATURE_DISABLED',
        feature: 'system.odoo_version',
      });
    });

    it('returns 403 FEATURE_DISABLED when feature is disabled for tenant', async () => {
      jest.spyOn(platformService, 'getActiveTenant').mockResolvedValue(validTenant);
      jest.spyOn(platformService, 'isFeatureEnabled').mockResolvedValue(false);

      const res = await request(app.getHttpServer())
        .get('/v1/odoo/version')
        .set('X-Tenant', 'demo_fnb')
        .expect(403);

      expect(res.body.error).toBe('FEATURE_DISABLED');
    });

    it('returns 403 FEATURE_DISABLED when feature is not_implemented', async () => {
      jest.spyOn(platformService, 'getActiveTenant').mockResolvedValue(validTenant);
      jest.spyOn(platformService, 'isFeatureEnabled').mockResolvedValue(false);

      const res = await request(app.getHttpServer())
        .get('/v1/odoo/version')
        .set('X-Tenant', 'demo_fnb')
        .expect(403);

      expect(res.body.error).toBe('FEATURE_DISABLED');
    });

    it('returns 404 TENANT_NOT_FOUND when tenant is suspended', async () => {
      jest.spyOn(platformService, 'getActiveTenant').mockRejectedValue(
        new NotFoundException({
          error: 'TENANT_NOT_FOUND',
          message: "Tenant 'demo_fnb' is suspended",
        }),
      );

      const res = await request(app.getHttpServer())
        .get('/v1/odoo/version')
        .set('X-Tenant', 'demo_fnb')
        .expect(404);

      expect(res.body.error).toBe('TENANT_NOT_FOUND');
    });

    it('returns 404 TENANT_NOT_FOUND when tenant does not exist or header is missing', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/odoo/version')
        .expect(404);

      expect(res.body.error).toBe('TENANT_NOT_FOUND');
    });

    it('returns 403 FEATURE_UNDECLARED when endpoint under /v1 does not declare @RequireFeature', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/test-undeclared')
        .set('X-Tenant', 'demo_fnb')
        .expect(403);

      expect(res.body.error).toBe('FEATURE_UNDECLARED');
    });

    it('clears cache when clearCache is called', () => {
      platformService.clearCache('demo_fnb', 'system.odoo_version');
      platformService.clearCache();
    });
  });

  describe('GET /v1/features', () => {
    it('returns enabled features list for tenant', async () => {
      jest.spyOn(platformService, 'getActiveTenant').mockResolvedValue({
        id: '11111111-1111-1111-1111-111111111111',
        code: 'demo_fnb',
        dbName: 't_demo_fnb',
        displayName: 'Demo FnB',
        status: 'active',
        industries: ['fnb'],
      });
      jest.spyOn(platformService, 'isFeatureEnabled').mockResolvedValue(true);
      jest.spyOn(platformService, 'getEnabledFeaturesForTenant').mockResolvedValue([
        'system.odoo_version',
        'system.features',
      ]);

      const res = await request(app.getHttpServer())
        .get('/v1/features')
        .set('X-Tenant', 'demo_fnb')
        .expect(200);

      expect(res.body).toEqual({
        tenant: 'demo_fnb',
        features: ['system.odoo_version', 'system.features'],
      });
    });
  });
});
