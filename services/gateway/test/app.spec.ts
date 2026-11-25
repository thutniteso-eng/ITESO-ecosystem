import { Controller, Get, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { GatewayNatsListener } from '../src/features/gateway-nats.listener';
import { PlatformService } from '../src/features/platform.service';
import { HealthService } from '../src/health/health.service';
import { OdooService } from '../src/odoo/odoo.service';

@Controller('v1/test-undeclared')
class TestUndeclaredController {
  @Get()
  getTest(): { status: string } {
    return { status: 'ok' };
  }
}

describe('Gateway endpoints (TASK-002)', () => {
  let app: INestApplication;
  let healthService: HealthService;
  let odooService: OdooService;
  let platformService: PlatformService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [TestUndeclaredController], // Test 1: Only register in test suite!
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
      // Mock getActiveTenant to return valid active tenant
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
            key: 'hotel.pms',
            implementationStatus: 'available',
            platformEnabled: true,
            defaultEnabled: false,
            tenantEnabled: null,
          },
        ],
      });

      const enabled = await platformService.isFeatureEnabled('demo_fnb', 'hotel.pms');
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

      // Second call immediately - cache hit
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

      // Invalidate via NATS event simulation
      platformService.clearCache('demo_fnb', 'system.odoo_version');

      const second = await platformService.isFeatureEnabled('demo_fnb', 'system.odoo_version');
      expect(second).toBe(false);
      expect(querySpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('Route Guards and Controller responses', () => {
    it('returns 200 when feature is enabled', async () => {
      jest.spyOn(platformService, 'getActiveTenant').mockResolvedValue({
        id: '11111111-1111-1111-1111-111111111111',
        code: 'demo_fnb',
        dbName: 't_demo_fnb',
        displayName: 'Demo FnB',
        status: 'active',
        industries: ['fnb'],
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
        .set('X-Tenant', 'demo_fnb')
        .expect(200);

      expect(res.body.tenant).toBe('demo_fnb');
    });

    it('returns 403 FEATURE_DISABLED when feature is disabled', async () => {
      jest.spyOn(platformService, 'getActiveTenant').mockResolvedValue({
        id: '11111111-1111-1111-1111-111111111111',
        code: 'demo_fnb',
        dbName: 't_demo_fnb',
        displayName: 'Demo FnB',
        status: 'active',
        industries: ['fnb'],
      });
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

    it('returns 403 FEATURE_UNDECLARED when endpoint under /v1 does not declare @RequireFeature', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/test-undeclared')
        .set('X-Tenant', 'demo_fnb')
        .expect(403);

      expect(res.body.error).toBe('FEATURE_UNDECLARED');
    });

    it('GET /v1/features returns enabled features list for tenant', async () => {
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
