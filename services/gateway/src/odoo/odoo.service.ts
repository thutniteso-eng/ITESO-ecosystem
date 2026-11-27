import {
  BadGatewayException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PlatformService } from '../features/platform.service';
import { OdooCredentialService } from './odoo-credential.service';

export interface OdooVersionResponse {
  tenant: string;
  database: string;
  api: 'json-2';
  version: string;
  version_info: unknown[];
  base_module_version: string | null;
  odoo_uid?: number;
}

interface OdooJsonVersionPayload {
  version: string;
  version_info: unknown[];
}

interface OdooModuleRecord {
  name: string;
  installed_version?: string | false;
  latest_version?: string | false;
  state?: string;
}

export interface MemberContext {
  tenantCode: string;
  membershipId: string;
}

@Injectable()
export class OdooService {
  private readonly logger = new Logger(OdooService.name);
  private readonly odooUrl: string;

  constructor(
    private readonly platformService: PlatformService,
    private readonly credentialService: OdooCredentialService,
  ) {
    this.odooUrl = (process.env.ODOO_URL ?? 'http://odoo:8069').replace(/\/+$/, '');
  }

  async getVersionForTenant(
    tenantCode: string | undefined,
    membershipId: string | undefined,
  ): Promise<OdooVersionResponse> {
    if (!membershipId) {
      throw new ForbiddenException({
        error: 'FORBIDDEN',
        message: 'membershipId is required in token to access tenant Odoo',
      });
    }

    const tenant = await this.platformService.getActiveTenant(tenantCode);
    const dbName = tenant.dbName;

    const ctx: MemberContext = {
      tenantCode: tenant.code,
      membershipId,
    };

    // Call Odoo 20 External JSON-2 API against the tenant's database with member key
    const { data: json2Response, odooUid } = await this.callJson2<OdooModuleRecord[]>(
      ctx,
      dbName,
      'ir.module.module',
      'search_read',
      {
        domain: [['name', '=', 'base']],
        fields: ['name', 'installed_version', 'latest_version', 'state'],
        limit: 1,
      },
    );

    // Fetch server version metadata from Odoo 20 /json/version
    const versionInfo = await this.fetchServerVersion();

    const baseModule = json2Response[0];
    const baseModuleVersion =
      typeof baseModule?.installed_version === 'string'
        ? baseModule.installed_version
        : typeof baseModule?.latest_version === 'string'
          ? baseModule.latest_version
          : null;

    return {
      tenant: tenant.code,
      database: dbName,
      api: 'json-2',
      version: versionInfo.version,
      version_info: versionInfo.version_info,
      base_module_version: baseModuleVersion,
      odoo_uid: odooUid,
    };
  }

  async callJson2<T>(
    ctx: MemberContext,
    dbName: string,
    model: string,
    method: string,
    body: Record<string, unknown>,
  ): Promise<{ data: T; odooUid: number }> {
    const tenant = await this.platformService.getActiveTenant(ctx.tenantCode);

    // Obtain member credential
    let cred = await this.credentialService.getMemberCredential(
      ctx.membershipId,
      ctx.tenantCode,
      tenant.id,
    );

    let res = await this.executeJson2Call(dbName, cred.apiKey, model, method, body);

    // If 401 Unauthorized, evict cache and retry once
    if (res.status === 401) {
      this.credentialService.evictCache(ctx.membershipId);
      cred = await this.credentialService.getMemberCredential(
        ctx.membershipId,
        ctx.tenantCode,
        tenant.id,
      );
      res = await this.executeJson2Call(dbName, cred.apiKey, model, method, body);

      if (res.status === 401) {
        throw new BadGatewayException({
          error: 'ODOO_AUTH_FAILED',
          message: 'Authentication to Odoo with member credentials failed',
        });
      }
    }

    if (res.status === 404) {
      throw new NotFoundException({
        error: 'TENANT_NOT_FOUND',
        message: `Odoo database '${dbName}' not found`,
      });
    }

    if (res.status === 403) {
      const detail = await res.text().catch(() => '');
      this.logger.error(`Odoo access denied (403): ${detail}`);
      throw new ForbiddenException({
        error: 'ODOO_ACCESS_DENIED',
        message: 'Access denied by Odoo',
      });
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      this.logger.error(`Odoo JSON-2 API returned HTTP ${res.status}: ${detail}`);
      throw new BadGatewayException({
        error: 'ODOO_API_ERROR',
        message: 'Odoo API request failed',
      });
    }

    const data = (await res.json()) as T;
    return { data, odooUid: cred.odooUid };
  }

  async executeJson2Call(
    dbName: string,
    apiKey: string,
    model: string,
    method: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Odoo-Database': dbName,
      'Authorization': `bearer ${apiKey}`,
    };

    try {
      return await fetch(`${this.odooUrl}/json/2/${model}/${method}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      throw new BadGatewayException({
        error: 'ODOO_UNREACHABLE',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async fetchServerVersion(): Promise<OdooJsonVersionPayload> {
    let response: Response;
    try {
      response = await fetch(`${this.odooUrl}/json/version`, {
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      throw new BadGatewayException({
        error: 'ODOO_UNREACHABLE',
        message: err instanceof Error ? err.message : String(err),
      });
    }

    if (!response.ok) {
      throw new BadGatewayException({
        error: 'ODOO_API_ERROR',
        message: `Odoo /json/version returned HTTP ${response.status}`,
      });
    }

    return (await response.json()) as OdooJsonVersionPayload;
  }
}
