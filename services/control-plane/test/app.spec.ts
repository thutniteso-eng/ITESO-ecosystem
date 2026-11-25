import { ConflictException, HttpStatus, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { ControlPlaneService } from '../src/control-plane/control-plane.service';
import { NatsService } from '../src/nats/nats.service';

describe('Control Plane Endpoints (TASK-002)', () => {
  let app: INestApplication;
  let cpService: ControlPlaneService;
  const adminToken = 'test_admin_token';

  beforeAll(() => {
    process.env.CONTROL_PLANE_ADMIN_TOKEN = adminToken;
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
  });

  afterEach(async () => {
    await app.close();
  });

  describe('Admin Auth Guard', () => {
    it('returns 401 when X-Admin-Token header is missing', async () => {
      const res = await request(app.getHttpServer()).get('/admin/tenants').expect(401);
      expect(res.body.error).toBe('UNAUTHORIZED');
    });

    it('returns 401 when X-Admin-Token header is invalid', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/tenants')
        .set('X-Admin-Token', 'wrong_token')
        .expect(401);
      expect(res.body.error).toBe('UNAUTHORIZED');
    });

    it('allows access when valid token is provided', async () => {
      jest.spyOn(cpService, 'getTenants').mockResolvedValue([]);
      await request(app.getHttpServer())
        .get('/admin/tenants')
        .set('X-Admin-Token', adminToken)
        .expect(200);
    });
  });

  describe('Feature Flag Management', () => {
    it('returns 409 when trying to enable a not_implemented feature on platform level', async () => {
      jest.spyOn(cpService, 'updatePlatformFeature').mockRejectedValue(
        new ConflictException({
          error: 'FEATURE_NOT_IMPLEMENTED',
          message: "Feature 'fnb.pos' is not implemented and cannot be enabled",
        }),
      );

      const res = await request(app.getHttpServer())
        .put('/admin/features/fnb.pos/platform')
        .set('X-Admin-Token', adminToken)
        .send({ enabled: true })
        .expect(409);

      expect(res.body.error).toBe('FEATURE_NOT_IMPLEMENTED');
    });

    it('returns 409 when trying to enable a not_implemented feature for a tenant', async () => {
      jest.spyOn(cpService, 'updateTenantFeature').mockRejectedValue(
        new ConflictException({
          error: 'FEATURE_NOT_IMPLEMENTED',
          message: "Feature 'fnb.pos' is not implemented and cannot be enabled",
        }),
      );

      const res = await request(app.getHttpServer())
        .put('/admin/tenants/demo_fnb/features/fnb.pos')
        .set('X-Admin-Token', adminToken)
        .send({ enabled: true })
        .expect(409);

      expect(res.body.error).toBe('FEATURE_NOT_IMPLEMENTED');
    });

    it('returns 200 and updates available feature', async () => {
      jest.spyOn(cpService, 'updateTenantFeature').mockResolvedValue({
        tenantId: 'uuid',
        featureKey: 'system.odoo_version',
        enabled: false,
        updatedBy: 'super_admin',
        updatedAt: new Date(),
        note: 'Disabled for test',
      });

      const res = await request(app.getHttpServer())
        .put('/admin/tenants/demo_fnb/features/system.odoo_version')
        .set('X-Admin-Token', adminToken)
        .send({ enabled: false, note: 'Disabled for test' })
        .expect(200);

      expect(res.body.enabled).toBe(false);
    });
  });

  describe('GET /health', () => {
    it('returns 200 when database and nats are healthy', async () => {
      jest.spyOn(cpService, 'checkHealth').mockResolvedValue({ database: true, nats: true });

      const res = await request(app.getHttpServer()).get('/health').expect(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.components.database.status).toBe('ok');
      expect(res.body.components.nats.status).toBe('ok');
    });
  });
});
