import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
  decryptSession,
  encryptSession,
  SESSION_COOKIE_NAME,
  isTokenExpiring,
  refreshSessionWithCoalescing,
} from '@/lib/session';

export async function middleware(request: NextRequest) {
  const sessionCookie = request.cookies.get(SESSION_COOKIE_NAME);
  if (!sessionCookie?.value) {
    return NextResponse.next();
  }

  const session = decryptSession(sessionCookie.value);
  if (!session) {
    return NextResponse.next();
  }

  // Check if token is nearing expiration or expired
  if (isTokenExpiring(session)) {
    const refreshed = await refreshSessionWithCoalescing(session);
    if (!refreshed) {
      // If refresh failed (e.g. revoked refresh token)
      if (request.nextUrl.pathname.startsWith('/api/')) {
        const response = NextResponse.json(
          { error: 'UNAUTHORIZED', message: 'Session expired' },
          { status: 401 },
        );
        response.cookies.set(SESSION_COOKIE_NAME, '', { maxAge: 0, path: '/' });
        return response;
      }
      const response = NextResponse.redirect(new URL('/login', request.url));
      response.cookies.set(SESSION_COOKIE_NAME, '', { maxAge: 0, path: '/' });
      return response;
    }

    // Refresh succeeded: update cookie on both request headers and response
    const newEncrypted = encryptSession(refreshed);
    const isProd = process.env.NODE_ENV === 'production';
    const isSecure = isProd || process.env.COOKIE_SECURE === 'true';

    request.cookies.set(SESSION_COOKIE_NAME, newEncrypted);
    const response = NextResponse.next({
      request: {
        headers: request.headers,
      },
    });

    response.cookies.set(SESSION_COOKIE_NAME, newEncrypted, {
      httpOnly: true,
      secure: isSecure,
      sameSite: 'strict',
      path: '/',
      maxAge: 12 * 60 * 60,
    });

    return response;
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/platform/:path*', '/t/:path*', '/api/:path*'],
};
