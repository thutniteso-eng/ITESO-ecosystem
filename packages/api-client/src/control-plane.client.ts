import { paths as CPPaths } from './control-plane.types';

export type CPPath = keyof CPPaths;

export interface ClientOptions {
  baseUrl: string;
  token?: string;
  internalToken?: string;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly data: any,
    message?: string,
  ) {
    super(message || (data && data.message) || `API Error: ${status}`);
    this.name = 'ApiError';
  }
}

export class ControlPlaneClient {
  private baseUrl: string;
  private token?: string;
  private internalToken?: string;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.internalToken = options.internalToken;
  }

  setToken(token?: string) {
    this.token = token;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit & { token?: string } = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const token = options.token || this.token;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(options.headers as Record<string, string>),
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    if (this.internalToken) {
      headers['X-Internal-Token'] = this.internalToken;
    }

    const res = await fetch(url, {
      ...options,
      headers,
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new ApiError(res.status, data);
    }
    return data as T;
  }

  // --- Auth APIs ---
  async login(body: { identifier?: string; login?: string; password?: string }) {
    return this.request<any>('/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async verifyTotp(body: { challenge_token?: string; code?: string }) {
    return this.request<any>('/v1/auth/totp', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async selectTenant(body: { selection_token?: string; tenant?: string; tenant_code?: string }) {
    return this.request<any>('/v1/auth/select-tenant', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async refresh(refreshToken: string) {
    return this.request<any>('/v1/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
  }

  async logout(refreshToken?: string) {
    return this.request<{ success: boolean }>('/v1/auth/logout', {
      method: 'POST',
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
  }

  async getMe(token?: string) {
    return this.request<any>('/v1/me', {
      method: 'GET',
      token,
    });
  }

  // --- Admin APIs (Super Admin) ---
  async getTenants(token?: string) {
    return this.request<any[]>('/admin/tenants', {
      method: 'GET',
      token,
    });
  }

  async getFeatures(token?: string) {
    return this.request<any[]>('/admin/features', {
      method: 'GET',
      token,
    });
  }

  async getTenantFeatures(tenantCode: string, token?: string) {
    return this.request<any[]>(`/admin/tenants/${tenantCode}/features`, {
      method: 'GET',
      token,
    });
  }

  async updatePlatformFeature(key: string, enabled: boolean, note?: string, token?: string) {
    return this.request<any>(`/admin/features/${key}/platform`, {
      method: 'PUT',
      body: JSON.stringify({ enabled, note }),
      token,
    });
  }

  async updateTenantFeature(
    tenantCode: string,
    key: string,
    enabled: boolean | null,
    note?: string,
    token?: string,
  ) {
    return this.request<any>(`/admin/tenants/${tenantCode}/features/${key}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled, note }),
      token,
    });
  }

  async getAuditLog(
    query?: {
      from?: string;
      to?: string;
      actor?: string;
      action?: string;
      page?: number;
      limit?: number;
    },
    token?: string,
  ) {
    const params = new URLSearchParams();
    if (query?.from) params.set('from', query.from);
    if (query?.to) params.set('to', query.to);
    if (query?.actor) params.set('actor', query.actor);
    if (query?.action) params.set('action', query.action);
    if (query?.page) params.set('page', String(query.page));
    if (query?.limit) params.set('limit', String(query.limit));

    const qs = params.toString();
    return this.request<{
      data: any[];
      total: number;
      page: number;
      limit: number;
      totalPages: number;
    }>(`/admin/audit-log${qs ? `?${qs}` : ''}`, {
      method: 'GET',
      token,
    });
  }
}
