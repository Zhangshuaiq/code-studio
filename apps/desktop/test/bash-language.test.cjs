const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LocalLspManager } = require('@codegen/code-intelligence');
const { supportsBashLanguage } = require('@codegen/code-intelligence/shell-language.cjs');

test('Bash intelligence uses the shared file registry without parsing other shell dialects', () => {
  for (const file of ['start.sh', 'START.BASH', 'scripts/mvnw', 'gradlew', '.bashrc', '.bash_profile', '.profile']) assert.equal(supportsBashLanguage(file), true, file);
  for (const file of ['start.zsh', '.zshrc', 'start.fish', 'start.ps1', 'start.sql', 'start.sh.txt']) assert.equal(supportsBashLanguage(file), false, file);
});

test('real Bash server completes unsaved variables and resolves function definitions, references and outline', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-studio-bash-'));
  const source = '#!/usr/bin/env bash\nGREETING=hello\ngreet() { echo "$GREETING"; }\ngreet\n';
  fs.writeFileSync(path.join(root, 'run.sh'), source);
  fs.writeFileSync(path.join(root, 'gradlew'), source);
  fs.writeFileSync(path.join(root, 'wrong.zsh'), source);
  const manager = new LocalLspManager();
  t.after(async () => { await manager.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  const project = { id: 'bash-test', path: root };
  const prepared = await manager.prepareProject(project);
  assert.deepEqual(prepared.providers, [{ provider: 'bash', ready: true }]);
  const outline = await manager.request(project, 'documentSymbols', { path: 'run.sh', content: source });
  assert.ok(outline.some(symbol => symbol.name === 'greet'), JSON.stringify(outline));
  const definition = await manager.request(project, 'definition', { path: 'run.sh', content: source, line: 4, column: 3 });
  assert.ok(definition.some(location => location.path === 'run.sh' && location.range.start.line === 2), JSON.stringify(definition));
  const references = await manager.request(project, 'references', { path: 'run.sh', content: source, line: 3, column: 3 });
  assert.ok(references.some(location => location.path === 'run.sh' && location.range.start.line === 3), JSON.stringify(references));
  const draft = '#!/usr/bin/env bash\nDRAFT_VALUE=hello\necho "$DRAFT_"\n';
  const result = await manager.request(project, 'completion', { path: 'run.sh', content: draft, line: 3, column: 14 });
  assert.ok((Array.isArray(result) ? result : result.items).some(item => item.label.includes('DRAFT_VALUE')), JSON.stringify(result));
  assert.equal(fs.readFileSync(path.join(root, 'run.sh'), 'utf8'), source, 'completion must not save drafts');
  const wrapper = await manager.request(project, 'documentSymbols', { path: 'gradlew', content: source });
  assert.ok(wrapper.some(symbol => symbol.name === 'greet'));
  await assert.rejects(manager.request(project, 'documentSymbols', { path: 'wrong.zsh' }), { code: 'WORKSPACE_PATH_INVALID' });
});
