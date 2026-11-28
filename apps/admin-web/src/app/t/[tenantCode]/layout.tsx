import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { TenantLayoutClient } from './layout.client';

export default async function TenantLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ tenantCode: string }>;
}) {
  const session = await getSession();
  const { tenantCode } = await params;

  if (!session) {
    redirect('/login');
  }

  // Super Admin entering tenant area is redirected to /platform
  if (session.account.isPlatformAdmin) {
    redirect('/platform');
  }

  // Tenant mismatch: 403 Forbidden
  if (session.tenant !== tenantCode) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white border border-red-200 rounded-xl p-6 text-center shadow-sm">
          <div className="w-12 h-12 bg-red-100 text-red-600 rounded-full flex items-center justify-center mx-auto mb-4 text-xl font-bold">
            403
          </div>
          <h2 className="text-xl font-bold text-slate-900 mb-2">Không có quyền truy cập</h2>
          <p className="text-sm text-slate-600 mb-6">
            Tài khoản của bạn không thuộc doanh nghiệp &apos;{tenantCode}&apos;.
          </p>
          <a
            href={session.tenant ? `/t/${session.tenant}` : '/login'}
            className="inline-flex items-center justify-center px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700"
          >
            Quay lại trang của bạn
          </a>
        </div>
      </div>
    );
  }

  return (
    <TenantLayoutClient
      tenantCode={tenantCode}
      user={{
        name: session.account.email || session.account.phone || 'Người dùng',
        email: session.account.email,
        role: session.roles?.join(', ') || 'Thành viên',
        tenantName: session.tenantName || tenantCode,
      }}
    >
      {children}
    </TenantLayoutClient>
  );
}
