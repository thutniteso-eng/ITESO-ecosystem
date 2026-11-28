import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session';

export async function GET() {
  const session = await getSession();
  if (!session || !session.account.isPlatformAdmin) {
    return NextResponse.json({ error: 'FORBIDDEN', message: 'Platform admin required' }, { status: 403 });
  }

  const cpUrl = (process.env.CONTROL_PLANE_URL || 'http://control-plane:3100').replace(/\/+$/, '');
  const res = await fetch(`${cpUrl}/admin/tenants`, {
    headers: { Authorization: `Bearer ${session.accessToken}` },
  });

  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
