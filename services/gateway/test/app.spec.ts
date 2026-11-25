import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { HealthService } from '../src/health/health.service';
import { OdooService } from '../src/odoo/odoo.service';

describe('Gateway endpoints (TASK-001)', () => {
  let app: INestApplication;
  let healthService: HealthService;
  let odooService: OdooService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    healthService = moduleRef.get(HealthService);
    odooService = moduleRef.get(OdooService);
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /health', () => {
    it('returns 200 and ok for all 5 components when healthy', async () => {
      jest.spyOn(healthService, 'checkPostgres').mockResolvedValue({ status: 'ok' });
      jest.spyOn(healthService, 'checkOdoo').mockResolvedValue({ status: 'ok' });
      jest.spyOn(healthService, 'checkNats').mockResolvedValue({ status: 'ok' });
      jest.spyOn(healthService, 'checkRedis').mockResolvedValue({ status: 'ok' });

      const res = await request(app.getHttpServer()).get('/health').expect(200);

      expect(res.body).toEqual({
        status: 'ok',
        components: {
          gateway: { status: 'ok' },
          postgres: { status: 'ok' },
          odoo: { status: 'ok' },
          nats: { status: 'ok' },
          redis: { status: 'ok' },
        },
      });
    });

    it('returns 503 with reason when a dependency fails', async () => {
      jest.spyOn(healthService, 'checkPostgres').mockResolvedValue({ status: 'ok' });
      jest.spyOn(healthService, 'checkOdoo').mockResolvedValue({
        status: 'error',
        reason: 'connect ECONNREFUSED',
      });
      jest.spyOn(healthService, 'checkNats').mockResolvedValue({ status: 'ok' });
      jest.spyOn(healthService, 'checkRedis').mockResolvedValue({ status: 'ok' });

      const res = await request(app.getHttpServer()).get('/health').expect(503);

      expect(res.body.status).toBe('error');
      expect(res.body.components.gateway).toEqual({ status: 'ok' });
      expect(res.body.components.odoo).toEqual({
        status: 'error',
        reason: 'connect ECONNREFUSED',
      });
    });
  });

  describe('GET /v1/odoo/version', () => {
    it('returns Odoo 20 version for existing tenant demo_fnb via JSON-2 API', async () => {
      const existsSpy = jest
        .spyOn(odooService, 'tenantDatabaseExists')
        .mockResolvedValue(true);
      const json2Spy = jest.spyOn(odooService, 'callJson2').mockResolvedValue([
        {
          name: 'base',
          installed_version: '20.0.1.3',
          latest_version: '20.0.1.3',
          state: 'installed',
        },
      ]);
      jest.spyOn(odooService, 'fetchServerVersion').mockResolvedValue({
        version: '20.0-20261123',
        version_info: [20, 0, 0, 'final', 0, ''],
      });

      const res = await request(app.getHttpServer())
        .get('/v1/odoo/version')
        .set('X-Tenant', 'demo_fnb')
        .expect(200);

      expect(existsSpy).toHaveBeenCalledWith('t_demo_fnb');
      expect(json2Spy).toHaveBeenCalledWith(
        't_demo_fnb',
        'ir.module.module',
        'search_read',
        expect.objectContaining({
          domain: [['name', '=', 'base']],
          limit: 1,
        }),
      );
      expect(res.body).toEqual({
        tenant: 'demo_fnb',
        database: 't_demo_fnb',
        api: 'json-2',
        version: '20.0-20261123',
        version_info: [20, 0, 0, 'final', 0, ''],
        base_module_version: '20.0.1.3',
      });
    });

    it('returns 404 TENANT_NOT_FOUND for non-existent tenant', async () => {
      const existsSpy = jest
        .spyOn(odooService, 'tenantDatabaseExists')
        .mockResolvedValue(false);

      const res = await request(app.getHttpServer())
        .get('/v1/odoo/version')
        .set('X-Tenant', 'khong_ton_tai')
        .expect(404);

      expect(existsSpy).toHaveBeenCalledWith('t_khong_ton_tai');
      expect(res.body.error).toBe('TENANT_NOT_FOUND');
    });

    it('returns 404 TENANT_NOT_FOUND when X-Tenant header is missing or invalid', async () => {
      const resMissing = await request(app.getHttpServer())
        .get('/v1/odoo/version')
        .expect(404);
      expect(resMissing.body.error).toBe('TENANT_NOT_FOUND');

      const resInvalid = await request(app.getHttpServer())
        .get('/v1/odoo/version')
        .set('X-Tenant', '../bad-tenant')
        .expect(404);
      expect(resInvalid.body.error).toBe('TENANT_NOT_FOUND');
    });
  });
});
