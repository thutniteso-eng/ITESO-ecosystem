'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Alert, Badge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@iteso/ui';

interface TenantFeature {
  key: string;
  group: string;
  description: string;
  implementationStatus: string;
  platformEnabled: boolean;
  defaultEnabled: boolean;
  tenantOverride: boolean | null;
  effectiveEnabled: boolean;
}

export default function TenantFeaturesPage() {
  const params = useParams();
  const code = params.code as string;

  const [features, setFeatures] = React.useState<TenantFeature[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [message, setMessage] = React.useState<string | null>(null);
  const [updatingKey, setUpdatingKey] = React.useState<string | null>(null);

  const fetchTenantFeatures = () => {
    fetch(`/api/platform/tenants/${code}/features`)
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) {
          setFeatures(data);
        }
      })
      .finally(() => setIsLoading(false));
  };

  React.useEffect(() => {
    if (code) {
      fetchTenantFeatures();
    }
  }, [code]);

  const handleOverrideChange = async (key: string, value: string) => {
    setUpdatingKey(key);
    setMessage(null);

    let nextOverride: boolean | null = null;
    if (value === 'true') nextOverride = true;
    else if (value === 'false') nextOverride = false;
    else nextOverride = null;

    try {
      const res = await fetch(`/api/platform/tenants/${code}/features`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, enabled: nextOverride }),
      });

      if (!res.ok) {
        const err = await res.json();
        setMessage(`Lỗi: ${err.message || 'Không thể lưu cấu hình'}`);
        return;
      }

      setMessage(`Cập nhật cấu hình tính năng '${key}' thành công`);
      fetchTenantFeatures();
    } catch {
      setMessage('Lỗi khi gửi yêu cầu cập nhật');
    } finally {
      setUpdatingKey(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link
          href="/platform/tenants"
          className="text-sm font-semibold text-slate-500 hover:text-slate-800"
        >
          ← Danh sách doanh nghiệp
        </Link>
      </div>

      <div>
        <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
          Cấu hình tính năng: <span className="font-mono text-blue-600">{code}</span>
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Thiết lập mức ghi đè theo doanh nghiệp: Theo mặc định, Bật, hoặc Tắt.
        </p>
      </div>

      {message && (
        <Alert variant={message.startsWith('Lỗi') ? 'error' : 'success'}>
          {message}
        </Alert>
      )}

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
        {isLoading ? (
          <div className="p-8 text-center text-sm text-slate-500">
            Đang tải danh sách tính năng doanh nghiệp...
          </div>
        ) : (
          <Table className="w-full">
            <TableHeader className="hidden md:table-header-group">
              <TableRow>
                <TableHead>Mã tính năng</TableHead>
                <TableHead>Mô tả</TableHead>
                <TableHead>Hiệu lực thực tế</TableHead>
                <TableHead>Lựa chọn ghi đè</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="block md:table-row-group divide-y divide-slate-200 md:divide-none">
              {features.map((f) => {
                const selectValue =
                  f.tenantOverride === true
                    ? 'true'
                    : f.tenantOverride === false
                    ? 'false'
                    : 'default';

                return (
                  <TableRow
                    key={f.key}
                    data-testid={`tenant-feature-row-${f.key}`}
                    className="block md:table-row p-4 space-y-2.5 md:space-y-0 hover:bg-slate-50/50"
                  >
                    <TableCell className="block md:table-cell font-mono text-sm font-semibold text-slate-900 py-1 md:py-3.5">
                      {f.key}
                    </TableCell>
                    <TableCell className="block md:table-cell text-xs md:text-sm text-slate-600 py-1 md:py-3.5">
                      {f.description}
                    </TableCell>
                    <TableCell className="block md:table-cell py-1 md:py-3.5">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-slate-500 font-medium md:hidden">Hiệu lực:</span>
                        <Badge
                          variant={f.effectiveEnabled ? 'success' : 'neutral'}
                          data-testid={`effective-badge-${f.key}`}
                        >
                          {f.effectiveEnabled ? 'Đang Bật' : 'Đang Tắt'}
                        </Badge>
                      </div>
                    </TableCell>
                    <TableCell className="block md:table-cell pt-2 md:pt-3.5">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between md:justify-start gap-1.5 md:gap-3">
                        <span className="text-xs text-slate-700 font-semibold md:hidden">Lựa chọn ghi đè:</span>
                        <select
                          value={selectValue}
                          disabled={updatingKey === f.key}
                          onChange={(e) => handleOverrideChange(f.key, e.target.value)}
                          className="w-full md:w-auto px-3 py-2 border border-slate-300 rounded-md text-xs font-medium bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                          data-testid={`override-select-${f.key}`}
                        >
                          <option value="default">Theo mặc định</option>
                          <option value="true">Bật</option>
                          <option value="false">Tắt</option>
                        </select>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
