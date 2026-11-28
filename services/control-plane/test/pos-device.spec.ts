import { BadRequestException, ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import * as schema from '../src/db/schema';
import { PosDeviceService } from '../src/control-plane/pos-device.service';
import { TokenService } from '../src/auth/token.service';
import { NatsService } from '../src/nats/nats.service';
import { OdooProvisioningService } from '../src/control-plane/odoo-provisioning.service';
import { validatePinComplexity, verifyPassword } from '../src/auth/crypto.util';
import { InternalTokenGuard } from '../src/auth/internal-token.guard';

describe('TASK-005 & TASK-006: Control Plane PosDeviceService & PIN Unit Tests', () => {
  let service: PosDeviceService;
  let tokenService: TokenService;
  let natsService: NatsService;
  let odooProvisioningService: OdooProvisioningService;

  beforeEach(async () => {
    tokenService = {
      signAccessToken: jest.fn().mockResolvedValue('mock_access_token'),
      signRosterJws: jest.fn().mockResolvedValue('mock_roster_jws'),
      getPublicJwk: jest.fn().mockResolvedValue({ kty: 'OKP', crv: 'Ed25519', x: 'mock_jwk_x' }),
    } as unknown as TokenService;

    natsService = {
      publish: jest.fn().mockResolvedValue(undefined),
      isHealthy: jest.fn().mockResolvedValue(true),
    } as unknown as NatsService;

    odooProvisioningService = {
      provisionDeviceUser: jest.fn().mockResolvedValue({ apiKey: 'mock_api_key', odooUid: 123 }),
      disableDeviceUser: jest.fn().mockResolvedValue(undefined),
      getDeviceCredential: jest.fn().mockResolvedValue({ apiKey: 'mock_api_key', odooUid: 123 }),
    } as unknown as OdooProvisioningService;

    service = new PosDeviceService(tokenService, natsService, odooProvisioningService);
    await service.onModuleInit();
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  describe('PIN Complexity Validation', () => {
    it('accepts valid 6-digit non-trivial PIN', () => {
      const res = validatePinComplexity('852941', '+84900000001');
      expect(res.valid).toBe(true);
    });

    it('rejects PIN with non-digit characters or wrong length', () => {
      expect(validatePinComplexity('12345').valid).toBe(false);
      expect(validatePinComplexity('1234567').valid).toBe(false);
      expect(validatePinComplexity('12345a').valid).toBe(false);
    });

    it('rejects PIN with all identical digits', () => {
      expect(validatePinComplexity('111111').valid).toBe(false);
      expect(validatePinComplexity('999999').valid).toBe(false);
      expect(validatePinComplexity('000000').valid).toBe(false);
    });

    it('rejects sequentially increasing or decreasing digits', () => {
      expect(validatePinComplexity('123456').valid).toBe(false);
      expect(validatePinComplexity('234567').valid).toBe(false);
      expect(validatePinComplexity('654321').valid).toBe(false);
      expect(validatePinComplexity('987654').valid).toBe(false);
    });

    it('rejects PIN matching last 6 digits of account phone number', () => {
      expect(validatePinComplexity('123456', '+84900123456').valid).toBe(false);
      expect(validatePinComplexity('654321', '+84900123456').valid).toBe(false); // sequential
      expect(validatePinComplexity('852941', '+84900852941').valid).toBe(false); // matches last 6
    });
  });

  describe('Pairing Code Creation & Validation', () => {
    it('throws BadRequestException if branch_code or device_name is missing', async () => {
      await expect(
        service.createPairingCode({ sub: 'user-1', tid: 'demo_fnb' }, '', 'POS 1'),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.createPairingCode({ sub: 'user-1', tid: 'demo_fnb' }, 'main', ''),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws ForbiddenException if tenant context is missing', async () => {
      await expect(
        service.createPairingCode({ sub: 'user-1' }, 'main', 'POS 1'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws BRANCH_FORBIDDEN when branch is outside caller branchScope (TASK-005 Round 2: Point 4)', async () => {
      const dbMock = (service as unknown as { db: { query: Record<string, { findFirst: jest.Mock }> } }).db;
      jest.spyOn(dbMock.query.tenants, 'findFirst').mockResolvedValue({
        id: 't-1',
        code: 'demo_fnb',
        status: 'active',
      });
      jest.spyOn(dbMock.query.featureDefinitions, 'findFirst').mockResolvedValue({
        key: 'pos.devices',
        implementationStatus: 'available',
        platformEnabled: true,
        defaultEnabled: true,
      });
      jest.spyOn(dbMock.query.tenantFeatures, 'findFirst').mockResolvedValue(null);
      jest.spyOn(dbMock.query.branches, 'findFirst').mockResolvedValue({
        id: 'b-2',
        tenantId: 't-1',
        code: 'branch_b',
        name: 'Chi nhánh B',
        status: 'active',
      });
      // Caller has branchScope = ['branch_a']
      jest.spyOn(dbMock.query.memberships, 'findFirst').mockResolvedValue({
        id: 'm-1',
        tenantId: 't-1',
        status: 'active',
        branchScope: ['branch_a'],
      });

      await expect(
        service.createPairingCode({ sub: 'user-1', tid: 'demo_fnb', mid: 'm-1' }, 'branch_b', 'POS 2'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws FEATURE_DISABLED when pos.devices is disabled for tenant (TASK-005 Round 2: Point 1)', async () => {
      const dbMock = (service as unknown as { db: { query: Record<string, { findFirst: jest.Mock }> } }).db;
      jest.spyOn(dbMock.query.tenants, 'findFirst').mockResolvedValue({
        id: 't-1',
        code: 'demo_fnb',
        status: 'active',
      });
      jest.spyOn(dbMock.query.featureDefinitions, 'findFirst').mockResolvedValue({
        key: 'pos.devices',
        implementationStatus: 'available',
        platformEnabled: true,
        defaultEnabled: true,
      });
      // Tenant explicitly disabled pos.devices
      jest.spyOn(dbMock.query.tenantFeatures, 'findFirst').mockResolvedValue({
        tenantId: 't-1',
        featureKey: 'pos.devices',
        enabled: false,
      });

      await expect(
        service.createPairingCode({ sub: 'user-1', tid: 'demo_fnb', mid: 'm-1' }, 'main', 'POS 1'),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('Dummy Hash Validity (TASK-005 Round 2: Point 2)', () => {
    it('initializes dummyPinHash as a valid argon2id hash', async () => {
      const hash = service.getDummyPinHash();
      expect(hash).toMatch(/^\$argon2id\$v=19\$/);
      const valid = await verifyPassword(hash, 'timing-defense-dummy-pin-000000');
      expect(valid).toBe(true);
      const invalid = await verifyPassword(hash, 'wrong-pin');
      expect(invalid).toBe(false);
    });
  });

  describe('Inactive Account Handling (TASK-005 Round 2: Point 3)', () => {
    it('rejects PIN login with 401 INVALID_PIN when account status is not active', async () => {
      const dbMock = (service as unknown as { db: { query: Record<string, { findFirst: jest.Mock }> } }).db;
      jest.spyOn(service, 'authenticateDevice').mockResolvedValue({
        device: { id: 'd-1', tenantId: 't-1', branchId: 'b-1', status: 'active' } as unknown as typeof schema.posDevices.$inferSelect,
        tenant: { id: 't-1', code: 'demo_fnb', status: 'active' } as unknown as typeof schema.tenants.$inferSelect,
        branch: { id: 'b-1', code: 'main', status: 'active' } as unknown as typeof schema.branches.$inferSelect,
      });
      jest.spyOn(dbMock.query.memberships, 'findFirst').mockResolvedValue({
        id: 'm-1',
        tenantId: 't-1',
        accountId: 'acc-1',
        status: 'active',
        branchScope: [],
      });
      // Account is disabled
      jest.spyOn(dbMock.query.accounts, 'findFirst').mockResolvedValue({
        id: 'acc-1',
        status: 'disabled',
      });

      await expect(
        service.loginWithPin('Device mock_token', 'm-1', '123456'),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('PIN Setting and Password Requirement', () => {
    it('rejects setMyPin if AMR does not include pwd (e.g. called from PIN session)', async () => {
      await expect(
        service.setMyPin({ sub: 'user-1', mid: 'm-1', amr: ['pin'] }, '852941', 'Password@123'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects setMyPin if password is missing', async () => {
      await expect(
        service.setMyPin({ sub: 'user-1', mid: 'm-1', amr: ['pwd'] }, '852941', ''),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('Device Revocation', () => {
    it('publishes platform.devices.changed on NATS when device is revoked', async () => {
      const dbMock = (service as unknown as { db: { query: Record<string, { findFirst: jest.Mock }>; update: jest.Mock; insert: jest.Mock } }).db;
      jest.spyOn(dbMock.query.tenants, 'findFirst').mockResolvedValue({
        id: 't-1',
        code: 'demo_fnb',
        status: 'active',
      });
      jest.spyOn(dbMock.query.posDevices, 'findFirst').mockResolvedValue({
        id: 'd-1',
        tenantId: 't-1',
        branchId: 'b-1',
        name: 'POS Main',
        status: 'active',
      });
      jest.spyOn(dbMock, 'update').mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([]),
        }),
      });
      jest.spyOn(dbMock, 'insert').mockReturnValue({
        values: jest.fn().mockResolvedValue([]),
      });

      const res = await service.revokeDevice({ sub: 'user-1', tid: 'demo_fnb', mid: 'm-1' }, 'd-1');
      expect(res.revoked).toBe(true);
      expect(natsService.publish).toHaveBeenCalledWith('platform.devices.changed', {
        device_id: 'd-1',
        tenant_id: 't-1',
        status: 'revoked',
      });
    });
  });

  describe('Allocate Number Blocks Concurrency (TASK-006 Round 2: Point 4)', () => {
    it('allocates 10 concurrent blocks of 1,000 numbers without overlaps or gaps', async () => {
      jest.spyOn(service, 'authenticateDevice').mockResolvedValue({
        device: { id: 'd-1', tenantId: 't-1', branchId: 'b-1', status: 'active' } as unknown as typeof schema.posDevices.$inferSelect,
        tenant: { id: 't-1', code: 'demo_fnb', status: 'active' } as unknown as typeof schema.tenants.$inferSelect,
        branch: { id: 'b-1', code: 'main', status: 'active' } as unknown as typeof schema.branches.$inferSelect,
      });

      // Simulate PostgreSQL state and advisory locking
      let sharedMaxEnd = 0;
      let isLocked = false;
      const allocatedBlocks: Array<{ start: number; end: number }> = [];

      const mockPgPool = (service as unknown as { pgPool: { connect: jest.Mock } }).pgPool;
      mockPgPool.connect = jest.fn().mockImplementation(async () => {
        let inTx = false;
        return {
          query: jest.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
            if (sql === 'BEGIN') {
              inTx = true;
              return { rows: [] };
            }
            if (sql.includes('pg_advisory_xact_lock')) {
              // Wait if currently locked (simulating PostgreSQL advisory transaction lock queue)
              while (isLocked) {
                await new Promise((resolve) => setTimeout(resolve, 5));
              }
              isLocked = true;
              return { rows: [] };
            }
            if (sql.includes('MAX(range_end)')) {
              return { rows: [{ max_end: sharedMaxEnd }] };
            }
            if (sql.includes('INSERT INTO device_number_blocks')) {
              const start = params![3] as number;
              const end = params![4] as number;
              sharedMaxEnd = end;
              allocatedBlocks.push({ start, end });
              return { rows: [] };
            }
            if (sql === 'COMMIT') {
              inTx = false;
              isLocked = false;
              return { rows: [] };
            }
            if (sql === 'ROLLBACK') {
              inTx = false;
              isLocked = false;
              return { rows: [] };
            }
            return { rows: [] };
          }),
          release: jest.fn().mockImplementation(() => {
            if (inTx) {
              isLocked = false;
            }
          }),
        };
      });

      // Execute 10 requests concurrently
      const concurrentRequests = Array.from({ length: 10 }, () =>
        service.allocateNumberBlock('Device mock_token', 'order'),
      );

      const results = await Promise.all(concurrentRequests);
      expect(results).toHaveLength(10);

      // Verify each block has size 1,000
      for (const res of results) {
        expect(res.doc_type).toBe('order');
        expect(res.range_end - res.range_start + 1).toBe(1000);
      }

      // Sort by range_start
      const sorted = [...results].sort((a, b) => a.range_start - b.range_start);

      // Verify continuous without overlaps
      expect(sorted[0].range_start).toBe(1);
      expect(sorted[sorted.length - 1].range_end).toBe(10000);

      for (let i = 0; i < sorted.length - 1; i++) {
        expect(sorted[i].range_end + 1).toBe(sorted[i + 1].range_start);
      }
    });

    it('rejects invalid doc_type with BadRequestException', async () => {
      jest.spyOn(service, 'authenticateDevice').mockResolvedValue({
        device: { id: 'd-1', tenantId: 't-1', branchId: 'b-1', status: 'active' } as unknown as typeof schema.posDevices.$inferSelect,
        tenant: { id: 't-1', code: 'demo_fnb', status: 'active' } as unknown as typeof schema.tenants.$inferSelect,
        branch: { id: 'b-1', code: 'main', status: 'active' } as unknown as typeof schema.branches.$inferSelect,
      });

      await expect(
        service.allocateNumberBlock('Device mock_token', 'invoice'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('InternalTokenGuard (TASK-006 Round 2: Point 1)', () => {
    let guard: InternalTokenGuard;
    const testSecret = '0123456789abcdef0123456789abcdef';

    beforeEach(() => {
      process.env.INTERNAL_API_TOKEN = testSecret;
      guard = new InternalTokenGuard();
    });

    afterEach(() => {
      delete process.env.INTERNAL_API_TOKEN;
    });

    it('rejects request missing X-Internal-Token with 401', () => {
      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => ({ headers: {} }),
        }),
      } as unknown as ExecutionContext;

      expect(() => guard.canActivate(mockContext)).toThrow(UnauthorizedException);
    });

    it('rejects request with invalid X-Internal-Token with 401', () => {
      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => ({
            headers: { 'x-internal-token': 'wrong-secret-token-12345678901234' },
          }),
        }),
      } as unknown as ExecutionContext;

      expect(() => guard.canActivate(mockContext)).toThrow(UnauthorizedException);
    });

    it('allows request with valid matching X-Internal-Token', () => {
      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => ({
            headers: { 'x-internal-token': testSecret },
          }),
        }),
      } as unknown as ExecutionContext;

      expect(guard.canActivate(mockContext)).toBe(true);
    });

    it('throws fatal error during construction if token is missing or not 32 bytes (TASK-007 backlog)', () => {
      const origEnv = process.env.INTERNAL_API_TOKEN;
      const origPath = process.env.INTERNAL_API_TOKEN_PATH;
      try {
        process.env.INTERNAL_API_TOKEN_PATH = '/nonexistent/token/path';
        delete process.env.INTERNAL_API_TOKEN;

        expect(() => new InternalTokenGuard()).toThrow(
          /FATAL: Internal API token is not configured or not found/,
        );

        process.env.INTERNAL_API_TOKEN = 'short-token-invalid';
        expect(() => new InternalTokenGuard()).toThrow(
          /FATAL: Internal API token must be exactly 32 bytes/,
        );
      } finally {
        if (origEnv !== undefined) {
          process.env.INTERNAL_API_TOKEN = origEnv;
        } else {
          delete process.env.INTERNAL_API_TOKEN;
        }
        if (origPath !== undefined) {
          process.env.INTERNAL_API_TOKEN_PATH = origPath;
        } else {
          delete process.env.INTERNAL_API_TOKEN_PATH;
        }
      }
    });
  });
});
