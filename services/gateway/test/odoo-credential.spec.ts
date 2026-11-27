import { ForbiddenException, BadGatewayException } from '@nestjs/common';
import { QueryResult } from 'pg';
import { OdooCredentialService } from '../src/odoo/odoo-credential.service';
import { OdooService, MemberContext } from '../src/odoo/odoo.service';
import { PlatformService } from '../src/features/platform.service';
import * as crypto from 'crypto';

describe('TASK-004: Gateway Odoo Per-Member Credentials & Caching', () => {
  let credentialService: OdooCredentialService;
  let odooService: OdooService;
  let platformService: PlatformService;

  const testKeyBase64 = Buffer.alloc(32, 1).toString('base64');
  const membershipId = '11111111-1111-1111-1111-111111111111';
  const tenantId = '22222222-2222-2222-2222-222222222222';
  const tenantCode = 'demo_fnb';
  const rawApiKey = 'test_raw_member_api_key_123';

  function encryptAesGcm(plainText: string, base64Key: string): string {
    const key = Buffer.from(base64Key, 'base64');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
  }

  const encryptedKey = encryptAesGcm(rawApiKey, testKeyBase64);

  beforeEach(() => {
    process.env.ODOO_CREDENTIALS_KEY = testKeyBase64;
    credentialService = new OdooCredentialService();
    platformService = {
      getActiveTenant: jest.fn().mockResolvedValue({
        id: tenantId,
        code: tenantCode,
        dbName: 't_demo_fnb',
        status: 'active',
      }),
    } as unknown as PlatformService;

    odooService = new OdooService(platformService, credentialService);
  });

  afterEach(async () => {
    await credentialService.onModuleDestroy();
  });

  describe('OdooCredentialService', () => {
    it('caches decrypted key for 60 seconds and does not query DB again', async () => {
      const mockResult: QueryResult = {
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
        rows: [
          {
            membership_id: membershipId,
            tenant_id: tenantId,
            odoo_uid: 42,
            api_key_enc: encryptedKey,
            key_expires_at: new Date(Date.now() + 1000000),
            status: 'active',
          },
        ],
      };
      const querySpy = jest.spyOn(credentialService.pgPool, 'query').mockImplementation(() => Promise.resolve(mockResult) as unknown as ReturnType<typeof credentialService.pgPool.query>);

      // First call
      const res1 = await credentialService.getMemberCredential(membershipId, tenantCode, tenantId);
      expect(res1.apiKey).toBe(rawApiKey);
      expect(res1.odooUid).toBe(42);
      expect(querySpy).toHaveBeenCalledTimes(1);

      // Second call within TTL -> uses cache
      const res2 = await credentialService.getMemberCredential(membershipId, tenantCode, tenantId);
      expect(res2.apiKey).toBe(rawApiKey);
      expect(querySpy).toHaveBeenCalledTimes(1);
    });

    it('evicts cache immediately when evictCache is called (NATS event simulation)', async () => {
      const mockResult: QueryResult = {
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
        rows: [
          {
            membership_id: membershipId,
            tenant_id: tenantId,
            odoo_uid: 42,
            api_key_enc: encryptedKey,
            key_expires_at: new Date(Date.now() + 1000000),
            status: 'active',
          },
        ],
      };
      const querySpy = jest.spyOn(credentialService.pgPool, 'query').mockImplementation(() => Promise.resolve(mockResult) as unknown as ReturnType<typeof credentialService.pgPool.query>);

      await credentialService.getMemberCredential(membershipId, tenantCode, tenantId);
      expect(querySpy).toHaveBeenCalledTimes(1);

      // Evict cache
      credentialService.evictCache(membershipId);

      await credentialService.getMemberCredential(membershipId, tenantCode, tenantId);
      expect(querySpy).toHaveBeenCalledTimes(2);
    });

    it('throws 403 TENANT_MISMATCH when tenant_id in DB does not match token', async () => {
      const mockResult: QueryResult = {
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
        rows: [
          {
            membership_id: membershipId,
            tenant_id: 'other-tenant-uuid',
            odoo_uid: 42,
            api_key_enc: encryptedKey,
            key_expires_at: new Date(Date.now() + 1000000),
            status: 'active',
          },
        ],
      };
      jest.spyOn(credentialService.pgPool, 'query').mockImplementation(() => Promise.resolve(mockResult) as unknown as ReturnType<typeof credentialService.pgPool.query>);

      await expect(
        credentialService.getMemberCredential(membershipId, tenantCode, tenantId),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws 403 ODOO_USER_NOT_PROVISIONED when status is not active (e.g. disabled or pending)', async () => {
      const mockResult: QueryResult = {
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
        rows: [
          {
            membership_id: membershipId,
            tenant_id: tenantId,
            odoo_uid: 42,
            api_key_enc: encryptedKey,
            key_expires_at: new Date(Date.now() + 1000000),
            status: 'disabled',
          },
        ],
      };
      jest.spyOn(credentialService.pgPool, 'query').mockImplementation(() => Promise.resolve(mockResult) as unknown as ReturnType<typeof credentialService.pgPool.query>);

      await expect(
        credentialService.getMemberCredential(membershipId, tenantCode, tenantId),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws 403 ODOO_USER_NOT_PROVISIONED when API key is expired', async () => {
      const mockResult: QueryResult = {
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
        rows: [
          {
            membership_id: membershipId,
            tenant_id: tenantId,
            odoo_uid: 42,
            api_key_enc: encryptedKey,
            key_expires_at: new Date(Date.now() - 10000), // Expired
            status: 'active',
          },
        ],
      };
      jest.spyOn(credentialService.pgPool, 'query').mockImplementation(() => Promise.resolve(mockResult) as unknown as ReturnType<typeof credentialService.pgPool.query>);

      await expect(
        credentialService.getMemberCredential(membershipId, tenantCode, tenantId),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('OdooService Retry on 401', () => {
    it('retries once on 401 after evicting cache; succeeds if retry passes', async () => {
      jest.spyOn(credentialService, 'getMemberCredential').mockResolvedValue({
        apiKey: rawApiKey,
        odooUid: 42,
      });
      const evictSpy = jest.spyOn(credentialService, 'evictCache');

      let callCount = 0;
      jest.spyOn(odooService, 'executeJson2Call').mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return new Response('Unauthorized', { status: 401 });
        }
        return new Response(JSON.stringify([{ name: 'base', installed_version: '20.0.1.0' }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const ctx: MemberContext = { tenantCode, membershipId };
      const { data, odooUid } = await odooService.callJson2(ctx, 't_demo_fnb', 'res.users', 'read', {});

      expect(callCount).toBe(2);
      expect(evictSpy).toHaveBeenCalledWith(membershipId);
      expect(odooUid).toBe(42);
      expect(data).toBeDefined();
    });

    it('throws 502 ODOO_AUTH_FAILED if second call still returns 401', async () => {
      jest.spyOn(credentialService, 'getMemberCredential').mockResolvedValue({
        apiKey: rawApiKey,
        odooUid: 42,
      });

      jest.spyOn(odooService, 'executeJson2Call').mockResolvedValue(
        new Response('Unauthorized', { status: 401 }),
      );

      const ctx: MemberContext = { tenantCode, membershipId };
      await expect(
        odooService.callJson2(ctx, 't_demo_fnb', 'res.users', 'read', {}),
      ).rejects.toThrow(BadGatewayException);
    });
  });
});
