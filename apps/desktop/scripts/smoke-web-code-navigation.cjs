// Exercises the production web renderer (not desktop-local mode). The remote
// HTTP fixture isolates UI behavior; real language servers/auth are covered by
// apps/api/test/workspace-language.test.cjs.
const { app, BrowserWindow } = require('electron');
const { JavaSyntaxIndex } = require('../../../packages/code-intelligence/java-syntax-index.cjs');
let syntaxIndex;
const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path'); const assert = require('node:assert/strict');
const { encodeText, decodeText } = require('@codegen/code-intelligence/file-text.cjs');
let nativeBytes = encodeText('SELECT 你好;\r\n', { encoding: 'utf-16be', bom: true });
const root = path.resolve(__dirname, '../../web/dist');
const main = 'public class Main { static int sharedCount = 1;\n  public static void main(String[] args) {\n    System.out.println(Greeting.message());\n    int localCount = 1;\n    int result = args.length + sharedCount + localCount;\n  }\n}\n';
const greeting = 'public class Greeting {\n  public static String message() { return "hello"; }\n}\n';
const usage = 'public class Usage {\n  public void use() {\n    Greeting.message();\n  }\n}\n';
const implementation = 'public class Implementation {\n  public String message() { return "implementation"; }\n}\n';
const virtual = '@java-source/aaaaaaaaaaaaaaaaaaaaaaaa/String.java';
const files = { 'Main.java': main, 'Greeting.java': greeting, 'Usage.java': usage, 'Implementation.java': implementation };
Object.assign(files, { 'schema.sql': 'CREATE TABLE web_users (original_column TEXT);', 'query.sql': 'SELECT u. FROM web_users AS u;' });
Object.assign(files, { 'mvnw': '#!/bin/sh\necho build', 'schema.svg.xml': '<schema/>', 'notes.custom': 'Unknown extension text', 'Guide.MDWN': '# Alternate Markdown' });
Object.assign(files, { 'settings.json': '{"mixed":true}', 'pom.xml': '<project/>', 'migration.sql': 'SELECT 1;', 'run.sh': '#!/bin/sh\necho ok', 'README.md': '# Mixed Workspace\n\n| Name | Value |\n| --- | --- |\n| Test | 1 |\n\n![local](图片.png)\n![tracking](https://tracker.invalid/x.png)\n<script>window.__markdownExecuted=true</script>\n[unsafe](javascript:alert(1))\n' });
files['migration.sql'] = 'SELECT 1;\nSELECT 2;\n'; files['README.md'] += '\n[Source](migration.sql#L2C3)\n[Guide](guide.md#target-section)\n[Missing](#missing-section)\n[Escape](../outside.md)\n';
files['guide.md'] = '# Guide\n\n' + 'Padding\n\n'.repeat(100) + '## Target Section\n\nTarget reached.\n' + 'Tail\n\n'.repeat(100);
files['native.sql'] = '';
const previewFiles = {
  '图片.png': { kind: 'image', mime: 'image/png' },
  'manual.pdf': { kind: 'pdf', mime: 'application/pdf' },
  'slow.png': { kind: 'image', mime: 'image/png' },
  'report.xlsx': { kind: 'spreadsheet', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  'rows.csv': { kind: 'spreadsheet', mime: 'text/csv' },
  'old.xls': { kind: 'unsupported', mime: 'application/vnd.ms-excel', reason: '旧版 .xls 暂不支持，请另存为 .xlsx 或 .csv' },
};
const previewRequests = [];
const reads = new Map(); const requests = []; let writes = 0; let window; let server; let exitCode = 0; let deferDefinition = false; let fastQueries = 0; let staleFastSymbols = false;
let holdSemanticStartup = true;
const deadline = setTimeout(() => { console.error('Web navigation smoke timed out'); app.exit(1); }, 60_000);
async function waitFor(expression) {
  for (let i = 0; i < 200; i++) {
    if (await window.webContents.executeJavaScript(`(() => { try { return (${expression}); } catch { return false; } })()`)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`UI condition not reached: ${expression}`);
}
async function monaco(expression) {
  return window.webContents.executeJavaScript(`new Promise((resolve, reject) => window.require(['vs/editor/editor.main'], async module => { try { const monaco = window.monaco || module; const editor = monaco.editor.getEditors().find(editor => editor.getModel()?.uri.scheme === 'codegen'); resolve(await (${expression})); } catch (error) { reject(error); } }))`);
}
async function clickFile(file) {
  await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(button => button.title === ${JSON.stringify(file)}).click()`);
  await waitFor(`document.querySelector('.monaco-editor .view-lines')?.textContent.includes(${JSON.stringify(file === 'Main.java' ? 'Main' : 'Greeting')})`);
}
app.whenReady().then(async () => {
  try {
    server = http.createServer(async (request, response) => {
      const url = new URL(request.url, 'http://localhost');
      const json = (value, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
      if (url.pathname === '/bootstrap') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<script>localStorage.setItem("token","web-fixture");localStorage.setItem("username","WebOwner");localStorage.setItem("autoFormat","false");location.replace("/projects/project");</script>'); return; }
      if (url.pathname.startsWith('/api/')) {
        assert.equal(request.headers.authorization, 'Bearer web-fixture');
        assert.ok(!url.pathname.startsWith('/api/local/'), 'web must never call desktop local endpoints');
        if (url.pathname === '/api/auth/me') return json({ id: 'owner', username: 'WebOwner', roles: [], permissions: ['project:read'] });
        if (url.pathname === '/api/admin/datasources') return json({items:[{id:'sql-source',name:'Web SQL DB',type:'postgresql',updatedAt:'fixture'}]});
        if (url.pathname === '/api/db-query/sql-source/metadata') { const action=url.searchParams.get('action'); if(action==='columns'){assert.equal(url.searchParams.get('database'),'fixture_db');assert.equal(url.searchParams.get('table'),'web_users');}return json({items:action==='databases'?['fixture_db']:action==='tables'?['web_users']:[{column_name:'bound_web_column',data_type:'text'}],truncated:false}); }
        if (url.pathname === '/api/projects/project') return json({ id: 'project', name: 'Web Java', userId: 'owner', accessRole: 'owner', status: 'active' });
        if (url.pathname === '/api/sessions') return json([{ id: 'session', projectId: 'project' }]);
        if (url.pathname === '/api/sessions/session/files') return json([...Object.keys(files), ...Object.keys(previewFiles)]);
        if (url.pathname === '/api/sessions/session/files/preview' || url.pathname === '/api/sessions/session/files/spreadsheet') {
          assert.equal(request.headers.authorization, 'Bearer web-fixture');
          assert.deepEqual([...url.searchParams.keys()], ['path']);
          const file = url.searchParams.get('path'); previewRequests.push(file);
          if (file === 'slow.png') await new Promise(resolve => setTimeout(resolve, 800));
          if (url.pathname.endsWith('/spreadsheet')) return json({ sheets: [{ name: '数据', rows: [['名称', '数量'], ['苹果', '3']] }, { name: 'Other', rows: [['second sheet']] }], truncated: false });
          response.writeHead(200, { 'Content-Type': previewFiles[file].mime });
          response.end(file.endsWith('.png') ? Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRuoAAAAASUVORK5CYII=', 'base64') : require('./preview-fixture-pdf.cjs')());
          return;
        }
        if (url.pathname === '/api/sessions/session/files/index') return json({ files: [], bytes: 0, truncated: false });
        if (url.pathname === '/api/sessions/session/git/blame') { let raw = ''; for await (const chunk of request) raw += chunk; const body = JSON.parse(raw); return json({ lines: body.content.split('\n').map((_, index) => ({ line: index + 1, originalLine: index + 1, hash: 'a'.repeat(40), author: 'WebBlameAuthor', email: 'web@example.test', date: 1700000000, summary: 'web initial', uncommitted: false })) }); }
        if (url.pathname === `/api/sessions/session/git/commits/${'a'.repeat(40)}/diff`) return json([{ path: 'Main.java', before: '', after: main }]);
        if (url.pathname === '/api/sessions/session/files/content') {
          let file = url.searchParams.get('path'); let writeBody;
          if (request.method !== 'GET') { let raw = ''; for await (const chunk of request) raw += chunk; writeBody = JSON.parse(raw); file = writeBody.path; }
          if (file === 'native.sql') {
            if (request.method !== 'GET') { assert.equal(writeBody.expectedVersion, require('node:crypto').createHash('sha256').update(nativeBytes).digest('hex')); nativeBytes = encodeText(writeBody.content, decodeText(nativeBytes)); writes++; return json({ success: true }); }
            return json({ path: file, kind: 'text', language: 'sql', mime: 'text/plain', ...decodeText(nativeBytes), version: require('node:crypto').createHash('sha256').update(nativeBytes).digest('hex') });
          }
          if (previewFiles[file]) return json({ path: file, content: '', readOnly: true, ...previewFiles[file] });
          if (request.method !== 'GET') { writes++; return json({ success: true }); }
          reads.set(file, (reads.get(file) || 0) + 1); return json({ path: file, content: files[file] });
        }
        if (url.pathname === '/api/sessions/session/language/source') {
          assert.equal(url.searchParams.get('path'), virtual);
          reads.set(virtual, (reads.get(virtual) || 0) + 1);
          return json({ path: virtual, content: 'public final class String {\n  public int length() { return 0; }\n}\n', readOnly: true });
        }
        if (url.pathname.startsWith('/api/sessions/session/language/')) {
          let raw = ''; for await (const chunk of request) raw += chunk; const body = JSON.parse(raw || '{}');
          const operation = url.pathname.split('/').pop(); requests.push({ operation, body });
          if (operation === 'fast-document-symbols') {
            syntaxIndex ||= await JavaSyntaxIndex.create();
            const parsed = syntaxIndex.parse(body.content, body.path);
            return json({ items: parsed.symbols, overlayApplied: true, overlayTruncated: parsed.truncated });
          }
          if (operation === 'status' && requests.filter(item => item.operation === 'status').length === 3) return json({ message: 'temporary status failure' }, 503);
          if (operation === 'status') return json({ providers: [{ provider: 'java', phase: holdSemanticStartup ? 'importing' : 'ready', message: holdSemanticStartup ? '正在加载项目与缓存索引' : '代码智能已就绪', elapsedMs: 45000 }] });
          if (operation === 'index-refresh') { staleFastSymbols = false; return json({ index: { state: 'ready', complete: true, files: 4 } }); }
          if (operation === 'index-status') return json({ index: { state: fastQueries === 1 ? 'scanning' : 'ready', complete: fastQueries !== 1, files: 4 } });
          if (operation === 'fast-symbols') {
            assert.equal(body.query, 'Greeting');
            assert.ok(body.documents.some(document => document.path === 'Greeting.java' && document.content.includes('unsaved')), 'fast search must include the current Java draft');
            assert.ok(body.documents.every(document => document.path.endsWith('.java')));
            fastQueries++;
            const name = body.documents.find(document => document.path === 'Greeting.java').content.includes('class DraftGreeting') ? 'DraftGreeting' : 'Greeting';
            const content = body.documents.find(document => document.path === 'Greeting.java').content;
            return json({ items: fastQueries < 2 ? [] : [{ name, path: 'Greeting.java', line: 1, column: 14, hash: staleFastSymbols ? '0'.repeat(64) : require('node:crypto').createHash('sha256').update(content).digest('hex'), hashSource: 'overlay', semantic: false }], truncated: fastQueries < 2, sourceTruncated: fastQueries < 2, index: { state: fastQueries < 2 ? 'scanning' : 'ready', complete: fastQueries >= 2, files: 4 } });
          }
          if (operation === 'prepare') return json({ providers: [{ provider: 'java', ready: true }] });
          if (operation === 'definition') {
            const line = (body.content || files[body.path]).split('\n')[body.line - 1];
            const word = line.slice(0, body.column).match(/[\w$]+$/)?.[0] || '';
            const variable = ['args', 'sharedCount', 'localCount'].find(name => name.startsWith(word) && word.length > 1);
            if (variable) { const targetLine = variable === 'args' ? 1 : variable === 'sharedCount' ? 0 : 3; const targetColumn = main.split('\n')[targetLine].indexOf(variable); return json({ result: [{ path: 'Main.java', range: { start: { line: targetLine, character: targetColumn }, end: { line: targetLine, character: targetColumn + variable.length } } }] }); }
            if (deferDefinition) await new Promise((resolve) => setTimeout(resolve, 500));
            const target = body.line === 2 ? virtual : 'Greeting.java';
            return json({ result: [{ path: target, range: { start: { line: target === virtual ? 0 : 1, character: target === virtual ? 19 : 23 }, end: { line: target === virtual ? 0 : 1, character: 30 } }, readOnly: target === virtual }] });
          }
          if (operation === 'hover') return json({ result: { contents: 'String Main.main(String[] args)' } });
          if (operation === 'references') return json({ result: [
            { path: 'Main.java', range: { start: { line: 2, character: 23 }, end: { line: 2, character: 31 } } },
            { path: 'Usage.java', range: { start: { line: 2, character: 4 }, end: { line: 2, character: 12 } } },
          ] });
          if (operation === 'implementation') return json({ result: [{ path: 'Implementation.java', targetRange: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } }, targetSelectionRange: { start: { line: 1, character: 16 }, end: { line: 1, character: 23 } } }] });
          return json({ result: [] });
        }
        if (url.pathname.endsWith('/git/branches')) return json({ current: 'main', list: ['main'] });
        if (url.pathname.endsWith('/git/sync-status')) return json({ ahead: 0, behind: 0, dirty: false });
        if (url.pathname.endsWith('/git/remote')) return json(null);
        if (url.pathname.endsWith('/preview')) return json({ status: 'not_started' });
        return json([]);
      }
      const file = url.pathname.startsWith('/assets/') || url.pathname.startsWith('/monaco/') ? path.resolve(root, `.${url.pathname}`) : path.join(root, 'index.html');
      if (!file.startsWith(`${root}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'Content-Type': /\.m?js$/.test(file) ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.wasm') ? 'application/wasm' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream' }); fs.createReadStream(file).pipe(response);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    window = new BrowserWindow({ show: false, width: 1500, height: 1000, webPreferences: { partition: `web-navigation-${require('node:crypto').randomUUID()}`, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    window.webContents.on('console-message', (event) => { if (event.level === 3) console.error(event.message); });
    await window.loadURL(`http://127.0.0.1:${server.address().port}/bootstrap`);
    await waitFor(`!![...document.querySelectorAll('button')].find(button => button.title === 'Main.java')`);
    await clickFile('Main.java');
    await waitFor(`document.querySelector('[data-language-status]')?.textContent.includes('语义服务正在加载')`);
    await waitFor(`document.querySelector('[data-fast-index-status]')?.textContent.includes('快速索引就绪') && document.querySelector('[data-language-status]')?.textContent.includes('语义服务正在加载')`);
    assert.ok(await window.webContents.executeJavaScript(`!!document.querySelector('[data-language-status] [role="progressbar"]')`));
    await waitFor(`!!document.querySelector('.monaco-editor textarea')`);
    await monaco('(() => { editor.focus(); return editor.getAction("editor.action.quickOutline").run(); })()');
    await waitFor(`document.querySelector('.quick-input-widget')?.textContent.includes('main')`);
    assert.ok(holdSemanticStartup && requests.some(item => item.operation === 'fast-document-symbols'), 'outline must be usable before semantic readiness');
    await window.webContents.executeJavaScript(`document.querySelector('.quick-input-widget .quick-input-action .monaco-button').click()`);
    await waitFor(`!document.querySelector('.quick-input-widget')?.offsetHeight`);
    holdSemanticStartup = false;
    await waitFor(`document.querySelector('[data-language-status]')?.textContent.includes('代码智能已就绪')`);
    for (let i = 0; i < 60 && requests.filter(item => item.operation === 'status').length < 3; i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(requests.filter(item => item.operation === 'status').length >= 3, 'must exercise a transient status failure');
    await waitFor(`document.querySelector('[data-language-status]')?.textContent.includes('代码智能已就绪')`);
    assert.ok(!await window.webContents.executeJavaScript(`document.querySelector('[data-language-status]')?.textContent.includes('正在连接代码智能')`));
    await waitFor(`!!document.querySelector('.monaco-editor textarea')`);
    const editorId = await monaco('editor.getId()');
    await monaco('(() => { window.__mainEditor = editor; return true; })()');
    await monaco('(() => { editor.focus(); return editor.getAction("editor.action.quickOutline").run(); })()');
    await waitFor(`document.querySelector('.quick-input-widget')?.textContent.includes('main')`);
    assert.ok(requests.some(item => item.operation === 'fast-document-symbols' && item.body.content === main));
    assert.ok(!requests.some(item => item.operation === 'document-symbols' && item.body.path === 'Main.java'));
    await window.webContents.executeJavaScript(`document.querySelector('.quick-input-widget .quick-input-action .monaco-button').click()`);
    await waitFor(`!document.querySelector('.quick-input-widget')?.offsetHeight`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === '行注释').click()`);
    await waitFor(`[...document.querySelectorAll('.line-numbers')].some(node => node.textContent.includes('WebBlameAuth'))`);
    await window.webContents.executeJavaScript(`document.querySelector('[aria-label="编辑器外观"]').click()`);
    await waitFor(`!!document.querySelector('[aria-label="编辑器字号"]')`);
    await window.webContents.executeJavaScript(`(()=>{const node=document.querySelector('[aria-label="编辑器字号"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,'17');node.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await waitFor(`[...document.querySelectorAll('.line-numbers')].some(node => node.textContent.includes('WebBlameAuth'))`);
    assert.equal(await monaco('editor.getOption(monaco.editor.EditorOption.fontSize)'),17);
    await window.webContents.executeJavaScript(`(()=>{const node=document.querySelector('[aria-label="编辑器字号"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,'13');node.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[aria-label="关闭编辑器外观"]').click();})()`);
    await window.webContents.executeJavaScript(`document.querySelector('.line-numbers').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: document.querySelector('.line-numbers').getBoundingClientRect().x + 10, clientY: document.querySelector('.line-numbers').getBoundingClientRect().y + 5 }))`);
    await waitFor(`!!document.querySelector('[aria-label="行注释提交详情"]')`);
    await waitFor(`document.querySelector('[aria-label="行注释提交详情"]').textContent.includes('Main.java')`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('[aria-label="行注释提交详情"] button')].find(button => button.textContent === '关闭').click()`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === '行注释').click()`);
    for (const variable of ['args', 'sharedCount', 'localCount']) {
      const usageColumn = main.split('\n')[4].lastIndexOf(variable) + 2;
      await monaco(`(() => { editor.focus(); editor.revealPositionInCenter({ lineNumber: 5, column: ${usageColumn} }, 1); return true; })()`);
      await new Promise(resolve => setTimeout(resolve, 150));
      const variablePoint = await monaco(`(() => { const visible = editor.getScrolledVisiblePosition({ lineNumber: 5, column: ${usageColumn} }); const rect = editor.getDomNode().getBoundingClientRect(); return { x: Math.round(rect.left + visible.left + 2), y: Math.round(rect.top + visible.top + visible.height / 2) }; })()`);
      // Drive Monaco's definition-hover controller directly in the hidden
      // fixture window; native mouse-move delivery depends on OS focus.
      // This still queries our provider and creates Monaco's real decoration.
      await monaco(`editor.getContribution('editor.contrib.gotodefinitionatposition').startFindDefinitionFromCursor({ lineNumber: 5, column: ${usageColumn} })`);
      await waitFor(`[...document.querySelectorAll('.goto-definition-link')].some(node => node.textContent === ${JSON.stringify(variable)})`);
      window.webContents.sendInputEvent({ type: 'mouseDown', ...variablePoint, button: 'left', clickCount: 1, modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
      window.webContents.sendInputEvent({ type: 'mouseUp', ...variablePoint, button: 'left', clickCount: 1, modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
      const targetLine = variable === 'args' ? 2 : variable === 'sharedCount' ? 1 : 4;
      const targetColumn = main.split('\n')[targetLine - 1].indexOf(variable) + 1;
      await waitFor(`window.__mainEditor?.getPosition().lineNumber === ${targetLine} && window.__mainEditor?.getPosition().column === ${targetColumn}`);
    }
    await monaco('(async () => { editor.setPosition({ lineNumber: 3, column: 26 }); await editor.getAction("open-definition-in-tab").run(); })()');
    await waitFor(`document.querySelector('.monaco-editor .view-lines')?.textContent.includes('Greeting')`);
    assert.equal(await monaco('editor.getId()'), editorId, 'cross-file navigation must retain the editor instance');
    assert.equal(await monaco('editor.getPosition().lineNumber'), 2);
    assert.equal(await monaco('editor.getPosition().column'), 24);
    await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="返回上一处代码"]').click()`);
    await waitFor(`document.querySelector('.monaco-editor .view-lines')?.textContent.includes('Main')`);
    assert.equal(await monaco('editor.getPosition().lineNumber'), 3);
    assert.equal(await monaco('editor.getPosition().column'), 26);
    await monaco('editor.getAction("workspace-navigation-forward").run()');
    await waitFor(`document.querySelector('.monaco-editor .view-lines')?.textContent.includes('Greeting')`);
    assert.equal(await monaco('editor.getPosition().lineNumber'), 2);
    assert.equal(await monaco('editor.getPosition().column'), 24);
    await monaco('editor.getModel().setValue(editor.getModel().getValue().replace("hello", "unsaved"))');
    await clickFile('Main.java');
    await monaco('(async () => { editor.setPosition({ lineNumber: 3, column: 26 }); await editor.getAction("open-definition-in-tab").run(); })()');
    await waitFor(`document.querySelector('.monaco-editor .view-lines')?.textContent.includes('unsaved')`);
    assert.equal(reads.get('Greeting.java'), 1, 'cached navigation target should only be fetched once');
    assert.ok(requests.filter((request) => request.operation === 'definition').at(-1).body.documents.some((document) => document.path === 'Greeting.java' && document.content.includes('unsaved')));
    await clickFile('Main.java');
    await monaco('(async () => { editor.setPosition({ lineNumber: 2, column: 27 }); await editor.getAction("open-definition-in-tab").run(); })()');
    await waitFor(`document.body.textContent.includes('依赖源码 · 只读') && document.querySelector('.monaco-editor .view-lines')?.textContent.includes('String')`);
    assert.equal(await monaco('editor.getOption(monaco.editor.EditorOption.readOnly)'), true);
    await monaco('editor.trigger("fixture", "editor.action.formatDocument", null)');
    assert.equal(writes, 0, 'source navigation must not write project files');
    assert.equal(await monaco('editor.getId()'), editorId);
    await monaco('editor.getAction("workspace-navigation-back").run()');
    await waitFor(`document.querySelector('.monaco-editor .view-lines')?.textContent.includes('Main')`);
    assert.equal(await monaco('editor.getPosition().lineNumber'), 2);
    assert.equal(await monaco('editor.getPosition().column'), 27);
    await monaco('editor.getAction("workspace-navigation-forward").run()');
    await waitFor(`document.body.textContent.includes('依赖源码 · 只读') && document.querySelector('.monaco-editor .view-lines')?.textContent.includes('String')`);
    await clickFile('Main.java');
    assert.equal(await monaco('editor.getOption(monaco.editor.EditorOption.readOnly)'), false);
    const point = await monaco('(() => { editor.revealLineInCenter(3); const visible = editor.getScrolledVisiblePosition({ lineNumber: 3, column: 26 }); const rect = editor.getDomNode().getBoundingClientRect(); return { x: Math.round(rect.left + visible.left + 2), y: Math.round(rect.top + visible.top + visible.height / 2) }; })()');
    window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1, modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
    window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1, modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
    await waitFor(`document.querySelector('.monaco-editor .view-lines')?.textContent.includes('unsaved')`);
    await clickFile('Main.java'); deferDefinition = true;
    await monaco('(() => { editor.setPosition({ lineNumber: 2, column: 27 }); void editor.getAction("open-definition-in-tab").run(); return true; })()');
    await clickFile('Greeting.java');
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(await monaco('editor.getModel().uri.path'), '/Greeting.java', 'late definition must not override the user-selected file');
    assert.equal(reads.get('Greeting.java'), 1);
    deferDefinition = false;
    await clickFile('Main.java');
    await monaco('(async () => { editor.setPosition({ lineNumber: 3, column: 26 }); await editor.getAction("find-all-references").run(); })()');
    await waitFor(`!!document.querySelector('.peekview-widget') && document.querySelector('.peekview-widget')?.textContent.includes('Usage.java')`);
    assert.equal(reads.get('Usage.java'), 1);
    assert.equal(await monaco('monaco.editor.getModel(monaco.Uri.parse("codegen://session/Usage.java")).getValue().includes("Greeting.message")'), true, 'unopened reference targets must be readable by the peek widget');
    // Expand/select the unopened target through the actual reference tree.
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('.peekview-widget .monaco-list-row')].find(node => node.textContent.includes('Usage.java')).click()`);
    await waitFor(`[...document.querySelectorAll('.peekview-widget .monaco-list-row')].some(node => node.textContent.trim() === 'Greeting.message();')`);
    const referencePoint = await window.webContents.executeJavaScript(`(() => { const row = [...document.querySelectorAll('.peekview-widget .monaco-list-row')].find(node => node.textContent.trim() === 'Greeting.message();'); const rect = row.getBoundingClientRect(); return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }; })()`);
    window.webContents.sendInputEvent({ type: 'mouseDown', ...referencePoint, button: 'left', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseUp', ...referencePoint, button: 'left', clickCount: 1 });
    await waitFor(`document.querySelector('.peekview-widget .view-lines')?.textContent.includes('Usage')`);
    const openReferencePoint = await window.webContents.executeJavaScript(`(() => { const row = [...document.querySelectorAll('.peekview-widget .monaco-list-row')].find(node => node.textContent.trim() === 'Greeting.message();'); const rect = row.getBoundingClientRect(); return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }; })()`);
    window.webContents.sendInputEvent({ type: 'mouseDown', ...openReferencePoint, button: 'left', clickCount: 2 });
    window.webContents.sendInputEvent({ type: 'mouseUp', ...openReferencePoint, button: 'left', clickCount: 2 });
    await waitFor(`!document.querySelector('.peekview-widget') && document.querySelector('.monaco-editor .view-lines')?.textContent.includes('Usage')`);
    assert.equal(await monaco('editor.getPosition().lineNumber'), 3);
    assert.equal(await monaco('editor.getPosition().column'), 5);
    await monaco('editor.getAction("workspace-navigation-back").run()');
    await waitFor(`document.querySelector('.monaco-editor .view-lines')?.textContent.includes('Main')`);
    await monaco('(() => { editor.setPosition({ lineNumber: 3, column: 26 }); editor.trigger("fixture", "editor.action.goToImplementation", null); })()');
    await waitFor(`document.querySelector('.monaco-editor .view-lines')?.textContent.includes('Implementation')`);
    assert.equal(await monaco('editor.getPosition().lineNumber'), 2);
    assert.equal(await monaco('editor.getPosition().column'), 17);
    assert.equal(reads.get('Implementation.java'), 1);
    assert.equal(await monaco('editor.getId()'), editorId);
    assert.equal(writes, 0);
    console.log('Web code navigation UI passed: remote API, F12, Ctrl/Cmd+click, accurate position, stable editor, cached files, dirty buffers, readonly source and stale-response protection.');
    await window.webContents.executeJavaScript(`(() => { const input = document.querySelector('input[title="全局搜索 (⌘/Ctrl+Shift+F)"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '@Greeting'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitFor(`document.body.textContent.includes('索引更新中，先展示已有匹配结果')`);
    await waitFor(`!![...document.querySelectorAll('button')].find(button => button.textContent.includes('Greeting.java:1'))`);
    assert.ok(fastQueries >= 2, 'partial search must automatically refresh as indexing progresses');
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(button => button.textContent.includes('Greeting.java:1')).click()`);
    await waitFor(`document.querySelector('.monaco-editor .view-lines')?.textContent.includes('unsaved')`);
    assert.equal(await monaco('editor.getPosition().lineNumber'), 1);
    assert.equal(writes, 0);
    await monaco('editor.getModel().setValue(editor.getModel().getValue().replace("class Greeting", "class DraftGreeting"))');
    await waitFor(`!![...document.querySelectorAll('button')].find(button => button.textContent.includes('Greeting.java:1') && button.textContent.includes('DraftGreeting'))`);
    assert.ok(fastQueries >= 3, 'editing a Java draft must automatically refresh the active search');
    assert.equal(writes, 0, 'draft search must never save files');
    staleFastSymbols = true;
    const beforeStale = fastQueries;
    await monaco('editor.getModel().setValue(editor.getModel().getValue() + "\\n")');
    await waitFor(`!![...document.querySelectorAll('button')].find(button => button.textContent.includes('Greeting.java:1') && button.textContent.includes('DraftGreeting'))`);
    assert.ok(fastQueries > beforeStale);
    await monaco('editor.setPosition({ lineNumber: 3, column: 1 })');
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(button => button.textContent.includes('Greeting.java:1')).click()`);
    await waitFor(`document.body.textContent.includes('代码已变化，请从更新后的结果打开')`);
    assert.ok(requests.some(request => request.operation === 'index-refresh'));
    assert.equal(await monaco('editor.getPosition().lineNumber'), 3, 'stale symbol must not move the cursor');
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(button => button.textContent.includes('Greeting.java:1')).click()`);
    await waitFor(`!document.body.textContent.includes('正在确认代码位置') && !document.body.textContent.includes('代码已变化，请从更新后的结果打开')`);
    assert.equal(await monaco('editor.getPosition().lineNumber'), 1);
    assert.equal(await monaco('editor.getPosition().column'), 14);
    assert.equal(writes, 0);
    await window.webContents.executeJavaScript(`(() => { window.__createdPreviewUrls = []; window.__revokedPreviewUrls = []; const create = URL.createObjectURL.bind(URL); URL.createObjectURL = blob => { const url = create(blob); window.__createdPreviewUrls.push(url); return url; }; const revoke = URL.revokeObjectURL.bind(URL); URL.revokeObjectURL = url => { window.__revokedPreviewUrls.push(url); revoke(url); }; window.__pdfWorkers = { created: 0, terminated: 0 }; const NativeWorker = window.Worker; window.Worker = class extends NativeWorker { constructor(url, options) { super(url, options); this.pdfTracked = String(url).includes('pdf.worker'); if (this.pdfTracked) window.__pdfWorkers.created++; } terminate() { if (this.pdfTracked) { this.pdfTracked = false; window.__pdfWorkers.terminated++; } return super.terminate(); } }; })()`);
    await window.webContents.executeJavaScript(`(() => { const input = document.querySelector('input[placeholder^="搜索文件或代码"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ''); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitFor(`[...document.querySelectorAll('button')].some(button => button.title === '图片.png')`);
    const openPreview = async file => window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(button => button.title === ${JSON.stringify(file)}).click()`);
    await openPreview('图片.png');
    await waitFor(`document.querySelector('img[alt="图片.png"]')?.complete && document.querySelector('img[alt="图片.png"]')?.naturalWidth === 1`);
    const imageUrl = await window.webContents.executeJavaScript(`document.querySelector('img[alt="图片.png"]').src`);
    assert.ok(imageUrl.startsWith('blob:'));
    assert.ok(await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === '保存').disabled`));
    assert.ok(!await window.webContents.executeJavaScript(`[...document.querySelectorAll('.monaco-editor')].some(node => node.offsetHeight > 0)`));
    await openPreview('manual.pdf');
    await waitFor(`!!document.querySelector('[data-pdf-rendered="true"]') && document.querySelector('[data-pdf-text]')?.textContent.includes('Code Studio PDF preview')`);
    assert.ok(await window.webContents.executeJavaScript(`(() => { const canvas = document.querySelector('[data-pdf-rendered="true"]'); return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data.some((value, index) => index % 4 !== 3 && value < 200); })()`));
    if (process.env.CODE_STUDIO_PREVIEW_SCREENSHOT) {
      window.show(); window.focus();
      await new Promise(resolve => setTimeout(resolve, 1500));
      fs.writeFileSync(process.env.CODE_STUDIO_PREVIEW_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
    }
    const initialPdfWidth = await window.webContents.executeJavaScript(`document.querySelector('[data-pdf-rendered="true"]').width`);
    await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="放大 PDF"]').click()`);
    await waitFor(`document.querySelector('[data-pdf-rendered="true"]')?.width > ${initialPdfWidth}`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('[data-pdf-viewer] button')].find(button => button.textContent === '下一页').click()`);
    await waitFor(`document.querySelector('[data-pdf-text]')?.textContent.includes('second page')`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('[data-pdf-viewer] button')].find(button => button.textContent === '上一页').click()`);
    await waitFor(`document.querySelector('[data-pdf-text]')?.textContent.includes('Code Studio PDF preview')`);
    await openPreview('slow.png');
    for (let i = 0; i < 50 && !previewRequests.includes('slow.png'); i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(previewRequests.includes('slow.png'), 'must exercise an in-flight preview request');
    await openPreview('manual.pdf');
    await waitFor(`document.querySelector('[data-pdf-text]')?.textContent.includes('Code Studio PDF preview')`);
    await new Promise(resolve => setTimeout(resolve, 1000));
    assert.ok(!await window.webContents.executeJavaScript(`!!document.querySelector('img[alt="slow.png"]')`), 'old image response must not replace the current PDF');
    assert.ok(await window.webContents.executeJavaScript(`window.__revokedPreviewUrls.includes(${JSON.stringify(imageUrl)})`));
    await openPreview('report.xlsx');
    await waitFor(`document.querySelector('table')?.textContent.includes('苹果')`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Other').click()`);
    await waitFor(`document.querySelector('table')?.textContent.includes('second sheet')`);
    await openPreview('rows.csv');
    await waitFor(`document.querySelector('table')?.textContent.includes('苹果')`);
    await openPreview('old.xls');
    await waitFor(`document.body.textContent.includes('旧版 .xls 暂不支持')`);
    await clickFile('Greeting.java');
    await waitFor(`document.querySelector('.monaco-editor .view-lines')?.textContent.includes('DraftGreeting')`);
    await waitFor(`window.__createdPreviewUrls.every(url => window.__revokedPreviewUrls.includes(url)) && window.__pdfWorkers.created >= 2 && window.__pdfWorkers.terminated === window.__pdfWorkers.created`);
    assert.ok(previewRequests.includes('图片.png') && previewRequests.includes('manual.pdf') && previewRequests.includes('report.xlsx') && previewRequests.includes('rows.csv'));
    assert.equal(writes, 0, 'opening previews must not save any file or discard text drafts');
    console.log('Web previews UI passed: authenticated image/PDF, PDF canvas content, URL cleanup, multi-sheet XLSX/CSV, unsupported format, read-only controls and text draft recovery.');
    for (const [file, language] of [['settings.json', 'json'], ['pom.xml', 'xml'], ['migration.sql', 'sql'], ['run.sh', 'shell'], ['mvnw', 'shell'], ['schema.svg.xml', 'xml'], ['notes.custom', 'plaintext'], ['Guide.MDWN', 'markdown'], ['README.md', 'markdown']]) {
      await openPreview(file);
      await waitFor(`new Promise(resolve => window.require(['vs/editor/editor.main'], module => { const monaco = window.monaco || module; const editor = monaco.editor.getEditors().find(editor => editor.getModel()?.uri.path.endsWith(${JSON.stringify('/' + file)})); resolve(editor?.getModel().getLanguageId() === ${JSON.stringify(language)}); }))`);
    }
    await window.webContents.executeJavaScript(`document.querySelector('[aria-label="Markdown 视图"] button:nth-child(2)').click()`);
    await waitFor(`document.querySelector('[data-markdown-preview] h1')?.textContent === 'Mixed Workspace' && !!document.querySelector('[data-markdown-preview] table') && document.querySelector('[data-markdown-preview] img[alt="local"]')?.naturalWidth === 1`);
    assert.equal(await window.webContents.executeJavaScript(`!!window.__markdownExecuted || !!document.querySelector('[data-markdown-preview] a[href^="javascript:"]') || !!document.querySelector('[data-markdown-preview] img[src^="https:"]')`), false);
    await window.webContents.executeJavaScript(`document.querySelector('[aria-label="Markdown 视图"] button:nth-child(3)').click()`);
    await monaco(`editor.executeEdits('smoke', [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 18 }, text: '# Edited Workspace' }])`);
    await waitFor(`document.querySelector('[data-markdown-preview] h1')?.textContent === 'Edited Workspace'`);
    assert.equal(writes, 0);
    console.log('Web mixed-file/Markdown UI passed: JSON/XML/SQL/shell languages, source/preview/split, live unsaved Markdown, GFM table, authenticated local image and no executable document HTML.');
    const clickMarkdownLink = label => window.webContents.executeJavaScript(`[...document.querySelectorAll('[data-markdown-preview] a')].find(link => link.textContent === ${JSON.stringify(label)}).click()`);
    await clickMarkdownLink('Missing'); await waitFor(`document.body.textContent.includes('未找到该章节')`);
    await clickMarkdownLink('Source'); await waitFor(`new Promise(resolve => window.require(['vs/editor/editor.main'], module => { const monaco = window.monaco || module; const editor = monaco.editor.getEditors().find(editor => editor.getModel()?.uri.path.endsWith('/migration.sql')); resolve(editor?.getPosition().lineNumber === 2 && editor.getPosition().column === 3); }))`);
    await openPreview('README.md'); await waitFor(`!!document.querySelector('[aria-label="Markdown 视图"]')`);
    await window.webContents.executeJavaScript(`document.querySelector('[aria-label="Markdown 视图"] button:nth-child(2)').click()`);
    await waitFor(`document.querySelector('[data-markdown-preview] h1')?.textContent === 'Edited Workspace'`);
    await clickMarkdownLink('Guide'); await waitFor(`(() => { const heading = document.querySelector('[data-markdown-preview] h2'); if (heading?.id !== 'target-section') return false; const pane = heading.closest('article').parentElement.getBoundingClientRect(); const rect = heading.getBoundingClientRect(); return rect.top >= pane.top - 3 && rect.bottom <= pane.bottom; })()`);
    assert.equal(writes, 0); console.log('Web Markdown links passed: missing chapter feedback, SQL line/column navigation, cross-file chapter preview and preserved drafts without writes.');
    await openPreview('native.sql'); await waitFor(`document.querySelector('[data-file-encoding]')?.textContent.includes('UTF-16BE') && document.querySelector('.monaco-editor .view-lines')?.textContent.includes('你好')`);
    await monaco(`editor.getModel().setValue('SELECT 修改😀;\\r\\n')`);
    await waitFor(`[...document.querySelectorAll('button')].some(button => button.textContent.trim() === '保存' && !button.disabled)`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === '保存').click()`);
    for (let i = 0; i < 100 && writes !== 1; i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(nativeBytes, encodeText('SELECT 修改😀;\r\n', { encoding: 'utf-16be', bom: true })); assert.equal(writes, 1);
    console.log('Web UTF-16 UI passed: native encoding indicator, Unicode editing and explicit save preserves BOM/BE/CRLF bytes.');
    await openPreview('schema.sql');
    await waitFor(`document.querySelector('.monaco-editor .view-lines')?.textContent.includes('original_column')`);
    await monaco(`editor.getModel().setValue('CREATE TABLE web_users (draft_column TEXT);')`);
    await openPreview('query.sql');
    await waitFor(`new Promise(resolve => window.require(['vs/editor/editor.main'], module => { const monaco = window.monaco || module; const editor = monaco.editor.getEditors().find(editor => editor.getModel()?.uri.path.endsWith('/query.sql')); resolve(editor?.getValue().includes('FROM web_users')); }))`);
    await monaco(`(() => { editor.setPosition({ lineNumber: 1, column: 10 }); editor.focus(); editor.trigger('test', 'editor.action.triggerSuggest', {}); return true; })()`);
    await waitFor(`document.querySelector('.suggest-widget')?.textContent.includes('draft_column')`);
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('.suggest-widget')?.textContent.includes('original_column')`), false);
    assert.equal(files['schema.sql'], 'CREATE TABLE web_users (original_column TEXT);'); assert.equal(writes, 1);
    console.log('Web SQL UI passed: lazy shared parser, cross-file DDL drafts, alias column suggestions and no implicit writes.');
    await monaco(`editor.trigger('test','hideSuggestWidget',{})`);
    const selectSql = async(label,option)=>{await window.webContents.executeJavaScript(`[...document.querySelectorAll('[data-workspace-sql-binding] button')].find(node=>node.textContent.trim()===${JSON.stringify(label)}).click()`);await waitFor(`[...document.querySelectorAll('[role="option"]')].some(node=>node.textContent.trim()===${JSON.stringify(option)})`);await window.webContents.executeJavaScript(`[...document.querySelectorAll('[role="option"]')].find(node=>node.textContent.trim()===${JSON.stringify(option)}).click()`);};
    await selectSql('未绑定连接','Web SQL DB');await selectSql('选择数据库','fixture_db');
    await waitFor(`document.querySelector('[data-workspace-sql-binding]').textContent.includes('表/列提示就绪')`);
    await monaco(`(() => { editor.focus();editor.trigger('test','editor.action.triggerSuggest',{});return true; })()`);
    await waitFor(`document.querySelector('.suggest-widget')?.textContent.includes('bound_web_column')`);assert.equal(writes,1);
    assert.ok(await window.webContents.executeJavaScript(`document.querySelector('[data-workspace-sql-binding]').textContent.includes('提示表（可选）')`));
    await monaco(`editor.trigger('test','hideSuggestWidget',{})`);
    await selectSql('提示表（可选）','"public"."web_users"');
    await openPreview('README.md');
    await waitFor(`!document.querySelector('[data-workspace-sql-binding]')`);
    await openPreview('query.sql');
    await waitFor(`document.querySelector('[data-workspace-sql-binding]')?.textContent.includes('表/列提示就绪') && document.querySelector('[data-workspace-sql-binding]').textContent.includes('"public"."web_users"')`);
    assert.equal(writes,1);
    console.log('Web SQL binding passed: automatic referenced-table columns and connection/database/table restoration across non-SQL tabs.');
    await window.webContents.executeJavaScript(`window.__webChatNode=document.querySelector('[data-workspace-chat]');window.__webEditorWidth=document.querySelector('.monaco-editor').getBoundingClientRect().width;document.querySelector('[aria-label="关闭对话区域"]').click()`);
    await waitFor(`document.querySelector('[aria-label="打开对话区域"]') && document.querySelector('.monaco-editor').getBoundingClientRect().width > window.__webEditorWidth+100`);
    assert.ok(await window.webContents.executeJavaScript(`document.querySelector('[data-workspace-chat]')===window.__webChatNode`));
    await window.webContents.executeJavaScript(`document.querySelector('[aria-label="打开对话区域"]').click();document.querySelector('[aria-label="编辑器外观"]').click()`);
    await waitFor(`!!document.querySelector('[data-editor-appearance]')`);
    await window.webContents.executeJavaScript(`(()=>{const node=document.querySelector('[aria-label="编辑器字号"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,'18');node.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await waitFor(`new Promise(resolve=>window.require(['vs/editor/editor.main'],module=>{const monaco=window.monaco||module;const editor=monaco.editor.getEditors().find(editor=>editor.getModel()?.uri.path.endsWith('/query.sql')&&editor.getDomNode()?.isConnected);resolve(editor?.getOption(monaco.editor.EditorOption.fontSize)===18);} ))`);
    assert.equal(await window.webContents.executeJavaScript(`JSON.parse(localStorage.getItem('code-studio-editor-preferences')).state.appearance.fontSize`),18);
    await window.webContents.executeJavaScript(`document.querySelector('[aria-label="关闭编辑器外观"]').click()`);
    console.log('Web editor preferences passed: live font size, browser persistence, chat width expansion and preserved chat component.');
    console.log('Web navigation and fast-index UI passed: history, sources, peek, implementations, progress, drafts, verified symbol opening, stale-hash rejection and refreshed retry.');
  } catch (error) {
    console.error(error);
    console.error('Fixture language requests:', requests.map((request) => request.operation));
    if (window) console.error('Reference diagnostics:', await monaco('({ editors: monaco.editor.getEditors().map(item => ({ id: item.getId(), uri: item.getModel()?.uri.toString(), connected: item.getDomNode()?.isConnected })), widgets: [...document.querySelectorAll(".zone-widget,.peekview-widget")].map(node => ({ className: node.className, text: node.textContent.slice(0, 600) })), options: editor.getOption(monaco.editor.EditorOption.gotoLocation), reference: !!editor.getContribution("editor.contrib.referencesController") })').catch(() => null));
    if (window) console.error(await window.webContents.executeJavaScript('document.body.innerText.slice(-2000)').catch(() => 'page unavailable'));
    exitCode = 1;
  }
  finally { clearTimeout(deadline); window?.destroy(); syntaxIndex?.close(); if (server) await new Promise((resolve) => server.close(resolve)); app.exit(exitCode); }
});
