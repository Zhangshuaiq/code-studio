export function thresholdFiring(
  operator: string,
  value: number,
  threshold: number,
) {
  return operator === 'lt' ? value < threshold : value > threshold;
}

export function quotaPercent(used: number, limit: number) {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return 0;
  return Math.min(100, Math.max(0, (used / limit) * 100));
}

export function summarizeStatuses(
  rows: Array<{ status: string; count: number }>,
  successStatuses: string[],
  failureStatuses: string[],
) {
  const statuses = Object.fromEntries(rows.map((row) => [row.status, row.count]));
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const successful = successStatuses.reduce((sum, status) => sum + (statuses[status] ?? 0), 0);
  const failed = failureStatuses.reduce((sum, status) => sum + (statuses[status] ?? 0), 0);
  const completed = successful + failed;
  return { total, successful, failed, successRate: completed ? successful / completed * 100 : 0, statuses };
}
