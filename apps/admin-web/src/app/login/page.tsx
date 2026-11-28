'use client';

import * as React from 'react';
import { Button, Input, Alert } from '@iteso/ui';
import { t } from '@/lib/i18n';

export default function LoginPage() {
  const [step, setStep] = React.useState<'credentials' | 'mfa' | 'tenant'>('credentials');
  const [identifier, setIdentifier] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [challengeToken, setChallengeToken] = React.useState('');
  const [otpCode, setOtpCode] = React.useState('');
  const [selectionToken, setSelectionToken] = React.useState('');
  const [tenants, setTenants] = React.useState<Array<{ code: string; displayName?: string; name?: string }>>([]);
  const [selectedTenant, setSelectedTenant] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);

  const handleCredentialsSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, password }),
      });

      const data = await res.json();
      if (!res.ok) {
        if (data.error === 'ACCOUNT_LOCKED') {
          setError(t('login.errors.accountLocked'));
        } else {
          setError(t('login.errors.invalidCredentials'));
        }
        setIsLoading(false);
        return;
      }

      if (data.requires_mfa) {
        setChallengeToken(data.challenge_token);
        setStep('mfa');
        setIsLoading(false);
        return;
      }

      if (data.requires_tenant_selection) {
        setSelectionToken(data.selection_token);
        setTenants(data.tenants || []);
        if (data.tenants?.[0]?.code) {
          setSelectedTenant(data.tenants[0].code);
        }
        setStep('tenant');
        setIsLoading(false);
        return;
      }

      if (data.is_platform_admin) {
        window.location.href = '/platform';
      } else if (data.tenant) {
        window.location.href = `/t/${data.tenant}`;
      } else {
        window.location.href = '/';
      }
    } catch {
      setError(t('login.errors.unknown'));
      setIsLoading(false);
    }
  };

  const handleMfaSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      const res = await fetch('/api/auth/mfa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challenge_token: challengeToken,
          code: otpCode,
        }),
      });

      if (!res.ok) {
        setError(t('login.errors.invalidOtp'));
        setIsLoading(false);
        return;
      }

      window.location.href = '/platform';
    } catch {
      setError(t('login.errors.unknown'));
      setIsLoading(false);
    }
  };

  const handleTenantSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      const res = await fetch('/api/auth/select-tenant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          selection_token: selectionToken,
          tenant_code: selectedTenant,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.message || t('login.errors.unknown'));
        setIsLoading(false);
        return;
      }

      window.location.href = `/t/${data.tenant}`;
    } catch {
      setError(t('login.errors.unknown'));
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white border border-slate-200 shadow-sm rounded-xl p-6 md:p-8">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
            {step === 'mfa'
              ? t('login.mfaTitle')
              : step === 'tenant'
              ? t('login.selectTenantTitle')
              : t('login.title')}
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            {step === 'mfa'
              ? t('login.mfaSubtitle')
              : step === 'tenant'
              ? t('login.selectTenantSubtitle')
              : t('login.subtitle')}
          </p>
        </div>

        {error && (
          <Alert variant="error" className="mb-5" data-testid="login-error-alert">
            {error}
          </Alert>
        )}

        {step === 'credentials' && (
          <form onSubmit={handleCredentialsSubmit} className="space-y-4">
            <Input
              id="identifier-input"
              label={t('login.identifier')}
              placeholder={t('login.identifierPlaceholder')}
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              required
              autoFocus
              data-testid="identifier-input"
            />
            <Input
              id="password-input"
              type="password"
              label={t('login.password')}
              placeholder={t('login.passwordPlaceholder')}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              data-testid="password-input"
            />
            <Button
              type="submit"
              isLoading={isLoading}
              className="w-full mt-2"
              data-testid="login-submit-button"
            >
              {t('login.submit')}
            </Button>
          </form>
        )}

        {step === 'mfa' && (
          <form onSubmit={handleMfaSubmit} className="space-y-4">
            <Input
              id="otp-input"
              label={t('login.mfaCode')}
              placeholder={t('login.mfaCodePlaceholder')}
              value={otpCode}
              onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              maxLength={6}
              required
              autoFocus
              data-testid="otp-input"
            />
            <Button
              type="submit"
              isLoading={isLoading}
              className="w-full mt-2"
              data-testid="mfa-submit-button"
            >
              {t('login.mfaSubmit')}
            </Button>
            <button
              type="button"
              onClick={() => {
                setStep('credentials');
                setError(null);
                setOtpCode('');
              }}
              className="w-full text-center text-xs text-slate-500 hover:text-slate-800 pt-2"
            >
              ← Quay lại đăng nhập
            </button>
          </form>
        )}

        {step === 'tenant' && (
          <form onSubmit={handleTenantSubmit} className="space-y-4">
            <div>
              <label htmlFor="tenant-select" className="block text-sm font-medium text-slate-700 mb-1">
                Chọn doanh nghiệp
              </label>
              <select
                id="tenant-select"
                value={selectedTenant}
                onChange={(e) => setSelectedTenant(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                data-testid="tenant-select"
              >
                {tenants.map((t) => (
                  <option key={t.code} value={t.code}>
                    {t.displayName || t.name || t.code} ({t.code})
                  </option>
                ))}
              </select>
            </div>
            <Button
              type="submit"
              isLoading={isLoading}
              className="w-full mt-2"
              data-testid="tenant-submit-button"
            >
              {t('login.selectTenantSubmit')}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
