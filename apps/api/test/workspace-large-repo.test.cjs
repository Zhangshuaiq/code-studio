const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { assertWorkspaceChanges, assertWorkspaceWithinLimits } = require('../dist/common/workspace-quota.js');

test('an existing large workspace does not block an ordinary file save', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-large-repo-'));
  try {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'large.txt'), Buffer.alloc(3 * 1024 * 1024));
    const legacyLimits = { maxFiles: 1, maxFileBytes: 1024, maxSourceBytes: 1024 };
    await assertWorkspaceWithinLimits(root, legacyLimits);
    assert.deepEqual(await assertWorkspaceChanges(root, [{ path: 'src/new.txt', bytes: 2048 }], legacyLimits), [{ path: 'src/new.txt', bytes: 2048 }]);
    await assert.rejects(assertWorkspaceChanges(root, [{ path: '../outside.txt', bytes: 1 }], legacyLimits), { code: 'invalid_path' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
