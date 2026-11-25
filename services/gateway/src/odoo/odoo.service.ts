import {
  BadGatewayException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PlatformService } from '../features/platform.service';

export interface OdooVersionResponse {
  tenant: string;
  database: string;
  api: 'json-2';
  version: string;
  version_info: unknown[];
  base_module_version: string | null;
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

@Injectable()
export class OdooService {
  private readonly odooUrl: string;
  private readonly devApiKey: string;

  constructor(private readonly platformService: PlatformService) {
    this.odooUrl = process.env.ODOO_URL ?? 'http://odoo:8069';
    this.devApiKey = process.env.ODOO_DEV_API_KEY ?? '';
  }

  async getVersionForTenant(
    tenantCode: string | undefined,
  ): Promise<OdooVersionResponse> {
    const tenant = await this.platformService.getActiveTenant(tenantCode);
    const dbName = tenant.dbName;

    // Call Odoo 20 External JSON-2 API against the tenant's database
    const json2Response = await this.callJson2<OdooModuleRecord[]>(
      dbName,
      'ir.module.module',
      'search_read',
      {
        domain: [['name', '=', 'base']],
        fields: ['name', 'installed_version', 'latest_version', 'state'],
        limit: 1,
      },
    );

    // Also fetch server version metadata from Odoo 20 /json/version
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
    };
  }

  async callJson2<T>(
    dbName: string,
    model: string,
    method: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Odoo-Database': dbName,
    };
    if (this.devApiKey) {
      headers['Authorization'] = `bearer ${this.devApiKey}`;
    }

    let response: Response;
    try {
      response = await fetch(`${this.odooUrl}/json/2/${model}/${method}`, {
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

    if (response.status === 404) {
      throw new NotFoundException({
        error: 'TENANT_NOT_FOUND',
        message: `Odoo database '${dbName}' not found`,
      });
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new BadGatewayException({
        error: 'ODOO_API_ERROR',
        message: `Odoo JSON-2 API returned HTTP ${response.status}: ${detail}`,
      });
    }

    return (await response.json()) as T;
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
