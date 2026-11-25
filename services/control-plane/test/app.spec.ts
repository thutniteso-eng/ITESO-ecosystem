import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { ControlPlaneService } from '../src/control-plane/control-plane.service';
import { NatsService } from '../src/nats/nats.service';

describe('Control Plane Endpoints (TASK-002)', () => {
  let app: INestApplication;
  let cpService: ControlPlaneService;
  let natsService: NatsService;
  const adminToken = 'test_admin_token_123';

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
    natsService = moduleRef.get(NatsService);
  });

  afterEach(async () => {
    await app.close();
  });

  describe('Admin Auth Guard (timingSafeEqual)', () => {
    it('returns 401 when X-Admin-Token header is missing', async () => {
      const res = await request(app.getHttpServer()).get('/admin/tenants').expect(401);
      expect(res.body.error).toBe('UNAUTHORIZED');
    });

    it('returns 401 when X-Admin-Token header is invalid or different length', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/tenants')
        .set('X-Admin-Token', 'wrong')
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

  describe('Admin API Body Validation (Fix 5)', () => {
    it('returns 400 when enabled is not a boolean (e.g. string "false")', async () => {
      const res = await request(app.getHttpServer())
        .put('/admin/tenants/demo_fnb/features/system.odoo_version')
        .set('X-Admin-Token', adminToken)
        .send({ enabled: 'false' })
        .expect(400);

      expect(res.body.error).toBe('BAD_REQUEST');
      expect(res.body.message).toContain('must be a boolean');
    });

    it('returns 400 when note exceeds 500 characters', async () => {
      const longNote = 'a'.repeat(501);
      const res = await request(app.getHttpServer())
        .put('/admin/tenants/demo_fnb/features/system.odoo_version')
        .set('X-Admin-Token', adminToken)
        .send({ enabled: true, note: longNote })
        .expect(400);

      expect(res.body.error).toBe('BAD_REQUEST');
      expect(res.body.message).toContain('cannot exceed 500 characters');
    });
  });

  describe('ControlPlaneService Logic (Fix 4: Real service behavior & NATS publishing)', () => {
    interface FakeTx {
      update: () => { set: () => { where: () => { returning: () => Array<{ key: string; platformEnabled: boolean }> } } };
      insert: () => { values: (val: { targetType?: string; targetId?: string }) => Promise<void> };
    }

    interface MockServiceWithDb {
      db: {
        query: { featureDefinitions: { findFirst: (...args: unknown[]) => Promise<unknown> } };
        transaction: (cb: (tx: FakeTx) => Promise<unknown>) => Promise<unknown>;
      };
    }

    it('throws 409 FEATURE_NOT_IMPLEMENTED when attempting to enable a not_implemented feature', async () => {
      // Mock db query to return a not_implemented feature
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

    it('updates available feature, creates audit log in transaction, and publishes to NATS', async () => {
      jest.spyOn((cpService as unknown as MockServiceWithDb).db.query.featureDefinitions, 'findFirst').mockResolvedValue({
        key: 'system.odoo_version',
        group: 'system',
        description: 'Version',
        implementationStatus: 'available',
        platformEnabled: true,
        defaultEnabled: true,
      });

      let auditLogged = false;
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
            values: (val: { targetType?: string; targetId?: string }) => {
              if (val.targetType === 'feature' && val.targetId === 'system.odoo_version') {
                auditLogged = true;
              }
              return Promise.resolve();
            },
          }),
        };
        return callback(fakeTx);
      });

      const updated = await cpService.updatePlatformFeature('system.odoo_version', false, 'Test update');
      expect(updated.platformEnabled).toBe(false);
      expect(auditLogged).toBe(true);

      // Verify NATS published after transaction commit
      expect(natsService.publish).toHaveBeenCalledWith('platform.features.changed', {
        tenant: null,
        key: 'system.odoo_version',
      });
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
