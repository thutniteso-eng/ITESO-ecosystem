'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';
import { AppLayout } from '@iteso/ui';
import { t } from '@/lib/i18n';

export function PlatformLayoutClient({
  user,
  children,
}: {
  user: { name?: string; email?: string; role?: string };
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  const navigation = [
    {
      label: t('nav.tenants'),
      href: '/platform/tenants',
      active: pathname.startsWith('/platform/tenants'),
      icon: '🏢',
    },
    {
      label: t('nav.features'),
      href: '/platform/features',
      active: pathname === '/platform/features',
      icon: '⚡',
    },
    {
      label: t('nav.auditLog'),
      href: '/platform/audit-log',
      active: pathname === '/platform/audit-log',
      icon: '📋',
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
      brandTitle="ITESO Super Admin"
      onLogout={handleLogout}
    >
      {children}
    </AppLayout>
  );
}
