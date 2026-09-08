const test = require('node:test');
const assert = require('node:assert/strict');
const { thresholdFiring, quotaPercent, summarizeStatuses } = require('../dist/monitoring/monitoring-calculations');
const { ApiMetricsService } = require('../dist/api-metrics/api-metrics.service');

test('threshold comparisons preserve strict boundary semantics', () => {
  assert.equal(thresholdFiring('lt', 98.9, 99), true);
  assert.equal(thresholdFiring('lt', 99, 99), false);
  assert.equal(thresholdFiring('gt', 1001, 1000), true);
  assert.equal(thresholdFiring('gt', 1000, 1000), false);
});

test('quota percentage is bounded and handles disabled limits', () => {
  assert.equal(quotaPercent(50, 100), 50);
  assert.equal(quotaPercent(120, 100), 100);
  assert.equal(quotaPercent(10, 0), 0);
});

test('status summary excludes unfinished states from success rate', () => {
  const result = summarizeStatuses(
    [{ status: 'succeeded', count: 8 }, { status: 'failed', count: 2 }, { status: 'running', count: 3 }],
    ['succeeded'],
    ['failed'],
  );
  assert.equal(result.total, 13);
  assert.equal(result.successRate, 80);
  assert.equal(result.statuses.running, 3);
});

test('API metrics aggregate success rate, latency and normalized route rows', () => {
  const metrics = new ApiMetricsService();
  metrics.record('GET', '/api/projects', 200, 20);
  metrics.record('GET', '/api/projects', 500, 80);
  metrics.record('POST', '/api/agent/run', 201, 40);
  const result = metrics.metrics(15);
  assert.equal(result.total, 3);
  assert.equal(result.successful, 2);
  assert.equal(result.failed, 1);
  assert.equal(Math.round(result.successRate * 100) / 100, 66.67);
  assert.equal(result.averageLatencyMs, 140 / 3);
  assert.equal(result.p95LatencyMs, 80);
  assert.equal(result.routes[0].route, 'GET /api/projects');
});
