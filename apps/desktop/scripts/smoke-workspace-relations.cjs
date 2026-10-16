const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createLocalApi } = require('../src/local-api.cjs');
const { defaultAppearance } = require('@codegen/code-intelligence/editor-appearance.cjs');
let api, window, directory;
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { console.error('Relation UI smoke timed out'); app.exit(1); }, 90000);
const evaluate = expression => window.webContents.executeJavaScript(expression);
async function waitFor(expression) {
  for (let attempt = 0; attempt < 250; attempt++) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw Error(`UI condition failed: ${expression}`);
}
async function clickArrow(index = 0) {
  const point = await evaluate(`(() => { const rect = document.querySelectorAll('.workspace-relation-arrow')[${index}].getBoundingClientRect(); return {x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2)}; })()`);
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
}
app.whenReady().then(async () => {
  let code = 0;
  try {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relation-ui-'));
    const root = path.join(directory, 'Relation fixture'); fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'UserMapper.java'), 'package p;\npublic interface UserMapper {\n String get();\n}\n');
    fs.writeFileSync(path.join(root, 'UserMapperImpl.java'), 'package p;\nclass UserMapperImpl implements UserMapper {\n public String get(){return "ok";}\n}\n');
    fs.writeFileSync(path.join(root, 'LongFileNameForIconSizing'.repeat(6) + '.java'), 'class IconSizingFixture {}');
    fs.writeFileSync(path.join(root, 'UserMapper.xml'), '<mapper namespace="p.UserMapper">\n<select id="get">select 1</select>\n</mapper>');
    api = await createLocalApi({ staticDir: path.join(__dirname, '../renderer'), storePath: path.join(directory, 'store.sqlite3') });
    const project = api.registerWorkspace(root);
    const relationResponse = await fetch(`${api.origin}/api/local/projects/${project.id}/language/related-locations`, { method: 'POST', headers: { Authorization: `Bearer ${api.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'UserMapper.xml' }) });
    assert.equal(relationResponse.status, 200); assert.equal((await relationResponse.json()).result.rows.length, 1);
    const preferences = await fetch(`${api.origin}/api/local/editor-preferences`, { method: 'PUT', headers: { Authorization: `Bearer ${api.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ navigationKeymap: 'idea', chatVisible: true, appearance: { ...defaultAppearance, fontSize: 11, fontFamily: 'Menlo' } }) });
    assert.equal(preferences.status, 200);
    window = new BrowserWindow({ show: false, width: 1440, height: 950, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, partition: `relation-${Date.now()}` } });
    window.webContents.on('console-message', (_event, details) => { if (details?.level === 'error') console.error('Renderer:', details.message); });
    await window.loadURL(api.origin);
    await evaluate(`(() => { const original = window.fetch.bind(window); window.__relationCalls = 0; window.fetch = (input, init) => { if (String(input).includes('/language/related-locations') && ++window.__relationCalls <= 2) return Promise.resolve(new Response(JSON.stringify({message:'temporary busy'}),{status:503,headers:{'Content-Type':'application/json'}})); return original(input, init); }; })()`);
    await waitFor(`[...document.querySelectorAll('button h2')].some(node => node.textContent === 'Relation fixture')`);
    await evaluate(`[...document.querySelectorAll('button h2')].find(node => node.textContent === 'Relation fixture').closest('button').click()`);
    await waitFor(`!!document.querySelector('[aria-label="调整项目对话宽度"]') && !!document.querySelector('[data-workspace-chat]')`);
    const width = () => evaluate(`document.querySelector('[data-workspace-chat]').getBoundingClientRect().width`);
    const drag = async delta => {
      const point = await evaluate(`(() => { const r = document.querySelector('[aria-label="调整项目对话宽度"]').getBoundingClientRect(); return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)}; })()`);
      window.webContents.sendInputEvent({type:'mouseMove',...point});
      await new Promise(resolve=>setTimeout(resolve,50));
      window.webContents.sendInputEvent({type:'mouseDown',...point,button:'left',clickCount:1});
      await new Promise(resolve=>setTimeout(resolve,50));
      for(let step=1;step<=10;step++) { window.webContents.sendInputEvent({type:'mouseMove',x:Math.round(point.x+delta*step/10),y:point.y,modifiers:['leftButtonDown']}); await new Promise(resolve=>setTimeout(resolve,20)); }
      window.webContents.sendInputEvent({type:'mouseUp',x:point.x+delta,y:point.y,button:'left',clickCount:1});
      await new Promise(resolve=>setTimeout(resolve,200));
    };
    const initialWidth = await width(); await drag(80); const larger = await width(); assert.ok(larger > initialWidth + 30, `right drag should widen chat: ${initialWidth} -> ${larger}`);
    await drag(-80); assert.ok((await width()) < larger - 30, 'left drag should narrow chat');
    await waitFor(`[...document.querySelectorAll('button')].some(node => node.textContent.trim() === 'UserMapper.xml')`);
    await evaluate(`[...document.querySelectorAll('button')].find(node => node.textContent.trim() === 'UserMapper.xml').click()`);
    await waitFor(`document.querySelector('.workspace-relation-up')`);
    const iconWidths = await evaluate(`[...document.querySelectorAll('svg[aria-label="文件类型：java"]')].map(node=>node.getBoundingClientRect().width).filter(width=>width>0)`);
    assert.ok(iconWidths.length >= 3 && iconWidths.every(width => Math.abs(width - 13) < 0.1), 'Java icons should not shrink with long filenames');
    assert.ok(await evaluate(`window.__relationCalls >= 3`), 'markers should recover from transient request failures without another edit');
    await clickArrow();
    await waitFor(`document.querySelector('.monaco-editor .view-lines')?.textContent.replace(/\u00a0/g,' ').includes('interface UserMapper')`);
    await waitFor(`document.querySelector('.workspace-relation-down')`);
    await evaluate(`new Promise(resolve => window.require(['vs/editor/editor.main'], module => { window.__monaco = window.monaco || module; window.__editor = () => window.__monaco.editor.getEditors().find(editor => editor.getModel()?.uri.scheme === 'codegen' && editor.getDomNode()?.isConnected); resolve(); }))`);
    await evaluate(`(() => { const editor = window.__editor(), model = editor.getModel(); editor.focus(); return editor._commandService.executeCommand('editor.action.showReferences', model.uri, {lineNumber:3,column:9}, [{uri:model.uri,range:new window.__monaco.Range(3,2,3,15)}]); })()`);
    await waitFor(`document.querySelector('.reference-zone-widget .monaco-list-row')`);
    const fonts = await evaluate(`(() => { const row = document.querySelector('.reference-zone-widget .monaco-list-row'); const preview = window.__monaco.editor.getEditors().find(editor=>editor!==window.__editor() && editor.getDomNode()?.closest('.reference-zone-widget')); return { size: getComputedStyle(row).fontSize, family: getComputedStyle(row).fontFamily, previewSize: preview?.getOption(window.__monaco.editor.EditorOption.fontSize), previewFamily: preview?.getOption(window.__monaco.editor.EditorOption.fontFamily) }; })()`);
    assert.equal(fonts.size, '11px'); assert.equal(fonts.family, 'Menlo'); assert.equal(fonts.previewSize, 11); assert.equal(fonts.previewFamily, 'Menlo');
    await evaluate(`window.__editor().trigger('test','closeReferenceSearch',null)`);
    const before = await evaluate(`window.__editor().getValue()`);
    await evaluate(`window.__editor().updateOptions({readOnly:true}); window.__editor().trigger('test','type',{text:'x'})`);
    await waitFor(`document.querySelector('.monaco-editor-overlaymessage .message')`);
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.monaco-editor-overlaymessage .message')).fontSize`), '11px');
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.monaco-editor-overlaymessage .message')).fontFamily`), 'Menlo');
    assert.equal(await evaluate(`window.__editor().getValue()`), before);
    await evaluate(`window.__editor().updateOptions({readOnly:false}); window.__editor().setPosition({lineNumber:1,column:1})`);
    // Type-level arrow has one implementation, distinct from breakpoint glyphs.
    await clickArrow();
    await waitFor(`document.querySelector('.monaco-editor .view-lines')?.textContent.replace(/\u00a0/g,' ').includes('class UserMapperImpl')`);
    await waitFor(`document.querySelector('.workspace-relation-up')`);
    await clickArrow();
    await waitFor(`document.querySelector('.monaco-editor .view-lines')?.textContent.replace(/\u00a0/g,' ').includes('interface UserMapper')`);
    await waitFor(`document.querySelectorAll('.workspace-relation-arrow').length >= 2`);
    await clickArrow(1);
    await waitFor(`document.querySelector('[role="dialog"][aria-label="选择跳转目标"]')`);
    await evaluate(`[...document.querySelectorAll('.workspace-relation-picker button')].find(node=>node.textContent.includes('Mapper XML')).click()`);
    await waitFor(`window.__editor().getModel().uri.path.endsWith('UserMapper.xml')`);
    await evaluate(`document.querySelector('button[title="终端"]').click()`);
    await waitFor(`document.querySelector('[data-terminal-tab]') && document.querySelector('.xterm-viewport')`);
    const terminalId = await evaluate(`document.querySelector('[data-terminal-tab]').getAttribute('data-terminal-tab')`);
    for (const [label, color] of [['Darcula','rgb(43, 43, 43)'], ['GitHub 浅色','rgb(255, 255, 255)']]) {
      await evaluate(`document.querySelector('button[aria-label="编辑器外观"]').click()`);
      await evaluate(`document.querySelector('button[aria-label="编辑器主题"]').click()`);
      await waitFor(`[...document.querySelectorAll('[role="option"]')].some(node => node.textContent.trim() === ${JSON.stringify(label)})`);
      await evaluate(`[...document.querySelectorAll('[role="option"]')].find(node=>node.textContent.trim()===${JSON.stringify(label)}).click(); document.querySelector('button[aria-label="关闭编辑器外观"]').click()`);
      await waitFor(`getComputedStyle(document.querySelector('[data-desktop-terminals]')).backgroundColor === ${JSON.stringify(color)} && getComputedStyle(document.querySelector('.xterm-viewport')).backgroundColor === ${JSON.stringify(color)}`);
      assert.equal(await evaluate(`document.querySelector('[data-terminal-tab]').getAttribute('data-terminal-tab')`), terminalId);
    }
    console.log('Relation/terminal UI smoke passed: recovery from transient failures, XML↔Mapper/interface↔implementation, multi-target picker, 11px Menlo reference/read-only messages, terminal live Darcula/GitHub theme changes without replacing session.');
  } catch (error) { console.error(error); if (window && !window.isDestroyed()) console.error(await evaluate(`({ text: document.body.innerText.slice(-500), arrows: document.querySelectorAll('.workspace-relation-arrow').length, editors: [...document.querySelectorAll('.monaco-editor')].map(n=>({cls:n.className, text:n.querySelector('.view-lines')?.textContent?.slice(0,80)})) })`).catch(() => '')); code = 1; }
  finally { clearTimeout(deadline); window?.destroy(); await api?.close(); if (directory) fs.rmSync(directory, { recursive: true, force: true }); app.exit(code); }
});
