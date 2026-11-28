import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { PlatformLayoutClient } from './layout.client';

export default async function PlatformLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();

  if (!session) {
    redirect('/login');
  }

  if (!session.account.isPlatformAdmin) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white border border-red-200 rounded-xl p-6 text-center shadow-sm">
          <div className="w-12 h-12 bg-red-100 text-red-600 rounded-full flex items-center justify-center mx-auto mb-4 text-xl font-bold">
            403
          </div>
          <h2 className="text-xl font-bold text-slate-900 mb-2">Không có quyền truy cập</h2>
          <p className="text-sm text-slate-600 mb-6">
            Khu vực này chỉ dành riêng cho Quản trị viên Nền tảng (Super Admin).
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
    <PlatformLayoutClient
      user={{
        name: 'Super Admin',
        email: session.account.email,
        role: 'Quản trị viên nền tảng',
      }}
    >
      {children}
    </PlatformLayoutClient>
  );
}
