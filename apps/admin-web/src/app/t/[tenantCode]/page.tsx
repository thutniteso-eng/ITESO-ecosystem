import { getSession } from '@/lib/session';
import { Badge } from '@iteso/ui';
import { t } from '@/lib/i18n';

export default async function TenantGreetingPage({
  params,
}: {
  params: Promise<{ tenantCode: string }>;
}) {
  const { tenantCode } = await params;
  const session = await getSession();

  let enabledFeatures: string[] = [];
  if (session?.accessToken) {
    const gwUrl = (process.env.GATEWAY_URL || 'http://gateway:3000').replace(/\/+$/, '');
    try {
      const res = await fetch(`${gwUrl}/v1/features`, {
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          'X-Tenant': tenantCode,
        },
      });
      if (res.ok) {
        const data = await res.json();
        enabledFeatures = data.features || [];
      }
    } catch {
      enabledFeatures = [];
    }
  }

  const userName = session?.account.email || session?.account.phone || 'Người dùng';
  const businessName = session?.tenantName || tenantCode;
  const roleName = session?.roles?.join(', ') || 'Thành viên';

  return (
    <div className="space-y-6" data-testid="tenant-greeting-container">
      {/* Welcome Banner */}
      <div className="bg-gradient-to-r from-blue-600 to-indigo-700 rounded-2xl p-6 sm:p-8 text-white shadow-sm">
        <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">
          {t('tenant.greeting')}, <span data-testid="user-display-name">{userName}</span>!
        </h1>
        <p className="mt-2 text-blue-100 text-sm sm:text-base max-w-2xl">
          {t('tenant.welcome')}{' '}
          <strong className="text-white" data-testid="tenant-display-name">
            {businessName}
          </strong>
          .
        </p>

        <div className="mt-6 flex flex-wrap gap-4 text-xs sm:text-sm">
          <div className="bg-white/10 backdrop-blur-sm px-3.5 py-1.5 rounded-lg border border-white/15">
            <span className="text-blue-200">Vai trò: </span>
            <span className="font-semibold text-white" data-testid="user-role-name">
              {roleName}
            </span>
          </div>
          <div className="bg-white/10 backdrop-blur-sm px-3.5 py-1.5 rounded-lg border border-white/15">
            <span className="text-blue-200">Mã doanh nghiệp: </span>
            <span className="font-semibold text-white font-mono">{tenantCode}</span>
          </div>
        </div>
      </div>

      {/* Enabled Features Card */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
        <div className="mb-4">
          <h2 className="text-lg font-bold text-slate-900 tracking-tight">
            {t('tenant.activeFeatures')}
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            Danh sách tính năng hệ thống đang bật cho doanh nghiệp của bạn
          </p>
        </div>

        {enabledFeatures.length === 0 ? (
          <p className="text-sm text-slate-500">Chưa có tính năng nào được kích hoạt.</p>
        ) : (
          <div className="flex flex-wrap gap-2" data-testid="enabled-features-list">
            {enabledFeatures.map((featKey) => (
              <Badge key={featKey} variant="success" className="px-3 py-1 font-mono text-xs">
                ✓ {featKey}
              </Badge>
            ))}
          </div>
        )}
      </div>

      {/* Coming Soon Notice */}
      <div className="bg-slate-100 border border-slate-200 rounded-xl p-5 text-slate-600 text-sm">
        <div className="font-semibold text-slate-800 mb-1">📢 Thông báo</div>
        <p className="text-xs text-slate-500">{t('tenant.comingSoon')}</p>
      </div>
    </div>
  );
}
