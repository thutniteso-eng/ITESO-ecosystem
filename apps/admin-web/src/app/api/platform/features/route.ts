import { NextResponse } from 'next/server';
import { validateOrigin } from '@/lib/csrf';
import { getSession } from '@/lib/session';

export async function GET() {
  const session = await getSession();
  if (!session || !session.account.isPlatformAdmin) {
    return NextResponse.json({ error: 'FORBIDDEN', message: 'Platform admin required' }, { status: 403 });
  }

  const cpUrl = (process.env.CONTROL_PLANE_URL || 'http://control-plane:3100').replace(/\/+$/, '');
  const res = await fetch(`${cpUrl}/admin/features`, {
    headers: { Authorization: `Bearer ${session.accessToken}` },
  });

  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}

export async function PUT(req: Request) {
  if (!validateOrigin(req)) {
    return NextResponse.json({ error: 'CSRF_ORIGIN_INVALID' }, { status: 403 });
  }

  const session = await getSession();
  if (!session || !session.account.isPlatformAdmin) {
    return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 });
  }

  const body = await req.json();
  const { key, enabled, note } = body;
  const cpUrl = (process.env.CONTROL_PLANE_URL || 'http://control-plane:3100').replace(/\/+$/, '');

  const res = await fetch(`${cpUrl}/admin/features/${key}/platform`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.accessToken}`,
    },
    body: JSON.stringify({ enabled, note }),
  });

  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
