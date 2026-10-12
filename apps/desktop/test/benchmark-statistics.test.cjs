const test = require('node:test');
const assert = require('node:assert/strict');
const { summary } = require('../scripts/benchmark-real-workspace.cjs');
test('benchmark reports nearest-rank percentiles without mutating input', () => {
  const samples = Array.from({ length: 20 }, (_, i) => 20 - i);
  assert.deepEqual(summary(samples), { samples: 20, medianMs: 10, p95Ms: 19, maxMs: 20 });
  assert.equal(samples[0], 20);
});
