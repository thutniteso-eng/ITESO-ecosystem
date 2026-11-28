'use client';

import * as React from 'react';
import { Alert, Badge, Switch } from '@iteso/ui';
import { t } from '@/lib/i18n';

interface FeatureDef {
  key: string;
  group: string;
  description: string;
  implementationStatus: 'available' | 'not_implemented';
  platformEnabled: boolean;
  defaultEnabled: boolean;
}

export default function FeaturesPage() {
  const [features, setFeatures] = React.useState<FeatureDef[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [message, setMessage] = React.useState<string | null>(null);
  const [updatingKey, setUpdatingKey] = React.useState<string | null>(null);

  const fetchFeatures = () => {
    fetch('/api/platform/features')
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) {
          setFeatures(data);
        }
      })
      .finally(() => setIsLoading(false));
  };

  React.useEffect(() => {
    fetchFeatures();
  }, []);

  const handleToggle = async (key: string, enabled: boolean) => {
    setUpdatingKey(key);
    setMessage(null);

    try {
      const res = await fetch('/api/platform/features', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, enabled }),
      });

      if (!res.ok) {
        const err = await res.json();
        setMessage(`Lỗi: ${err.message || 'Không thể cập nhật'}`);
        return;
      }

      setFeatures((prev) =>
        prev.map((f) => (f.key === key ? { ...f, platformEnabled: enabled } : f)),
      );
      setMessage(t('platform.features.successUpdated'));
    } catch {
      setMessage('Lỗi khi gửi yêu cầu cập nhật');
    } finally {
      setUpdatingKey(null);
    }
  };

  // Group features by group
  const grouped = React.useMemo(() => {
    const map = new Map<string, FeatureDef[]>();
    for (const f of features) {
      const list = map.get(f.group) || [];
      list.push(f);
      map.set(f.group, list);
    }
    return Array.from(map.entries());
  }, [features]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
          {t('platform.features.title')}
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Bật hoặc tắt tính năng cho toàn bộ hệ thống. Tính năng chưa có sẽ không thể kích hoạt.
        </p>
      </div>

      {message && (
        <Alert variant={message.startsWith('Lỗi') ? 'error' : 'success'}>
          {message}
        </Alert>
      )}

      {isLoading ? (
        <div className="bg-white p-8 border border-slate-200 rounded-xl text-center text-sm text-slate-500">
          Đang tải danh sách tính năng...
        </div>
      ) : (
        <div className="space-y-6">
          {grouped.map(([groupName, groupFeatures]) => (
            <div
              key={groupName}
              className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm"
            >
              <div className="px-6 py-4 bg-slate-50/70 border-b border-slate-200">
                <h3 className="text-sm font-bold uppercase tracking-wider text-slate-700">
                  Nhóm: {groupName}
                </h3>
              </div>
              <div className="divide-y divide-slate-100">
                {groupFeatures.map((f) => {
                  const isImplemented = f.implementationStatus === 'available';
                  return (
                    <div
                      key={f.key}
                      className="p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-slate-50/50 transition-colors"
                      data-testid={`feature-row-${f.key}`}
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm font-semibold text-slate-900">
                            {f.key}
                          </span>
                          {!isImplemented ? (
                            <Badge variant="neutral" data-testid={`badge-not-implemented-${f.key}`}>
                              {t('platform.features.notImplemented')}
                            </Badge>
                          ) : (
                            <Badge variant="success">
                              {t('platform.features.available')}
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-slate-600">{f.description}</p>
                      </div>

                      <div className="flex items-center gap-3">
                        <Switch
                          id={`toggle-${f.key}`}
                          checked={f.platformEnabled}
                          disabled={!isImplemented || updatingKey === f.key}
                          onChange={(nextChecked) => handleToggle(f.key, nextChecked)}
                          label={f.platformEnabled ? 'Đang bật' : 'Đang tắt'}
                          data-testid={`platform-feature-switch-${f.key}`}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
