const test = require('node:test');
const assert = require('node:assert/strict');
const { thresholdFiring, quotaPercent, summarizeStatuses } = require('../dist/monitoring/monitoring-calculations');

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
