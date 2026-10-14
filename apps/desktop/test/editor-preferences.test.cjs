const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const { validateAppearance, validatePreferences } = require('@codegen/code-intelligence/editor-appearance.cjs');
const { createLocalApi } = require('../src/local-api.cjs');
test('appearance validation bounds values and strips executable/unknown fields', () => {
  const appearance = validateAppearance({ fontSize: 18, fontFamily: 'JetBrains Mono, monospace', theme: 'darcula', script: 'alert(1)' });
  assert.equal(appearance.fontSize, 18); assert.equal(appearance.script, undefined);
  for (const input of [null, [], { fontSize: 100 }, { fontSize: 1.5 }, { fontFamily: 'url(https://example.com/font)' }, { theme: 'custom' }, { customTheme: { base: 'vs', rules: [], colors: { 'editor.background': 'url(x)' } } }]) assert.throws(() => validateAppearance(input));
  const theme = { base: 'vs-dark', inherit: true, rules: [{ token: 'comment', foreground: '00FF00', fontStyle: 'italic', script: 'unsafe' }], colors: { 'editor.background': '#123456' } };
  const custom = validateAppearance({ theme: 'custom', customTheme: theme });
  assert.equal(custom.customTheme.rules[0].script, undefined);
  assert.deepEqual(validateAppearance(JSON.parse(JSON.stringify(custom))), custom);
  assert.throws(() => validateAppearance({ theme: 'custom', customTheme: { ...theme, rules: [{ token: '__proto__.constructor', foreground: '123456' }] } }));
  assert.throws(() => validatePreferences({ appearance: false }));
  assert.equal(validatePreferences({ appearance, chatVisible: false }).chatVisible, false);
});
test('desktop appearance and chat preference survive API restart and require authentication', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-preferences-')); let api;
  t.after(async () => { await api?.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const options = { token: 'preferences-test', storePath: path.join(directory, 'local.sqlite3') };
  api = await createLocalApi(options);
  const url = '/api/local/editor-preferences'; const headers = { Authorization: 'Bearer preferences-test', 'Content-Type': 'application/json' };
  assert.equal((await fetch(api.origin + url)).status, 401);
  const preferences = validatePreferences({ appearance: { fontSize: 18, theme: 'darcula' }, chatVisible: false, navigationKeymap: 'vscode' });
  assert.equal((await fetch(api.origin + url, { method: 'PUT', headers, body: JSON.stringify(preferences) })).status, 200);
  assert.equal((await fetch(api.origin + url, { method: 'PUT', headers, body: JSON.stringify({ appearance: { fontSize: 999 } }) })).status, 400);
  await api.close(); api = await createLocalApi(options);
  assert.deepEqual(await (await fetch(api.origin + url, { headers })).json(), { preferences });
});
