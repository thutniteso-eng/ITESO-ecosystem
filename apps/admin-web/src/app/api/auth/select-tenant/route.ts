import { NextResponse } from 'next/server';
import { validateOrigin } from '@/lib/csrf';
import { setSessionCookie, getAuthChallengeCookie, clearAuthChallengeCookie } from '@/lib/session';

export async function POST(req: Request) {
  if (!validateOrigin(req)) {
    return NextResponse.json({ error: 'CSRF_ORIGIN_INVALID', message: 'Forbidden' }, { status: 403 });
  }

  try {
    const body = await req.json();
    const challenge = await getAuthChallengeCookie();
    if (!challenge || challenge.type !== 'select_tenant') {
      return NextResponse.json(
        { error: 'CHALLENGE_EXPIRED', message: 'Tenant selection challenge expired or not found. Please log in again.' },
        { status: 400 },
      );
    }

    const cpUrl = (process.env.CONTROL_PLANE_URL || 'http://control-plane:3100').replace(/\/+$/, '');

    const res = await fetch(`${cpUrl}/v1/auth/select-tenant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        selection_token: challenge.selectionToken,
        tenant_code: body.tenant_code || body.tenant,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      return NextResponse.json(data, { status: res.status });
    }

    // Tenant selection succeeded - clear the temporary challenge cookie
    await clearAuthChallengeCookie();

    const { access_token, refresh_token, expires_in } = data;

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
      issuedAt: Date.now(),
      account: {
        id: meData.account.id,
        email: meData.account.email,
        phone: meData.account.phone,
        isPlatformAdmin: false,
      },
      tenant: meData.tenant,
      tenantName: meData.tenantName || meData.tenantDisplayName || meData.tenant,
      roles: meData.roles || [],
      perms: meData.perms || [],
    });

    return NextResponse.json({
      success: true,
      tenant: meData.tenant,
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'SERVER_ERROR', message: String(err) },
      { status: 500 },
    );
  }
}
