describe('Audit Log Pagination Logic (TASK-007)', () => {
  function paginate<T>(items: T[], page: number, limit: number) {
    const p = Math.max(1, page);
    const l = Math.max(1, Math.min(100, limit));
    const offset = (p - 1) * l;
    const data = items.slice(offset, offset + l);
    const total = items.length;
    const totalPages = Math.ceil(total / l);

    return {
      data,
      total,
      page: p,
      limit: l,
      totalPages,
    };
  }

  const mockLogs = Array.from({ length: 125 }, (_, i) => ({
    id: `log-${i + 1}`,
    action: i % 2 === 0 ? 'UPDATE_TENANT_FEATURE' : 'UPDATE_PLATFORM_FEATURE',
    createdAt: new Date(Date.now() - i * 60000).toISOString(),
  }));

  it('correctly partitions into 50 items per page', () => {
    const page1 = paginate(mockLogs, 1, 50);
    expect(page1.data).toHaveLength(50);
    expect(page1.total).toBe(125);
    expect(page1.totalPages).toBe(3);
    expect(page1.data[0].id).toBe('log-1');

    const page2 = paginate(mockLogs, 2, 50);
    expect(page2.data).toHaveLength(50);
    expect(page2.data[0].id).toBe('log-51');

    const page3 = paginate(mockLogs, 3, 50);
    expect(page3.data).toHaveLength(25);
    expect(page3.data[0].id).toBe('log-101');
  });

  it('handles out of bounds page numbers gracefully', () => {
    const pageNegative = paginate(mockLogs, -5, 50);
    expect(pageNegative.page).toBe(1);
    expect(pageNegative.data).toHaveLength(50);

    const pageBeyond = paginate(mockLogs, 10, 50);
    expect(pageBeyond.data).toHaveLength(0);
    expect(pageBeyond.total).toBe(125);
    expect(pageBeyond.totalPages).toBe(3);
  });
});
