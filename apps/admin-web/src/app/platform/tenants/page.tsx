'use client';

import * as React from 'react';
import Link from 'next/link';
import { Badge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@iteso/ui';
import { t } from '@/lib/i18n';

interface Tenant {
  id: string;
  code: string;
  displayName: string;
  status: string;
  memberCount?: number;
  member_count?: number;
  createdAt: string;
}

export default function TenantsPage() {
  const [tenants, setTenants] = React.useState<Tenant[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);

  React.useEffect(() => {
    fetch('/api/platform/tenants')
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) {
          setTenants(data);
        }
      })
      .finally(() => setIsLoading(false));
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
            {t('platform.tenants.title')}
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Tổng cộng {tenants.length} doanh nghiệp đã đăng ký trên hệ thống
          </p>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
        {isLoading ? (
          <div className="p-8 text-center text-sm text-slate-500">Đang tải danh sách doanh nghiệp...</div>
        ) : tenants.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">Chưa có doanh nghiệp nào</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('platform.tenants.code')}</TableHead>
                <TableHead>{t('platform.tenants.name')}</TableHead>
                <TableHead>{t('platform.tenants.status')}</TableHead>
                <TableHead>{t('platform.tenants.members')}</TableHead>
                <TableHead>{t('platform.tenants.createdAt')}</TableHead>
                <TableHead className="text-right">{t('platform.tenants.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tenants.map((tenant) => (
                <TableRow key={tenant.id} data-testid={`tenant-row-${tenant.code}`}>
                  <TableCell className="font-mono font-medium text-slate-900">
                    {tenant.code}
                  </TableCell>
                  <TableCell className="font-medium text-slate-900">
                    {tenant.displayName}
                  </TableCell>
                  <TableCell>
                    <Badge variant={tenant.status === 'active' ? 'success' : 'warning'}>
                      {tenant.status === 'active'
                        ? t('platform.tenants.active')
                        : t('platform.tenants.suspended')}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-slate-600 font-medium">
                    {tenant.memberCount ?? tenant.member_count ?? 0}
                  </TableCell>
                  <TableCell className="text-xs text-slate-500">
                    {tenant.createdAt ? new Date(tenant.createdAt).toLocaleDateString('vi-VN') : '-'}
                  </TableCell>
                  <TableCell className="text-right">
                    <Link
                      href={`/platform/tenants/${tenant.code}/features`}
                      className="inline-flex items-center text-xs font-semibold text-blue-600 hover:text-blue-800 hover:underline"
                      data-testid={`manage-features-link-${tenant.code}`}
                    >
                      {t('platform.tenants.manageFeatures')} →
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
