'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';
import { AppLayout } from '@iteso/ui';
import { BarChart3, Users, Smartphone, Settings } from 'lucide-react';
import { t } from '@/lib/i18n';

export function TenantLayoutClient({
  tenantCode,
  user,
  children,
}: {
  tenantCode: string;
  user: { name?: string; email?: string; role?: string; tenantName?: string };
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  const navigation = [
    {
      label: t('nav.overview'),
      href: `/t/${tenantCode}`,
      active: pathname === `/t/${tenantCode}`,
      icon: <BarChart3 className="w-4 h-4" />,
    },
    {
      label: t('nav.staff'),
      href: '#staff',
      badge: 'Sắp có',
      disabled: true,
      icon: <Users className="w-4 h-4" />,
    },
    {
      label: t('nav.pos'),
      href: '#pos',
      badge: 'Sắp có',
      disabled: true,
      icon: <Smartphone className="w-4 h-4" />,
    },
    {
      label: t('nav.settings'),
      href: '#settings',
      badge: 'Sắp có',
      disabled: true,
      icon: <Settings className="w-4 h-4" />,
    },
  ];

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      window.location.href = '/login';
    }
  };

  return (
    <AppLayout
      user={user}
      navigation={navigation}
      brandTitle={user.tenantName || `Doanh nghiệp ${tenantCode}`}
      onLogout={handleLogout}
    >
      {children}
    </AppLayout>
  );
}
