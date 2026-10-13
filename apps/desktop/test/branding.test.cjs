const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
test('web and desktop use code studio instead of the old platform title', () => {
  const root = path.resolve(__dirname, '../../..');
  assert.match(fs.readFileSync(path.join(root, 'apps/web/index.html'), 'utf8'), /<title>code studio<\/title>/);
  const main = fs.readFileSync(path.join(root, 'apps/desktop/src/main.cjs'), 'utf8');
  assert.ok(main.includes("title: 'code studio'"));
  assert.ok(main.includes("window.setTitle('code studio')"));
  for (const file of ['apps/web/src/components/Auth/LoginForm.tsx', 'apps/web/src/components/Shell/Sidebar.tsx']) assert.ok(!fs.readFileSync(path.join(root, file), 'utf8').includes('AI 代码生成平台'));
});
