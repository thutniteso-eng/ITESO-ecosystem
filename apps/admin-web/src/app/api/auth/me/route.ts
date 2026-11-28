import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session';

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }

  return NextResponse.json({
    authenticated: true,
    account: session.account,
    tenant: session.tenant,
    tenantName: session.tenantName,
    roles: session.roles,
    perms: session.perms,
  });
}
