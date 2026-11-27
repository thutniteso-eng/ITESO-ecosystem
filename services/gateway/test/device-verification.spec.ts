import { UnauthorizedException } from '@nestjs/common';
import { QueryResult } from 'pg';
import { DeviceVerificationService } from '../src/auth/device-verification.service';

describe('TASK-005: Gateway DeviceVerificationService', () => {
  let service: DeviceVerificationService;

  beforeEach(() => {
    service = new DeviceVerificationService();
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  it('caches active device for 30s and does not re-query DB', async () => {
    const mockResult: QueryResult = {
      command: 'SELECT',
      rowCount: 1,
      oid: 0,
      fields: [],
      rows: [
        {
          id: 'dev-1',
          tenant_id: 't-1',
          branch_id: 'b-1',
          status: 'active',
        },
      ],
    };
    const querySpy = jest.spyOn(service.pgPool, 'query').mockImplementation(() => Promise.resolve(mockResult) as unknown as ReturnType<typeof service.pgPool.query>);

    const first = await service.verifyDeviceActive('dev-1');
    expect(first.status).toBe('active');
    expect(querySpy).toHaveBeenCalledTimes(1);

    const second = await service.verifyDeviceActive('dev-1');
    expect(second.status).toBe('active');
    expect(querySpy).toHaveBeenCalledTimes(1); // from cache!
  });

  it('throws DEVICE_REVOKED if device status is revoked', async () => {
    const mockResult: QueryResult = {
      command: 'SELECT',
      rowCount: 1,
      oid: 0,
      fields: [],
      rows: [
        {
          id: 'dev-revoked',
          tenant_id: 't-1',
          branch_id: 'b-1',
          status: 'revoked',
        },
      ],
    };
    jest.spyOn(service.pgPool, 'query').mockImplementation(() => Promise.resolve(mockResult) as unknown as ReturnType<typeof service.pgPool.query>);

    await expect(service.verifyDeviceActive('dev-revoked')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('evicts device cache immediately when evictCache is called', async () => {
    const mockResult: QueryResult = {
      command: 'SELECT',
      rowCount: 1,
      oid: 0,
      fields: [],
      rows: [
        {
          id: 'dev-1',
          tenant_id: 't-1',
          branch_id: 'b-1',
          status: 'active',
        },
      ],
    };
    const querySpy = jest.spyOn(service.pgPool, 'query').mockImplementation(() => Promise.resolve(mockResult) as unknown as ReturnType<typeof service.pgPool.query>);

    await service.verifyDeviceActive('dev-1');
    expect(querySpy).toHaveBeenCalledTimes(1);

    service.evictCache('dev-1');

    await service.verifyDeviceActive('dev-1');
    expect(querySpy).toHaveBeenCalledTimes(2);
  });
});
