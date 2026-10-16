const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeClasspaths, parseGcStats } = require('../scripts/java-startup-diagnostics.cjs');
test('dependency reuse across modules is not misreported as duplicate entries within a project', () => {
  const result = summarizeClasspaths([
    { classpaths: ['/repo/a.jar', '/repo/alias.jar', '/project/classes'], modulepaths: [] },
    { classpaths: ['/repo/a.jar', '/repo/b.jar'], modulepaths: ['/repo/c.jar'] },
  ], file => file.replace('/alias.jar', '/a.jar'));
  assert.deepEqual(result, { projects: 2, jarReferences: 5, distinctJarPaths: 4, distinctCanonicalJars: 3, unresolvedJarPaths: 0, pathAliases: 1, duplicateEntriesWithinProjects: 1 });
});
test('unavailable JAR paths are explicitly reported rather than treated as verified physical files', () => {
  const result = summarizeClasspaths([{ classpaths: ['/missing/a.jar', '/missing/a.jar'] }], () => { throw new Error('missing'); });
  assert.equal(result.unresolvedJarPaths, 1);
  assert.equal(result.distinctJarPaths, 1);
});
test('GC diagnostics accept G1 and Parallel jstat columns without inventing absent counters', () => {
  assert.deepEqual(parseGcStats('S0 S1 E O M CCS YGC YGCT FGC FGCT GCT\n0 1 2 3 4 5 8 0.250 0 0.000 0.250'), { YGC: 8, YGCT: .25, FGC: 0, FGCT: 0, GCT: .25 });
  assert.deepEqual(parseGcStats('YGC YGCT FGC FGCT CGC CGCT GCT\n8 .25 1 .15 2 .1 .5'), { YGC: 8, YGCT: .25, FGC: 1, FGCT: .15, CGC: 2, CGCT: .1, GCT: .5 });
  assert.throws(() => parseGcStats('not a sample'), /Invalid/);
});
