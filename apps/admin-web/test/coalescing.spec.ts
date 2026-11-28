import {
  isTokenExpiring,
  refreshSessionWithCoalescing,
  refreshCache,
  inFlightRefreshes,
  SessionData,
} from '../src/lib/session';

describe('Token Refresh Coalescing & Rate Limiting (ADR-008 Point 1)', () => {
  beforeEach(() => {
    refreshCache.clear();
    inFlightRefreshes.clear();
  });

  const baseSession: SessionData = {
    accessToken: 'initial-access-token',
    refreshToken: 'test-refresh-token-12345',
    expiresAt: Date.now() + 900_000,
    issuedAt: Date.now(),
    account: {
      id: 'acc-1',
      email: 'admin@platform.local',
      isPlatformAdmin: true,
    },
    roles: ['platform_admin'],
    perms: ['*'],
  };

  it('correctly detects when token is expiring soon vs valid', () => {
    // Normal 15m token, 10m left -> not expiring
    const validSession: SessionData = {
      ...baseSession,
      expiresAt: Date.now() + 600_000,
      issuedAt: Date.now() - 300_000,
    };
    expect(isTokenExpiring(validSession)).toBe(false);

    // Normal 15m token, 30s left -> expiring (< 60s)
    const expiringSession: SessionData = {
      ...baseSession,
      expiresAt: Date.now() + 30_000,
      issuedAt: Date.now() - 870_000,
    };
    expect(isTokenExpiring(expiringSession)).toBe(true);

    // Short TTL token (20s total), 15s left -> not expiring
    const shortValid: SessionData = {
      ...baseSession,
      expiresAt: Date.now() + 15_000,
      issuedAt: Date.now() - 5_000,
    };
    expect(isTokenExpiring(shortValid)).toBe(false);

    // Short TTL token, expired -> expiring
    const shortExpired: SessionData = {
      ...baseSession,
      expiresAt: Date.now() - 1_000,
      issuedAt: Date.now() - 21_000,
    };
    expect(isTokenExpiring(shortExpired)).toBe(true);
  });

  it('coalesces multiple concurrent refresh requests into a single network call', async () => {
    let networkCallCount = 0;
    const originalFetch = global.fetch;

    global.fetch = jest.fn(async () => {
      networkCallCount++;
      // Simulate 50ms latency
      await new Promise((r) => setTimeout(r, 50));
      return {
        ok: true,
        json: async () => ({
          access_token: 'new-access-token-999',
          refresh_token: 'new-refresh-token-999',
          expires_in: 900,
        }),
      } as unknown as Response;
    });

    try {
      // Fire 5 concurrent refresh calls with the exact same old refresh token
      const promises = [
        refreshSessionWithCoalescing(baseSession),
        refreshSessionWithCoalescing(baseSession),
        refreshSessionWithCoalescing(baseSession),
        refreshSessionWithCoalescing(baseSession),
        refreshSessionWithCoalescing(baseSession),
      ];

      const results = await Promise.all(promises);

      // Verify all 5 resolved to the new token
      for (const res of results) {
        expect(res).not.toBeNull();
        expect(res?.accessToken).toBe('new-access-token-999');
        expect(res?.refreshToken).toBe('new-refresh-token-999');
      }

      // Crucial: fetch must have been called exactly ONCE!
      expect(networkCallCount).toBe(1);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('serves subsequent requests within 30 seconds from cache without hitting control-plane', async () => {
    let networkCallCount = 0;
    const originalFetch = global.fetch;

    global.fetch = jest.fn(async () => {
      networkCallCount++;
      return {
        ok: true,
        json: async () => ({
          access_token: 'cached-access-token',
          refresh_token: 'cached-refresh-token',
          expires_in: 900,
        }),
      } as unknown as Response;
    });

    try {
      // First call
      const res1 = await refreshSessionWithCoalescing(baseSession);
      expect(res1?.accessToken).toBe('cached-access-token');
      expect(networkCallCount).toBe(1);

      // Second call shortly after (e.g. 500ms) with the old session
      const res2 = await refreshSessionWithCoalescing(baseSession);
      expect(res2?.accessToken).toBe('cached-access-token');
      // No extra network call!
      expect(networkCallCount).toBe(1);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
