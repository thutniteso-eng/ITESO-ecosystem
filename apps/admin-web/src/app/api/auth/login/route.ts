import { NextResponse } from 'next/server';
import { validateOrigin } from '@/lib/csrf';
import { setSessionCookie } from '@/lib/session';

export async function POST(req: Request) {
  if (!validateOrigin(req)) {
    return NextResponse.json({ error: 'CSRF_ORIGIN_INVALID', message: 'Forbidden' }, { status: 403 });
  }

  try {
    const body = await req.json();
    const cpUrl = (process.env.CONTROL_PLANE_URL || 'http://control-plane:3100').replace(/\/+$/, '');

    const loginRes = await fetch(`${cpUrl}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifier: body.identifier,
        password: body.password,
      }),
    });

    const loginData = await loginRes.json();
    if (!loginRes.ok) {
      return NextResponse.json(loginData, { status: loginRes.status });
    }

    // Check if MFA is required (Super Admin)
    if (loginData.next === 'totp' || loginData.requires_mfa) {
      return NextResponse.json({
        requires_mfa: true,
        challenge_token: loginData.challenge_token,
      });
    }

    // Check if tenant selection is required
    if (loginData.next === 'select_tenant' || loginData.requires_tenant_selection) {
      return NextResponse.json({
        requires_tenant_selection: true,
        selection_token: loginData.selection_token,
        tenants: loginData.tenants,
      });
    }

    // Login succeeded with tokens
    const { access_token, refresh_token, expires_in } = loginData;

    // Fetch user profile from /v1/me
    const meRes = await fetch(`${cpUrl}/v1/me`, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const meData = await meRes.json();

    if (!meRes.ok) {
      return NextResponse.json({ error: 'FAILED_USER_INFO' }, { status: 500 });
    }

    await setSessionCookie({
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresAt: Date.now() + (expires_in || 900) * 1000,
      account: {
        id: meData.account.id,
        email: meData.account.email,
        phone: meData.account.phone,
        isPlatformAdmin: Boolean(meData.account.isPlatformAdmin),
      },
      tenant: meData.tenant,
      tenantName: meData.tenantName || meData.tenantDisplayName || meData.tenant,
      roles: meData.roles || [],
      perms: meData.perms || [],
    });

    return NextResponse.json({
      success: true,
      is_platform_admin: Boolean(meData.account.isPlatformAdmin),
      tenant: meData.tenant,
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'SERVER_ERROR', message: String(err) },
      { status: 500 },
    );
  }
}
