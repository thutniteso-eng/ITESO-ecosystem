import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session';

export async function GET(req: Request) {
  const session = await getSession();
  if (!session || !session.account.isPlatformAdmin) {
    return NextResponse.json({ error: 'FORBIDDEN', message: 'Platform admin required' }, { status: 403 });
  }

  const url = new URL(req.url);
  const cpUrl = (process.env.CONTROL_PLANE_URL || 'http://control-plane:3100').replace(/\/+$/, '');

  const queryParams = new URLSearchParams();
  for (const [key, value] of url.searchParams.entries()) {
    queryParams.set(key, value);
  }

  const res = await fetch(`${cpUrl}/admin/audit-log?${queryParams.toString()}`, {
    headers: { Authorization: `Bearer ${session.accessToken}` },
  });

  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
