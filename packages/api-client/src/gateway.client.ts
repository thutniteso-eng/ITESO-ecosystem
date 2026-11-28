import { ApiError, ClientOptions } from './control-plane.client';

export class GatewayClient {
  private baseUrl: string;
  private token?: string;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
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

  async getFeatures(token?: string): Promise<{ tenant: string; features: string[] }> {
    return this.request<{ tenant: string; features: string[] }>('/v1/features', {
      method: 'GET',
      token,
    });
  }

  async getOdooVersion(token?: string): Promise<any> {
    return this.request<any>('/v1/odoo/version', {
      method: 'GET',
      token,
    });
  }
}
