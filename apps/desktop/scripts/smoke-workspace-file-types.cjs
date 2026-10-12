const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const assert = require('node:assert/strict');
const { createLocalApi } = require('../src/local-api.cjs');
const { encodeText } = require('@codegen/code-intelligence/file-text.cjs');
app.on('window-all-closed', () => {});
let api; let window; let directory;
async function waitFor(expression) {
  for (let i = 0; i < 300; i++) { if (await window.webContents.executeJavaScript(expression)) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Not reached: ${expression}`);
}
app.whenReady().then(async () => {
  let exitCode = 0;
  const deadline = setTimeout(() => app.exit(1), 120000);
  try {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mixed-workspace-ui-'));
    const root = path.join(directory, 'Mixed Project'); fs.mkdirSync(root);
    const files = { 'Main.java': 'class Main {}', 'settings.json': '{"mixed":true}', 'pom.xml': '<project/>', 'migration.sql': 'SELECT 1;', 'run.sh': '#!/bin/sh\necho ok', '.env': 'NAME=local', 'Dockerfile': 'FROM scratch', 'README.md': '# Mixed Workspace\n\n| Name | Value |\n| --- | --- |\n| Test | 1 |\n\n![local](logo.png)\n![tracking](https://tracker.invalid/x.png)\n<script>window.__markdownExecuted=true</script>\n[unsafe](javascript:alert(1))\n' };
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(root, name), content);
    for (const [name, content] of Object.entries({ 'mvnw': '#!/bin/sh\necho build', 'schema.svg.xml': '<schema/>', 'notes.custom': 'Unknown extension text', 'Guide.MDWN': '# Alternate Markdown' })) fs.writeFileSync(path.join(root, name), content);
    fs.writeFileSync(path.join(root, 'README.md'), files['README.md'] += '\n[Source](migration.sql#L2C3)\n[Guide](guide.md#target-section)\n[Section](#mixed-workspace)\n[Missing](#missing-section)\n[Escape](../outside.md)\n');
    fs.writeFileSync(path.join(root, 'migration.sql'), 'SELECT 1;\nSELECT 2;\n');
    fs.writeFileSync(path.join(root, 'guide.md'), '# Guide\n\n' + 'Padding\n\n'.repeat(100) + '## Target Section\n\nTarget reached.\n' + 'Tail\n\n'.repeat(100));
    fs.writeFileSync(path.join(root, 'native.sql'), encodeText('SELECT 你好;\r\n', { encoding: 'utf-16le', bom: true }));
    fs.writeFileSync(path.join(root, 'logo.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRuoAAAAASUVORK5CYII=', 'base64'));
    api = await createLocalApi({ staticDir: path.join(__dirname, '../renderer'), storePath: path.join(directory, 'store.sqlite3'), lspDataRoot: path.join(directory, 'language') }); api.registerWorkspace(root);
    window = new BrowserWindow({ show: false, width: 1300, height: 900, webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false } });
    await window.loadURL(api.origin); await waitFor(`[...document.querySelectorAll('button h2')].some(node => node.textContent === 'Mixed Project')`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button h2')].find(node => node.textContent === 'Mixed Project').closest('button').click()`);
    for (const [name, language] of [['Main.java', 'java'], ['settings.json', 'json'], ['pom.xml', 'xml'], ['migration.sql', 'sql'], ['run.sh', 'shell'], ['.env', 'ini'], ['Dockerfile', 'dockerfile'], ['mvnw', 'shell'], ['schema.svg.xml', 'xml'], ['notes.custom', 'plaintext'], ['Guide.MDWN', 'markdown'], ['README.md', 'markdown']]) {
      await waitFor(`[...document.querySelectorAll('li > button')].some(button => button.title === ${JSON.stringify(name)})`);
      await window.webContents.executeJavaScript(`[...document.querySelectorAll('li > button')].find(button => button.title === ${JSON.stringify(name)}).click()`);
      await waitFor(`typeof window.require === 'function' && !!document.querySelector('.monaco-editor .view-lines')`);
      await waitFor(`new Promise(resolve => window.require(['vs/editor/editor.main'], module => { const monaco = window.monaco || module; resolve(monaco.editor.getEditors().some(editor => editor.getModel()?.uri.path.endsWith(${JSON.stringify('/' + name)}) && editor.getModel().getLanguageId() === ${JSON.stringify(language)})); }))`);
    }
    await window.webContents.executeJavaScript(`document.querySelector('[aria-label="Markdown 视图"] button:nth-child(2)').click()`);
    await waitFor(`document.querySelector('[data-markdown-preview] h1')?.textContent === 'Mixed Workspace' && !!document.querySelector('[data-markdown-preview] table') && document.querySelector('[data-markdown-preview] img[alt="local"]')?.naturalWidth === 1`);
    assert.equal(await window.webContents.executeJavaScript(`!!window.__markdownExecuted || !!document.querySelector('[data-markdown-preview] a[href^="javascript:"]') || !!document.querySelector('[data-markdown-preview] img[src^="https:"]')`), false);
    await window.webContents.executeJavaScript(`document.querySelector('[aria-label="Markdown 视图"] button:nth-child(3)').click()`);
    await window.webContents.executeJavaScript(`new Promise(resolve => window.require(['vs/editor/editor.main'], module => { const monaco = window.monaco || module; const editor = monaco.editor.getEditors().find(editor => editor.getModel()?.uri.path.endsWith('/README.md')); editor.executeEdits('smoke', [{ range: new monaco.Range(1, 1, 1, 18), text: '# Edited Workspace' }]); resolve(); }))`);
    await waitFor(`document.querySelector('[data-markdown-preview] h1')?.textContent === 'Edited Workspace'`);
    assert.equal(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), files['README.md'], 'preview must not auto-save');
    await window.webContents.executeJavaScript(`document.querySelector('li > button[title="settings.json"]').click()`);
    await window.webContents.executeJavaScript(`document.querySelector('li > button[title="README.md"]').click()`);
    await waitFor(`new Promise(resolve => window.require(['vs/editor/editor.main'], module => { const monaco = window.monaco || module; resolve(monaco.editor.getEditors().some(editor => editor.getModel()?.uri.path.endsWith('/README.md') && editor.getValue().startsWith('# Edited Workspace'))); }))`);
    console.log('Desktop mixed-file/Markdown UI passed: language recognition, dotfile visibility, source/preview/split, GFM table, local image, safe HTML handling, live draft and tab recovery without auto-save.');
    await window.webContents.executeJavaScript(`document.querySelector('[aria-label="Markdown 视图"] button:nth-child(2)').click()`);
    await waitFor(`!!document.querySelector('[data-markdown-preview] a')`);
    const clickLink = label => window.webContents.executeJavaScript(`[...document.querySelectorAll('[data-markdown-preview] a')].find(link => link.textContent === ${JSON.stringify(label)}).click()`);
    await clickLink('Missing'); await waitFor(`document.body.textContent.includes('未找到该章节')`);
    await clickLink('Source');
    await waitFor(`new Promise(resolve => window.require(['vs/editor/editor.main'], module => { const monaco = window.monaco || module; const editor = monaco.editor.getEditors().find(editor => editor.getModel()?.uri.path.endsWith('/migration.sql')); resolve(editor?.getPosition().lineNumber === 2 && editor.getPosition().column === 3); }))`);
    await window.webContents.executeJavaScript(`document.querySelector('li > button[title="README.md"]').click()`);
    await waitFor(`!!document.querySelector('[aria-label="Markdown 视图"]')`);
    await window.webContents.executeJavaScript(`document.querySelector('[aria-label="Markdown 视图"] button:nth-child(2)').click()`);
    await waitFor(`document.querySelector('[data-markdown-preview] h1')?.textContent === 'Edited Workspace'`);
    await clickLink('Guide');
    await waitFor(`(() => { const heading = document.querySelector('[data-markdown-preview] h2'); if (heading?.id !== 'target-section') return false; const pane = heading.closest('article').parentElement.getBoundingClientRect(); const rect = heading.getBoundingClientRect(); return rect.top >= pane.top - 3 && rect.bottom <= pane.bottom; })()`);
    assert.equal(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), files['README.md']);
    console.log('Desktop Markdown links passed: missing chapter feedback, SQL line/column navigation, cross-file chapter preview, local scope and unsaved draft preservation.');
    await window.webContents.executeJavaScript(`document.querySelector('li > button[title="native.sql"]').click()`);
    await waitFor(`document.querySelector('[data-file-encoding]')?.textContent.includes('UTF-16LE') && document.querySelector('.monaco-editor .view-lines')?.textContent.includes('你好')`);
    await window.webContents.executeJavaScript(`new Promise(resolve => window.require(['vs/editor/editor.main'], module => { const monaco = window.monaco || module; monaco.editor.getEditors().find(editor => editor.getModel()?.uri.path.endsWith('/native.sql')).getModel().setValue('SELECT 修改😀;\\r\\n'); resolve(); }))`);
    await waitFor(`[...document.querySelectorAll('button')].some(button => button.textContent.trim() === '保存' && !button.disabled)`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === '保存').click()`);
    await waitFor(`!document.querySelector('button[title="native.sql"] .rounded-full')`);
    assert.deepEqual(fs.readFileSync(path.join(root, 'native.sql')), encodeText('SELECT 修改😀;\r\n', { encoding: 'utf-16le', bom: true }));
    console.log('Desktop UTF-16 UI passed: decoded Chinese/emoji, native encoding indicator and saved exact BOM/LE/CRLF bytes.');
  } catch (error) { console.error(error); exitCode = 1; }
  finally { clearTimeout(deadline); window?.destroy(); await api?.close(); if (directory) fs.rmSync(directory, { recursive: true, force: true }); app.exit(exitCode); }
});
