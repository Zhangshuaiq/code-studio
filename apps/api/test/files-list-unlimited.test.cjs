const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { FilesService } = require('../dist/files/files.service.js');

test('file tree lists later directories even after the first directory has over 500 files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'files-list-unlimited-'));
  try {
    await mkdir(join(root, 'fronted', 'public'), { recursive: true });
    await mkdir(join(root, 'fronted', 'src'), { recursive: true });
    await mkdir(join(root, 'fx-server'), { recursive: true });
    await Promise.all(Array.from({ length: 510 }, (_, index) => writeFile(join(root, 'fronted', 'public', `asset-${index}.svg`), '')));
    await writeFile(join(root, 'fronted', 'src', 'main.js'), '');
    await writeFile(join(root, 'fx-server', 'pom.xml'), '');
    const service = new FilesService(
      { requireSession: async () => ({ project: { name: 'test' } }) },
      { ensureForSession: async () => ({ path: root }) },
      {},
    );
    const files = await service.list('user', 'session');
    assert.equal(files.length, 512);
    assert.ok(files.includes('fronted/src/main.js'));
    assert.ok(files.includes('fx-server/pom.xml'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
