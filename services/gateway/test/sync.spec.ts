import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { SyncService, PushOperation } from '../src/sync/sync.service';
import { PlatformService } from '../src/features/platform.service';
import { OdooCredentialService } from '../src/odoo/odoo-credential.service';
import { OdooService } from '../src/odoo/odoo.service';

describe('TASK-006 (Round 2): SyncService Unit Tests', () => {
  let service: SyncService;
  let platformService: PlatformService;
  let credentialService: OdooCredentialService;
  let odooService: OdooService;

  const tenantCode = 'demo_fnb';
  const tenantId = '11111111-1111-1111-1111-111111111111';
  const deviceId = 'dev-001';
  const memberId = 'mem-001';
  const validRosterJti = 'roster-jti-001';

  const baseOp: PushOperation = {
    op_id: '018e0000-0000-7000-8000-000000000001',
    device_id: deviceId,
    roster_jti: validRosterJti,
    membership_id: memberId,
    client_time: new Date().toISOString(),
    seq: 1,
    op_type: 'contact.create',
    payload: { name: 'Nguyễn Văn A' },
  };

  beforeEach(() => {
    platformService = {
      getActiveTenant: jest.fn().mockResolvedValue({
        id: tenantId,
        code: tenantCode,
        dbName: 't_demo_fnb',
        status: 'active',
      }),
    } as unknown as PlatformService;

    const mockPgPool = {
      query: jest.fn().mockImplementation((queryText: string, params: unknown[]) => {
        if (queryText.includes('pos_roster_issues')) {
          const jti = params[0];
          if (jti === validRosterJti) {
            return {
              rows: [
                {
                  jti: validRosterJti,
                  device_id: deviceId,
                  tenant_id: tenantId,
                  member_ids: [memberId],
                  issued_at: new Date(Date.now() - 30 * 60 * 1000), // 30m ago
                  expires_at: new Date(Date.now() + 2 * 3600 * 1000), // 2h later
                },
              ],
            };
          }
          if (jti === 'expired-roster') {
            return {
              rows: [
                {
                  jti: 'expired-roster',
                  device_id: deviceId,
                  tenant_id: tenantId,
                  member_ids: [memberId],
                  issued_at: new Date(Date.now() - 4 * 3600 * 1000),
                  expires_at: new Date(Date.now() - 2 * 3600 * 1000), // expired 2h ago
                },
              ],
            };
          }
        }
        return { rows: [] };
      }),
    };

    credentialService = {
      pgPool: mockPgPool,
      evictCache: jest.fn(),
      getMemberCredential: jest.fn().mockResolvedValue({
        apiKey: 'mock_member_api_key',
        odooUid: 10,
      }),
      getDeviceCredential: jest.fn().mockResolvedValue({
        apiKey: 'mock_device_api_key',
        odooUid: 20,
      }),
    } as unknown as OdooCredentialService;

    odooService = {
      executeJson2Call: jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          result: [
            {
              op_id: baseOp.op_id,
              status: 'applied',
              result: { id: 101 },
            },
          ],
        }),
      }),
    } as unknown as OdooService;

    // Mock global fetch for internal permissions check
    global.fetch = jest.fn().mockImplementation((url: string) => {
      if (url.includes('/permissions')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ perms: ['pos.session.open', 'pos.order.create'] }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }) as jest.Mock;

    service = new SyncService(platformService, credentialService, odooService);
  });

  describe('Batch Size Validation', () => {
    it('rejects empty batch or array > 200 items', async () => {
      await expect(service.push(tenantCode, deviceId, [])).rejects.toThrow(BadRequestException);

      const ops201 = Array.from({ length: 201 }, (_, i) => ({
        ...baseOp,
        op_id: `op-${i}`,
      }));
      await expect(service.push(tenantCode, deviceId, ops201)).rejects.toThrow(BadRequestException);
    });
  });

  describe('Device & Roster Validation', () => {
    it('rejects operation when op.device_id does not match session device (DEVICE_MISMATCH)', async () => {
      const op = { ...baseOp, device_id: 'other-device-999' };
      const { results } = await service.push(tenantCode, deviceId, [op]);

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('rejected');
      expect(results[0].error).toBe('DEVICE_MISMATCH');
    });

    it('rejects operation when member is not in roster (MEMBER_NOT_IN_ROSTER)', async () => {
      const op = { ...baseOp, membership_id: 'stranger-member' };
      const { results } = await service.push(tenantCode, deviceId, [op]);

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('rejected');
      expect(results[0].error).toBe('MEMBER_NOT_IN_ROSTER');
    });

    it('rejects operation when roster is expired (ROSTER_EXPIRED)', async () => {
      const op = { ...baseOp, roster_jti: 'expired-roster' };
      const { results } = await service.push(tenantCode, deviceId, [op]);

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('rejected');
      expect(results[0].error).toBe('ROSTER_EXPIRED');
    });

    it('rejects operation with timestamp > 5 minutes in future (FUTURE_TIMESTAMP)', async () => {
      const futureTime = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // +10m
      const op = { ...baseOp, client_time: futureTime };
      const { results } = await service.push(tenantCode, deviceId, [op]);

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('rejected');
      expect(results[0].error).toBe('FUTURE_TIMESTAMP');
    });
  });

  describe('Flag Review (Revoked Permissions or Clock Skew)', () => {
    it('flags review when membership lost pos.session.open permission', async () => {
      // Mock control plane returning empty perms
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ perms: ['other.permission'] }),
      });

      (odooService.executeJson2Call as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          result: [{ op_id: baseOp.op_id, status: 'needs_review', result: { id: 102 } }],
        }),
      });

      const { results } = await service.push(tenantCode, deviceId, [baseOp]);
      expect(results[0].status).toBe('needs_review');

      // Verify flag_review was sent to Odoo
      const odooCallArgs = (odooService.executeJson2Call as jest.Mock).mock.calls[0][4];
      expect(odooCallArgs.operations[0].flag_review).toBe(true);
    });

    it('flags review when clock skew between server and client exceeds 10 minutes', async () => {
      const skewTime = new Date(Date.now() - 15 * 60 * 1000).toISOString(); // 15m in past
      const op = { ...baseOp, client_time: skewTime };

      (odooService.executeJson2Call as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          result: [{ op_id: baseOp.op_id, status: 'needs_review', result: { id: 103 } }],
        }),
      });

      const { results } = await service.push(tenantCode, deviceId, [op]);
      expect(results[0].status).toBe('needs_review');

      const odooCallArgs = (odooService.executeJson2Call as jest.Mock).mock.calls[0][4];
      expect(odooCallArgs.operations[0].flag_review).toBe(true);
    });
  });

  describe('Disabled Member vs Temporary Error (Point 2)', () => {
    it('returns rejected MEMBER_DISABLED only when member user is truly not active in DB', async () => {
      (credentialService.getMemberCredential as jest.Mock).mockRejectedValueOnce(
        new ForbiddenException({ error: 'ODOO_USER_NOT_PROVISIONED', message: 'User is disabled' }),
      );

      const { results } = await service.push(tenantCode, deviceId, [baseOp]);
      expect(results[0].status).toBe('rejected');
      expect(results[0].error).toBe('MEMBER_DISABLED');
    });

    it('returns retry INFRASTRUCTURE_ERROR when database connection times out', async () => {
      (credentialService.getMemberCredential as jest.Mock).mockRejectedValueOnce(
        new Error('PostgreSQL connection timeout'),
      );

      const { results } = await service.push(tenantCode, deviceId, [baseOp]);
      expect(results[0].status).toBe('retry');
      expect(results[0].error).toBe('INFRASTRUCTURE_ERROR');
    });

    it('returns retry ODOO_TEMPORARY_ERROR when Odoo responds with 500', async () => {
      (odooService.executeJson2Call as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      const { results } = await service.push(tenantCode, deviceId, [baseOp]);
      expect(results[0].status).toBe('retry');
      expect(results[0].error).toBe('ODOO_TEMPORARY_ERROR');
    });

    it('returns retry ODOO_CALL_FAILED when Odoo call throws network error or timeout', async () => {
      (odooService.executeJson2Call as jest.Mock).mockRejectedValueOnce(
        new Error('fetch failed ECONNREFUSED'),
      );

      const { results } = await service.push(tenantCode, deviceId, [baseOp]);
      expect(results[0].status).toBe('retry');
      expect(results[0].error).toBe('ODOO_CALL_FAILED');
    });

    it('returns retry CONFIGURATION_ERROR when key decryption fails (TASK-007 backlog)', async () => {
      (credentialService.getMemberCredential as jest.Mock).mockRejectedValueOnce(
        new Error('KEY_DECRYPTION_FAILED: Invalid authentication tag'),
      );

      const { results } = await service.push(tenantCode, deviceId, [baseOp]);
      expect(results[0].status).toBe('retry');
      expect(results[0].error).toBe('CONFIGURATION_ERROR');
    });

    it('SyncService constructor throws fatal error if internal token is missing or not 32 bytes (TASK-007 backlog)', () => {
      const origEnv = process.env.INTERNAL_API_TOKEN;
      const origPath = process.env.INTERNAL_API_TOKEN_PATH;
      try {
        process.env.INTERNAL_API_TOKEN_PATH = '/nonexistent/path/token';
        delete process.env.INTERNAL_API_TOKEN;

        expect(() => new SyncService(platformService, credentialService, odooService)).toThrow(
          /FATAL: Internal API token is not configured/,
        );

        process.env.INTERNAL_API_TOKEN = 'short-token';
        expect(() => new SyncService(platformService, credentialService, odooService)).toThrow(
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
