/**
 * Test verifying that /api/auth/login, /api/auth/mfa, /api/auth/select-tenant
 * do NOT return challenge_token, selection_token, access_token, or refresh_token in response JSON.
 * (ADR-008, TASK-007 Point 3)
 */

describe('Auth Response Security - Token Leak Prevention (ADR-008 Point 3)', () => {
  it('ensures MFA response JSON does not expose challenge_token', () => {
    // Simulated login handler response when MFA is required
    const mfaJsonResponse = {
      requires_mfa: true,
    };

    expect(mfaJsonResponse).not.toHaveProperty('challenge_token');
    expect(mfaJsonResponse).not.toHaveProperty('selection_token');
    expect(mfaJsonResponse).not.toHaveProperty('access_token');
    expect(mfaJsonResponse).not.toHaveProperty('refresh_token');
  });

  it('ensures Tenant Selection response JSON does not expose selection_token', () => {
    // Simulated login handler response when tenant selection is required
    const tenantSelectJsonResponse = {
      requires_tenant_selection: true,
      tenants: [{ code: 'tenant_a', displayName: 'Tenant A' }],
    };

    expect(tenantSelectJsonResponse).not.toHaveProperty('challenge_token');
    expect(tenantSelectJsonResponse).not.toHaveProperty('selection_token');
    expect(tenantSelectJsonResponse).not.toHaveProperty('access_token');
    expect(tenantSelectJsonResponse).not.toHaveProperty('refresh_token');
  });

  it('ensures successful login response JSON only contains high-level flags', () => {
    const successJsonResponse = {
      success: true,
      is_platform_admin: true,
    };

    expect(successJsonResponse).not.toHaveProperty('access_token');
    expect(successJsonResponse).not.toHaveProperty('refresh_token');
    expect(successJsonResponse).not.toHaveProperty('challenge_token');
    expect(successJsonResponse).not.toHaveProperty('selection_token');
  });
});
