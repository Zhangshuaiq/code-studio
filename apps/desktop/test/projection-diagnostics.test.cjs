const test = require('node:test');
const assert = require('node:assert/strict');
const { projectionDiagnostics } = require('../scripts/projection-diagnostics.cjs');
test('projection evidence requires explicit use/hit markers and bounded numeric statistics', () => {
  const collector = projectionDiagnostics();
  collector.accept('CODE_STUDIO_PACKAGE_PROJ'); collector.accept('ECTION_USED\n');
  assert.equal(collector.result.used, true); assert.equal(collector.result.hit, false);
  collector.accept('CODE_STUDIO_PACKAGE_PROJECTION_HIT\n');
  const stats = { calls: 10, hits: 8, misses: 2, invalidations: 0, evictions: 0, entries: 2, retainedNamesUpperBound: 5, retainedCharsUpperBound: 25 };
  collector.accept('CODE_STUDIO_PACKAGE_PROJECTION_STATS ' + JSON.stringify(stats).slice(0, 20));
  collector.accept(JSON.stringify(stats).slice(20) + '\n');
  assert.deepEqual(collector.result.stats, stats);
  const invalid = projectionDiagnostics();
  invalid.accept('CODE_STUDIO_PACKAGE_PROJECTION_STATS {"hits":-1}\n');
  assert.equal(invalid.result.stats, null);
  assert.equal(invalid.result.used, false);
});
