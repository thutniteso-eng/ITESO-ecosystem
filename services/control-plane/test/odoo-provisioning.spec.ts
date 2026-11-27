import { OdooProvisioningService } from '../src/control-plane/odoo-provisioning.service';
import { NatsService } from '../src/nats/nats.service';
import * as crypto from 'crypto';

describe('TASK-004: Control Plane OdooProvisioningService', () => {
  let service: OdooProvisioningService;
  let natsService: NatsService;

  const testKeyBase64 = Buffer.alloc(32, 1).toString('base64');
  const membershipId = '11111111-1111-1111-1111-111111111111';
  const tenantId = '22222222-2222-2222-2222-222222222222';
  const accountId = '33333333-3333-3333-3333-333333333333';

  function encryptAesGcm(plainText: string, base64Key: string): string {
    const key = Buffer.from(base64Key, 'base64');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
  }

  beforeEach(() => {
    process.env.PLATFORM_ENCRYPTION_KEY = testKeyBase64;
    process.env.ODOO_CREDENTIALS_KEY = testKeyBase64;

    natsService = {
      publish: jest.fn().mockResolvedValue(undefined),
      onModuleInit: jest.fn(),
      onModuleDestroy: jest.fn(),
      isHealthy: jest.fn().mockResolvedValue(true),
    } as unknown as NatsService;

    service = new OdooProvisioningService(natsService);
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  it('marks status as pending if tenant has no Odoo DB or system key', async () => {
    const dbMock = service.db;
    jest.spyOn(dbMock.query.memberships, 'findFirst').mockResolvedValue({
      id: membershipId,
      tenantId,
      accountId,
      status: 'active',
      branchScope: [],
      createdAt: new Date(),
    });
    jest.spyOn(dbMock.query.tenants, 'findFirst').mockResolvedValue({
      id: tenantId,
      code: 'demo_fnb2',
      displayName: 'Demo F&B 2',
      dbName: '', // No DB
      status: 'active',
      industries: ['fnb'],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    jest.spyOn(dbMock.query.tenantOdooSystemKeys, 'findFirst').mockResolvedValue(undefined);

    const insertSpy = jest.spyOn(dbMock, 'insert').mockReturnValue({
      values: () => ({
        onConflictDoUpdate: () => Promise.resolve([]),
      }),
    } as unknown as ReturnType<typeof dbMock.insert>);

    const res = await service.syncMembership(membershipId);
    expect(res.status).toBe('pending');
    expect(insertSpy).toHaveBeenCalled();
  });

  it('computes union of odoo_groups from multiple roles and provisions member', async () => {
    const dbMock = service.db;
    const systemKeyRaw = 'test_system_key_abc';
    const systemKeyEnc = encryptAesGcm(systemKeyRaw, testKeyBase64);

    jest.spyOn(dbMock.query.memberships, 'findFirst').mockResolvedValue({
      id: membershipId,
      tenantId,
      accountId,
      status: 'active',
      branchScope: [],
      createdAt: new Date(),
    });
    jest.spyOn(dbMock.query.tenants, 'findFirst').mockResolvedValue({
      id: tenantId,
      code: 'demo_fnb',
      displayName: 'Demo F&B',
      dbName: 't_demo_fnb',
      status: 'active',
      industries: ['fnb'],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    jest.spyOn(dbMock.query.tenantOdooSystemKeys, 'findFirst').mockResolvedValue({
      tenantId,
      keyEnc: systemKeyEnc,
      createdAt: new Date(),
      rotatedAt: null,
    });
    jest.spyOn(dbMock.query.membershipOdooUsers, 'findFirst').mockResolvedValue(undefined);
    jest.spyOn(dbMock.query.accounts, 'findFirst').mockResolvedValue({
      id: accountId,
      email: 'owner@demo.local',
      phone: null,
      passwordHash: 'hash',
      totpSecretEnc: null,
      totpEnabled: false,
      lastTotpStep: null,
      isPlatformAdmin: false,
      status: 'active',
      failedAttempts: 0,
      lockedUntil: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    jest.spyOn(dbMock, 'select').mockReturnValue({
      from: () => ({
        where: () => Promise.resolve([{ roleId: 'role-1' }, { roleId: 'role-2' }]),
      }),
    } as unknown as ReturnType<typeof dbMock.select>);

    jest.spyOn(dbMock.query.roles, 'findMany').mockResolvedValue([
      {
        id: 'role-1',
        tenantId,
        name: 'Role A',
        isOwner: false,
        odooGroups: ['base.group_user'],
        createdAt: new Date(),
      },
      {
        id: 'role-2',
        tenantId,
        name: 'Role B',
        isOwner: false,
        odooGroups: ['base.group_user'],
        createdAt: new Date(),
      },
    ]);

    const callOdooJson2Spy = jest.spyOn(service, 'callOdooJson2').mockImplementation(
      async (...args: unknown[]) => {
        const method = args[3];
        if (method === 'provision_member') {
          return { uid: 10, login: `iteso-${membershipId}` };
        }
        if (method === 'issue_member_key') {
          return { key: 'raw_generated_key', expires_at: '2026-12-31 00:00:00' };
        }
        if (method === 'revoke_member_keys') {
          return { removed: 0 };
        }
        return {};
      },
    );

    jest.spyOn(dbMock, 'insert').mockReturnValue({
      values: () => ({
        onConflictDoUpdate: () => Promise.resolve([]),
      }),
    } as unknown as ReturnType<typeof dbMock.insert>);

    const res = await service.syncMembership(membershipId);

    expect(res.status).toBe('active');
    expect(res.odooUid).toBe(10);
    expect(callOdooJson2Spy).toHaveBeenCalledWith(
      't_demo_fnb',
      systemKeyRaw,
      'iteso.provisioning',
      'provision_member',
      expect.objectContaining({
        membership_id: membershipId,
        group_xmlids: ['base.group_user'],
      }),
    );
    expect(callOdooJson2Spy).toHaveBeenCalledWith(
      't_demo_fnb',
      systemKeyRaw,
      'iteso.provisioning',
      'revoke_member_keys',
      { uid: 10, keep_newest: true },
    );
    expect(natsService.publish).toHaveBeenCalledWith('platform.odoo_credentials.changed', {
      membership_id: membershipId,
    });
  });

  it('disables member and revokes keys when membership status is disabled', async () => {
    const dbMock = service.db;
    const systemKeyRaw = 'test_system_key_abc';
    const systemKeyEnc = encryptAesGcm(systemKeyRaw, testKeyBase64);

    jest.spyOn(dbMock.query.memberships, 'findFirst').mockResolvedValue({
      id: membershipId,
      tenantId,
      accountId,
      status: 'disabled',
      branchScope: [],
      createdAt: new Date(),
    });
    jest.spyOn(dbMock.query.tenants, 'findFirst').mockResolvedValue({
      id: tenantId,
      code: 'demo_fnb',
      displayName: 'Demo F&B',
      dbName: 't_demo_fnb',
      status: 'active',
      industries: ['fnb'],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    jest.spyOn(dbMock.query.tenantOdooSystemKeys, 'findFirst').mockResolvedValue({
      tenantId,
      keyEnc: systemKeyEnc,
      createdAt: new Date(),
      rotatedAt: null,
    });
    jest.spyOn(dbMock.query.membershipOdooUsers, 'findFirst').mockResolvedValue({
      membershipId,
      tenantId,
      odooUid: 10,
      odooLogin: `iteso-${membershipId}`,
      apiKeyEnc: null,
      keyExpiresAt: null,
      status: 'active',
      lastError: null,
      syncedAt: new Date(),
    });

    const callOdooJson2Spy = jest.spyOn(service, 'callOdooJson2').mockResolvedValue({
      disabled: true,
      uid: 10,
    });

    jest.spyOn(dbMock, 'insert').mockReturnValue({
      values: () => ({
        onConflictDoUpdate: () => Promise.resolve([]),
      }),
    } as unknown as ReturnType<typeof dbMock.insert>);

    const res = await service.syncMembership(membershipId);

    expect(res.status).toBe('disabled');
    expect(callOdooJson2Spy).toHaveBeenCalledWith(
      't_demo_fnb',
      systemKeyRaw,
      'iteso.provisioning',
      'disable_member',
      { uid: 10 },
    );
    expect(natsService.publish).toHaveBeenCalledWith('platform.odoo_credentials.changed', {
      membership_id: membershipId,
    });
  });

  describe('Non-destructive rotation error handling', () => {
    const systemKeyRaw = 'test_system_key_abc';
    const systemKeyEnc = encryptAesGcm(systemKeyRaw, testKeyBase64);

    it('keeps status=active and only sets lastError if current key is still valid during failed rotation', async () => {
      const dbMock = service.db;
      const validUntil = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000); // 10 days in future

      jest.spyOn(dbMock.query.memberships, 'findFirst').mockResolvedValue({
        id: membershipId,
        tenantId,
        accountId,
        status: 'active',
        branchScope: [],
        createdAt: new Date(),
      });
      jest.spyOn(dbMock.query.tenants, 'findFirst').mockResolvedValue({
        id: tenantId,
        code: 'demo_fnb',
        displayName: 'Demo F&B',
        dbName: 't_demo_fnb',
        status: 'active',
        industries: ['fnb'],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      jest.spyOn(dbMock.query.tenantOdooSystemKeys, 'findFirst').mockResolvedValue({
        tenantId,
        keyEnc: systemKeyEnc,
        createdAt: new Date(),
        rotatedAt: null,
      });
      jest.spyOn(dbMock.query.membershipOdooUsers, 'findFirst').mockResolvedValue({
        membershipId,
        tenantId,
        odooUid: 10,
        odooLogin: `iteso-${membershipId}`,
        apiKeyEnc: 'enc_existing_valid_key',
        keyExpiresAt: validUntil,
        status: 'active',
        lastError: null,
        syncedAt: new Date(),
      });
      jest.spyOn(dbMock.query.accounts, 'findFirst').mockResolvedValue({
        id: accountId,
        email: 'member@demo.local',
        phone: null,
        passwordHash: 'hash',
        totpSecretEnc: null,
        totpEnabled: false,
        lastTotpStep: null,
        isPlatformAdmin: false,
        status: 'active',
        failedAttempts: 0,
        lockedUntil: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      jest.spyOn(dbMock, 'select').mockReturnValue({
        from: () => ({
          where: () => Promise.resolve([]),
        }),
      } as unknown as ReturnType<typeof dbMock.select>);

      // Fail during call to Odoo
      jest.spyOn(service, 'callOdooJson2').mockRejectedValue(new Error('Odoo network timeout'));

      const updateSpy = jest.spyOn(dbMock, 'update').mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([]),
        }),
      } as unknown as ReturnType<typeof dbMock.update>);

      const res = await service.syncMembership(membershipId);

      // Status must remain active
      expect(res.status).toBe('active');
      expect(res.lastError).toContain('Odoo network timeout');
      expect(updateSpy).toHaveBeenCalled();
    });

    it('sets status=error if no valid key exists when Odoo call fails', async () => {
      const dbMock = service.db;

      jest.spyOn(dbMock.query.memberships, 'findFirst').mockResolvedValue({
        id: membershipId,
        tenantId,
        accountId,
        status: 'active',
        branchScope: [],
        createdAt: new Date(),
      });
      jest.spyOn(dbMock.query.tenants, 'findFirst').mockResolvedValue({
        id: tenantId,
        code: 'demo_fnb',
        displayName: 'Demo F&B',
        dbName: 't_demo_fnb',
        status: 'active',
        industries: ['fnb'],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      jest.spyOn(dbMock.query.tenantOdooSystemKeys, 'findFirst').mockResolvedValue({
        tenantId,
        keyEnc: systemKeyEnc,
        createdAt: new Date(),
        rotatedAt: null,
      });
      // No existing record or expired key
      jest.spyOn(dbMock.query.membershipOdooUsers, 'findFirst').mockResolvedValue(undefined);
      jest.spyOn(dbMock.query.accounts, 'findFirst').mockResolvedValue({
        id: accountId,
        email: 'member@demo.local',
        phone: null,
        passwordHash: 'hash',
        totpSecretEnc: null,
        totpEnabled: false,
        lastTotpStep: null,
        isPlatformAdmin: false,
        status: 'active',
        failedAttempts: 0,
        lockedUntil: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      jest.spyOn(dbMock, 'select').mockReturnValue({
        from: () => ({
          where: () => Promise.resolve([]),
        }),
      } as unknown as ReturnType<typeof dbMock.select>);

      // Fail during call to Odoo
      jest.spyOn(service, 'callOdooJson2').mockRejectedValue(new Error('Odoo down'));

      jest.spyOn(dbMock, 'insert').mockReturnValue({
        values: () => ({
          onConflictDoUpdate: () => Promise.resolve([]),
        }),
      } as unknown as ReturnType<typeof dbMock.insert>);

      const res = await service.syncMembership(membershipId);

      // Status must become error
      expect(res.status).toBe('error');
      expect(res.lastError).toContain('Odoo down');
    });
  });
});
