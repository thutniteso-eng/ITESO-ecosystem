import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PosDeviceService } from '../src/control-plane/pos-device.service';
import { TokenService } from '../src/auth/token.service';
import { NatsService } from '../src/nats/nats.service';
import { validatePinComplexity } from '../src/auth/crypto.util';

describe('TASK-005: Control Plane PosDeviceService & PIN Unit Tests', () => {
  let service: PosDeviceService;
  let tokenService: TokenService;
  let natsService: NatsService;

  beforeEach(() => {
    tokenService = {
      signAccessToken: jest.fn().mockResolvedValue('mock_access_token'),
      signRosterJws: jest.fn().mockResolvedValue('mock_roster_jws'),
      getPublicJwk: jest.fn().mockResolvedValue({ kty: 'OKP', crv: 'Ed25519', x: 'mock_jwk_x' }),
    } as unknown as TokenService;

    natsService = {
      publish: jest.fn().mockResolvedValue(undefined),
      isHealthy: jest.fn().mockResolvedValue(true),
    } as unknown as NatsService;

    service = new PosDeviceService(tokenService, natsService);
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
});
