'use client';

import * as React from 'react';
import { cn } from './utils';
import { Button } from './button';

export interface NavItem {
  label: string;
  href: string;
  icon?: React.ReactNode;
  active?: boolean;
  badge?: string;
  disabled?: boolean;
}

export interface AppLayoutProps {
  user: {
    name?: string;
    email?: string;
    role?: string;
    tenantName?: string;
  };
  navigation: NavItem[];
  children: React.ReactNode;
  onLogout?: () => void;
  brandTitle?: string;
}

export const AppLayout: React.FC<AppLayoutProps> = ({
  user,
  navigation,
  children,
  onLogout,
  brandTitle = 'ITESO Platform',
}) => {
  const [mobileMenuOpen, setMobileMenuOpen] = React.useState(false);

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col md:flex-row">
      {/* Mobile Top Header */}
      <header className="md:hidden bg-white border-b border-slate-200 px-4 py-3 flex items-center justify-between sticky top-0 z-20">
        <div className="flex items-center gap-2">
          <span className="font-bold text-slate-900 tracking-tight">{brandTitle}</span>
        </div>
        <button
          type="button"
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          className="p-2 text-slate-600 hover:text-slate-900 focus:outline-none"
          aria-label="Toggle Navigation"
        >
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            {mobileMenuOpen ? (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            )}
          </svg>
        </button>
      </header>

      {/* Sidebar for Desktop & Mobile Overlay */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-30 w-64 bg-slate-900 text-slate-200 flex flex-col transition-transform duration-200 ease-in-out md:static md:translate-x-0',
          mobileMenuOpen ? 'translate-x-0 shadow-xl' : '-translate-x-full',
        )}
      >
        {/* Brand header */}
        <div className="p-5 border-b border-slate-800 flex items-center justify-between">
          <span className="text-lg font-bold text-white tracking-wide">{brandTitle}</span>
          <button
            onClick={() => setMobileMenuOpen(false)}
            className="md:hidden text-slate-400 hover:text-white"
          >
            ✕
          </button>
        </div>

        {/* User preview */}
        <div className="p-4 border-b border-slate-800/60 bg-slate-950/40">
          <div className="text-sm font-semibold text-white truncate">
            {user.name || user.email || 'Người dùng'}
          </div>
          {user.tenantName && (
            <div className="text-xs text-blue-400 font-medium truncate mt-0.5">
              🏢 {user.tenantName}
            </div>
          )}
          {user.role && (
            <div className="text-xs text-slate-400 truncate mt-0.5">
              Vai trò: {user.role}
            </div>
          )}
        </div>

        {/* Navigation Items */}
        <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
          {navigation.map((item, idx) => (
            <a
              key={idx}
              href={item.disabled ? '#' : item.href}
              onClick={() => setMobileMenuOpen(false)}
              className={cn(
                'flex items-center justify-between px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                item.active
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-300 hover:bg-slate-800 hover:text-white',
                item.disabled && 'opacity-40 cursor-not-allowed hover:bg-transparent hover:text-slate-300',
              )}
            >
              <span className="flex items-center gap-2.5">
                {item.icon && <span>{item.icon}</span>}
                <span>{item.label}</span>
              </span>
              {item.badge && (
                <span className="text-xs px-2 py-0.5 bg-slate-800 text-slate-400 rounded-full">
                  {item.badge}
                </span>
              )}
            </a>
          ))}
        </nav>

        {/* Logout button at bottom */}
        {onLogout && (
          <div className="p-4 border-t border-slate-800">
            <Button
              variant="outline"
              size="sm"
              onClick={onLogout}
              className="w-full text-slate-300 border-slate-700 bg-slate-800 hover:bg-slate-700 hover:text-white"
              data-testid="logout-button"
            >
              Đăng xuất
            </Button>
          </div>
        )}
      </aside>

      {/* Backdrop for mobile */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-20 md:hidden"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      {/* Main Content Area */}
      <main className="flex-1 p-4 md:p-8 max-w-7xl w-full mx-auto overflow-x-hidden">
        {children}
      </main>
    </div>
  );
};
