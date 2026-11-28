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
    if (!challenge || challenge.type !== 'totp') {
      return NextResponse.json(
        { error: 'CHALLENGE_EXPIRED', message: 'MFA challenge expired or not found. Please log in again.' },
        { status: 400 },
      );
    }

    const cpUrl = (process.env.CONTROL_PLANE_URL || 'http://control-plane:3100').replace(/\/+$/, '');

    const mfaRes = await fetch(`${cpUrl}/v1/auth/totp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        challenge_token: challenge.challengeToken,
        code: body.code,
      }),
    });

    const mfaData = await mfaRes.json();
    if (!mfaRes.ok) {
      return NextResponse.json(mfaData, { status: mfaRes.status });
    }

    // MFA succeeded - clear the temporary challenge cookie
    await clearAuthChallengeCookie();

    const { access_token, refresh_token, expires_in } = mfaData;

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
        isPlatformAdmin: true,
      },
      roles: meData.roles || ['platform_admin'],
      perms: meData.perms || ['*'],
    });

    return NextResponse.json({
      success: true,
      is_platform_admin: true,
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'SERVER_ERROR', message: String(err) },
      { status: 500 },
    );
  }
}
