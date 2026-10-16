const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { LocalLspManager } = require('@codegen/code-intelligence');
const { languageRequest } = require('@codegen/code-intelligence/language-request.cjs');
async function main() {
  const directory = fs.realpathSync(process.argv[2]), bundle = fs.realpathSync(process.argv[3]);
  const temporary = fs.realpathSync(os.tmpdir());
  if (!directory.startsWith(temporary + path.sep) || !/^java-startup-profile-[\w-]+$/.test(path.basename(directory))) throw new Error('Only an owned retained startup diagnostic directory may be reused');
  const root = path.join(directory, 'project'), dataRoot = path.join(directory, 'data');
  assert.equal(fs.realpathSync(root), root);
  assert.equal(fs.realpathSync(dataRoot), dataRoot);
  assert.ok(fs.existsSync(path.join(dataRoot, 'startup-profile/.metadata')));
  const manager = new LocalLspManager({ dataRoot, javaReadyMs: 120000, resources: { diagnosticJavaBundles: [bundle] } });
  try {
    const project = { id: 'startup-profile', path: root };
    const started = performance.now();
    const prepared = await manager.prepareProject(project);
    assert.ok(prepared.providers.some(provider => provider.provider === 'java' && provider.ready));
    const session = manager.sessions.get('startup-profile:java');
    const file = 'site-tpl-application/src/main/java/com/lenovo/rowssd/cms/sitetpl/service/admin/navigation/NavigationAdminService.java';
    session.requestTimeoutMs = 120000;
    const symbols = await manager.request(project, 'documentSymbols', { path: file });
    assert.ok(symbols.length);
    // Warm workspace still must demonstrate that the true global query works.
    const content = fs.readFileSync(path.join(root, file), 'utf8');
    const position = content.indexOf('interface NavigationAdminService') + 'interface '.length;
    assert.ok(position >= 'interface '.length);
    const prefix = content.slice(0, position);
    const implementations = await manager.request(project, 'implementation', { path: file, line: prefix.split('\n').length, column: prefix.length - prefix.lastIndexOf('\n') });
    assert.ok(implementations.some(item => item.path?.endsWith('/NavigationAdminServiceImpl.java')));
    console.log(JSON.stringify({ stage: 'true-jdt-query-verified', elapsedMs: Math.round(performance.now() - started) }));
    const nativeModel = process.argv.includes('--native-model');
    const provenance = process.argv.includes('--provenance');
    const result = await languageRequest(session, 'workspace/executeCommand', { command: 'codestudio.diagnostic.packageMetadata', arguments: provenance ? ['provenance'] : nativeModel ? ['native'] : [] }, 120000);
    if (provenance) {
      assert.equal(result.source, 'actual-jdt-runtime:provenance-v1');
      console.log(JSON.stringify({ stage: 'runtime-provenance', result }));
      return;
    }
    assert.equal(result.source, nativeModel ? 'actual-jdt-model:native-v3' : 'actual-jdt-model:v2');
    assert.equal(result.allNamesAndOrderIdentical, true);
    console.log(JSON.stringify({ stage: 'metadata-comparison', result }));
  } finally { await manager.shutdown(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
