'use client';

import * as React from 'react';
import { Button, Input, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@iteso/ui';
import { t } from '@/lib/i18n';

interface AuditRow {
  id: string;
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  note?: string;
  createdAt: string;
}

export default function AuditLogPage() {
  const [logs, setLogs] = React.useState<AuditRow[]>([]);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [totalPages, setTotalPages] = React.useState(1);
  const [isLoading, setIsLoading] = React.useState(true);

  // Filters
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');
  const [actor, setActor] = React.useState('');
  const [action, setAction] = React.useState('');

  const fetchLogs = (targetPage = page) => {
    setIsLoading(true);
    const params = new URLSearchParams();
    params.set('page', String(targetPage));
    params.set('limit', '50');
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (actor) params.set('actor', actor);
    if (action) params.set('action', action);

    fetch(`/api/platform/audit-log?${params.toString()}`)
      .then((res) => res.json())
      .then((data) => {
        if (data && Array.isArray(data.data)) {
          setLogs(data.data);
          setTotal(data.total || 0);
          setPage(data.page || 1);
          setTotalPages(data.totalPages || 1);
        }
      })
      .finally(() => setIsLoading(false));
  };

  React.useEffect(() => {
    fetchLogs(page);
  }, [page]);

  const handleFilterSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    fetchLogs(1);
  };

  const handleReset = () => {
    setFrom('');
    setTo('');
    setActor('');
    setAction('');
    setPage(1);
    setIsLoading(true);
    fetch('/api/platform/audit-log?page=1&limit=50')
      .then((res) => res.json())
      .then((data) => {
        if (data && Array.isArray(data.data)) {
          setLogs(data.data);
          setTotal(data.total || 0);
          setPage(1);
          setTotalPages(data.totalPages || 1);
        }
      })
      .finally(() => setIsLoading(false));
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
          {t('platform.audit.title')}
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Theo dõi toàn bộ thao tác thay đổi cấu hình, tính năng và phân quyền hệ thống (50 dòng/trang)
        </p>
      </div>

      {/* Filter Card */}
      <form
        onSubmit={handleFilterSubmit}
        className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 items-end"
        data-testid="audit-filter-form"
      >
        <Input
          label={t('platform.audit.from')}
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          data-testid="audit-filter-from"
        />
        <Input
          label={t('platform.audit.to')}
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          data-testid="audit-filter-to"
        />
        <Input
          label={t('platform.audit.actor')}
          placeholder="admin@platform.local"
          value={actor}
          onChange={(e) => setActor(e.target.value)}
          data-testid="audit-filter-actor"
        />
        <Input
          label={t('platform.audit.action')}
          placeholder="UPDATE_TENANT_FEATURE"
          value={action}
          onChange={(e) => setAction(e.target.value)}
          data-testid="audit-filter-action"
        />
        <div className="sm:col-span-2 md:col-span-4 flex items-center gap-2 pt-2">
          <Button type="submit" size="sm" data-testid="audit-filter-submit">
            {t('platform.audit.search')}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={handleReset}>
            {t('platform.audit.reset')}
          </Button>
        </div>
      </form>

      {/* Audit Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
        {isLoading ? (
          <div className="p-8 text-center text-sm text-slate-500">Đang tải nhật ký...</div>
        ) : logs.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">
            {t('platform.audit.empty')}
          </div>
        ) : (
          <Table className="w-full">
            <TableHeader className="hidden md:table-header-group">
              <TableRow>
                <TableHead>{t('platform.audit.time')}</TableHead>
                <TableHead>{t('platform.audit.actor')}</TableHead>
                <TableHead>{t('platform.audit.action')}</TableHead>
                <TableHead>{t('platform.audit.target')}</TableHead>
                <TableHead>{t('platform.audit.note')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="block md:table-row-group divide-y divide-slate-200 md:divide-none">
              {logs.map((log) => (
                <TableRow
                  key={log.id}
                  data-testid={`audit-log-row-${log.id}`}
                  className="block md:table-row p-4 space-y-1.5 md:space-y-0 hover:bg-slate-50/50"
                >
                  <TableCell className="block md:table-cell text-xs font-mono text-slate-500 py-1 md:py-3.5">
                    <span className="text-slate-400 font-sans md:hidden mr-2">Thời gian:</span>
                    {new Date(log.createdAt).toLocaleString('vi-VN')}
                  </TableCell>
                  <TableCell className="block md:table-cell text-xs font-semibold text-slate-800 py-1 md:py-3.5">
                    <span className="text-slate-400 font-normal md:hidden mr-2">Người thực hiện:</span>
                    {log.actor}
                  </TableCell>
                  <TableCell className="block md:table-cell text-xs font-mono font-medium text-blue-600 py-1 md:py-3.5">
                    <span className="text-slate-400 font-sans font-normal md:hidden mr-2">Hành động:</span>
                    {log.action}
                  </TableCell>
                  <TableCell className="block md:table-cell text-xs font-mono text-slate-700 py-1 md:py-3.5">
                    <span className="text-slate-400 font-sans font-normal md:hidden mr-2">Đối tượng:</span>
                    {log.targetType}:{log.targetId}
                  </TableCell>
                  <TableCell className="block md:table-cell text-xs text-slate-500 py-1 md:py-3.5">
                    <span className="text-slate-400 md:hidden mr-2">Ghi chú:</span>
                    {log.note || '-'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {/* Pagination Bar */}
        <div className="px-6 py-4 border-t border-slate-100 flex items-center justify-between">
          <span className="text-xs text-slate-500">
            Tổng cộng {total} dòng • Trang {page} / {totalPages || 1}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1 || isLoading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              data-testid="audit-pagination-prev"
            >
              ← {t('platform.audit.prev')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages || isLoading}
              onClick={() => setPage((p) => p + 1)}
              data-testid="audit-pagination-next"
            >
              {t('platform.audit.next')} →
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
