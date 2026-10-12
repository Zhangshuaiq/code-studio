// Read-only real project. Application databases and drafts use an isolated profile.
// JDT/Java execution are intentionally excluded to measure the fast-index path.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createHash } = require('node:crypto');
const { createLocalApi } = require('../src/local-api.cjs');
const { summary } = require('./benchmark-real-workspace.cjs');
let api, window, directory;
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { console.error('UI index benchmark timed out'); app.exit(1); }, 120000);
const evaluate = async source => {
  try { return await window.webContents.executeJavaScript(source); }
  catch (error) { throw new Error(`${error.message}\nExpression: ${source.slice(0, 300)}`); }
};
async function waitFor(source, timeout = 20000) {
  const until = performance.now() + timeout;
  while (performance.now() < until) { if (await evaluate(source)) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Benchmark UI condition timed out');
}
app.whenReady().then(async () => {
  let exit = 0;
  try {
    const root = fs.realpathSync(process.argv[2] || '.');
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'index-ui-benchmark-'));
    const runs = [];
    for (const cache of ['empty-application-cache', 'reopened-persistent-cache']) {
      api = await createLocalApi({ staticDir: path.join(__dirname, '../renderer'), storePath: path.join(directory, 'state.sqlite3'), lspDataRoot: path.join(directory, 'language') });
      const project = api.registerWorkspace(root);
      const base = `${api.origin}/api/local/projects/${project.id}`;
      const get = async route => {
        const response = await fetch(`${base}/${route}`, { headers: { Authorization: `Bearer ${api.token}` } });
        if (!response.ok) throw new Error(`Benchmark API response ${response.status}`);
        return response.json();
      };
      window = new BrowserWindow({ show: true, width: 1440, height: 950, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, partition: `index-bench-${Date.now()}` } });
      const forbidden = [], excluded = [];
      window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
        const url = new URL(details.url);
        const remote = /^https?:/.test(url.protocol) && url.origin !== api.origin;
        const semantic = /\/language\/(prepare|definition|declaration|type-definition|implementation|references|hover|completion|diagnostics|rename|code-actions|call-hierarchy[^/]*|document-symbols|workspace-symbols)$/.test(url.pathname) || /\/java-run\/targets$/.test(url.pathname);
        const mutation = !['GET', 'HEAD'].includes(details.method) && !/\/language\/(fast-symbols|fast-document-symbols|index-status)$/.test(url.pathname) && !/\/symbols$/.test(url.pathname);
        if (remote || (mutation && !semantic)) forbidden.push({ kind: remote ? 'external' : 'mutation' });
        if (semantic) excluded.push(true);
        callback({ cancel: remote || mutation || semantic });
      });
      const navigationStart = performance.now();
      await window.loadURL(api.origin);
      await waitFor(`[...document.querySelectorAll('button h2')].some(node => node.textContent === ${JSON.stringify(project.name)})`);
      const projectListMs = performance.now() - navigationStart;
      await evaluate(`(() => {
        window.__metrics = { frames: [], tasks: [], inputs: [], pendingInputs: [], scrolls: [], pendingScrolls: [], scrollChanges: 0, active: true, phase: 'loading', longTaskSupported: PerformanceObserver.supportedEntryTypes.includes('longtask') };
        let previous = performance.now();
        const frame = now => { const m = window.__metrics; if (!m.active) return; m.frames.push({ phase: m.phase, ms: now - previous }); previous = now; requestAnimationFrame(frame); };
        requestAnimationFrame(frame);
        if (window.__metrics.longTaskSupported) new PerformanceObserver(list => { for (const entry of list.getEntries()) window.__metrics.tasks.push({ phase: window.__metrics.phase, ms: entry.duration }); }).observe({ entryTypes: ['longtask'] });
        document.addEventListener('input', () => { const m = window.__metrics; if (m.phase === 'code-input') return; const start = m.pendingInputs.shift(), phase = m.phase; if (start !== undefined) requestAnimationFrame(() => m.inputs.push({ phase, ms: performance.now() - start })); }, true);
        document.addEventListener('wheel', () => { const m = window.__metrics, start = m.pendingScrolls.shift(); if (start !== undefined) requestAnimationFrame(() => m.scrolls.push(performance.now() - start)); }, { capture: true, passive: true });
      })()`);
      const indexingStart = performance.now();
      await evaluate(`[...document.querySelectorAll('button h2')].find(node => node.textContent === ${JSON.stringify(project.name)}).closest('button').click()`);
      await waitFor(`!!document.querySelector('input[placeholder="全局搜索"]')`);
      const fileTreeUiMs = performance.now() - indexingStart;
      const tree = await get('files');
      const cachedStart = performance.now();
      const cached = await get('language/fast-symbols?query=Service');
      const cachedSearchMs = performance.now() - cachedStart;
      await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', metaKey: ${process.platform === 'darwin'}, ctrlKey: ${process.platform !== 'darwin'}, bubbles: true, cancelable: true }))`);
      await waitFor(`!!document.querySelector('input[placeholder="文件名；@ 符号；# 全文；> 动作"]')`);
      const inputSelector = 'input[placeholder="文件名；@ 符号；# 全文；> 动作"]';
      window.focus(); window.webContents.focus();
      let expectedInputs = 0;
      const uiInput = async text => {
        await evaluate(`(() => { const input = document.querySelector(${JSON.stringify(inputSelector)}); input.focus(); input.select(); })()`);
        for (const character of text) {
          await evaluate(`window.__metrics.pendingInputs.push(performance.now())`);
          window.webContents.sendInputEvent({ type: 'char', keyCode: character }); expectedInputs++;
        }
        await waitFor(`document.querySelector(${JSON.stringify(inputSelector)})?.value === ${JSON.stringify(text)}`);
      };
      let done = false, loadingInputs = 0, finalIndex;
      for (let i = 0; performance.now() - indexingStart < 60000; i++) {
        await uiInput(i % 2 ? '@Controller' : '@Service'); loadingInputs++;
        const status = await get('language/index-status');
        finalIndex = status.index;
        if (['ready', 'partial'].includes(status.index.state)) { done = true; break; }
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      if (!done) throw new Error(`Fast index did not settle within the benchmark window: ${JSON.stringify(finalIndex)}`);
      const indexReadyMs = performance.now() - indexingStart;
      await evaluate(`window.__metrics.phase = 'ready'`);
      const searchSamples = [];
      for (let i = 0; i < 30; i++) {
        await uiInput(i % 2 ? '@Controller' : '@Service');
        const before = performance.now(); await get(`language/fast-symbols?query=${i % 2 ? 'Controller' : 'Service'}`); searchSamples.push(performance.now() - before);
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      const sourceFile = tree.items.filter(item => item.type === 'file' && item.path.endsWith('.java') && item.size <= 256 * 1024).sort((left, right) => right.size - left.size)[0];
      if (!sourceFile) throw new Error('A bounded Java file is required for code editor measurements');
      const sourcePath = path.join(root, sourceFile.path);
      const sourceHash = createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex');
      await evaluate(`window.__metrics.phase = 'editor-open'`);
      await uiInput(sourceFile.path);
      await waitFor(`[...document.querySelectorAll('button')].some(button => button.textContent.includes(${JSON.stringify(sourceFile.path)}))`);
      const editorStart = performance.now();
      await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.includes(${JSON.stringify(sourceFile.path)})).click()`);
      await waitFor(`!!document.querySelector('.monaco-editor textarea')`);
      await evaluate(`new Promise(resolve => window.require(['vs/editor/editor.main'], module => { window.__monaco = window.monaco || module; window.__benchEditor = window.__monaco.editor.getEditors().find(editor => editor.getModel()?.uri.scheme === 'codegen' && editor.getDomNode()?.isConnected); resolve(); }))`);
      await waitFor(`!!window.__benchEditor?.getModel()`);
      const fileEditorReadyMs = performance.now() - editorStart;
      const editorMetadata = await evaluate(`(() => {
        const editor = window.__benchEditor, model = editor.getModel();
        window.__benchBaseline = model.getValue();
        const line = model.getLineCount(), column = model.getLineMaxColumn(line);
        editor.executeEdits('benchmark-draft', [{ range: new window.__monaco.Range(line, column, line, column), text: ${JSON.stringify('\n// benchmark typing ')} }]);
        editor.setPosition({ lineNumber: model.getLineCount(), column: model.getLineMaxColumn(model.getLineCount()) }); editor.focus();
        window.__metrics.phase = 'code-input'; window.__metrics.modelChanges = 0;
        model.onDidChangeContent(() => { const m = window.__metrics; m.modelChanges++; const start = m.pendingInputs.shift(), phase = m.phase; if (start !== undefined) requestAnimationFrame(() => m.inputs.push({ phase, ms: performance.now() - start })); });
        editor.onDidScrollChange(event => { if (event.scrollTopChanged) window.__metrics.scrollChanges++; });
        return { lines: model.getLineCount(), characters: model.getValueLength(), scrollHeight: editor.getScrollHeight(), viewportHeight: editor.getLayoutInfo().height };
      })()`);
      const typed = 'abcdefghijklmnopqrstuvwxyz0123';
      for (const character of typed) {
        await evaluate(`window.__metrics.pendingInputs.push(performance.now())`);
        window.webContents.sendInputEvent({ type: 'char', keyCode: character }); expectedInputs++;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      await waitFor(`window.__benchEditor.getModel().getValue().endsWith(${JSON.stringify(typed)})`);
      await evaluate(`window.__metrics.phase = 'code-scroll'; window.__benchEditor.setScrollTop(window.__benchEditor.getScrollHeight() / 2)`);
      const scrollPoint = await evaluate(`(() => { const box = window.__benchEditor.getDomNode().getBoundingClientRect(); return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }; })()`);
      for (let i = 0; i < 30; i++) {
        await evaluate(`window.__metrics.pendingScrolls.push(performance.now())`);
        window.webContents.sendInputEvent({ type: 'mouseWheel', ...scrollPoint, deltaX: 0, deltaY: i < 15 ? -250 : 250, wheelTicksX: 0, wheelTicksY: i < 15 ? -1 : 1, hasPreciseScrollingDeltas: true, canScroll: true });
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      await new Promise(resolve => setTimeout(resolve, 100));
      const metrics = await evaluate(`window.__metrics.active = false; window.__metrics`);
      if (metrics.inputs.length !== expectedInputs) throw new Error(`Missing input samples (${metrics.inputs.length}/${expectedInputs}, pending ${metrics.pendingInputs.length}); do not report an incomplete latency measurement`);
      if (metrics.modelChanges !== typed.length || metrics.scrolls.length !== 30 || metrics.scrollChanges < 20) throw new Error(`Editor input/scroll samples incomplete: ${metrics.modelChanges}/${metrics.scrolls.length}/${metrics.scrollChanges}, layout ${JSON.stringify(editorMetadata)}`);
      await evaluate(`window.__benchEditor.getModel().setValue(window.__benchBaseline)`);
      if (createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex') !== sourceHash) throw new Error('Source changed during benchmark; discard these measurements');
      const summarizePhase = phase => ({
        frameIntervals: metrics.frames.some(item => item.phase === phase) ? summary(metrics.frames.filter(item => item.phase === phase).map(item => item.ms)) : null,
        inputToNextFrame: metrics.inputs.some(item => item.phase === phase) ? summary(metrics.inputs.filter(item => item.phase === phase).map(item => item.ms)) : null,
        longTaskSupported: metrics.longTaskSupported,
        longTasks: metrics.longTaskSupported ? metrics.tasks.filter(item => item.phase === phase).length : null,
        longTaskMaxMs: Math.max(0, ...metrics.tasks.filter(item => item.phase === phase).map(item => item.ms)),
      });
      if (forbidden.length) throw new Error('Unexpected remote/mutating request; benchmark stopped');
      runs.push({ cache, projectListMs, fileTreeUiMs, indexReadyMs, index: finalIndex, treeEntries: tree.items.length, treeTruncated: tree.truncated, cachedSearch: { elapsedMs: cachedSearchMs, results: cached.items.length, state: cached.index.state, complete: cached.index.complete }, searchHttp: summary(searchSamples), loading: summarizePhase('loading'), ready: summarizePhase('ready'), editor: { fileEditorReadyMs, ...editorMetadata, input: summarizePhase('code-input'), scroll: summarizePhase('code-scroll'), wheelToNextFrame: summary(metrics.scrolls), verifiedModelChanges: metrics.modelChanges, verifiedScrollChanges: metrics.scrollChanges, sourceHashPreserved: true }, excludedSemanticRequests: excluded.length });
      window.destroy(); window = null; await api.close(); api = null;
    }
    console.log(JSON.stringify({ project: path.basename(root), runtime: { electron: process.versions.electron, node: process.versions.node, arch: process.arch }, machine: { cpu: os.cpus()[0]?.model, memoryBytes: os.totalmem() }, runs, method: 'Visible Electron production renderer and actual Local API/SQLite worker; real project read-only, isolated application state, same persisted cache reused on second run. Input latency uses webContents char event through React/Monaco to next rAF; includes IPC scheduling, not OS keyboard hardware or visual pixel presentation. Editor input/scroll is measured after indexing, with all model changes and wheel samples verified, temporary comment draft restored and source SHA-256 unchanged. Loading phase includes workspace UI startup and may include already-complete indexing. HTTP search excludes UI debounce/render. Frames/long tasks are renderer only; JDT/Java target discovery and all source mutations blocked. OS disk cache uncontrolled. Not packaged ASAR, web server, cold disk or semantic-service performance.' }, null, 2));
  } catch (error) { console.error(error); exit = 1; }
  finally { window?.destroy(); await api?.close(); clearTimeout(deadline); if (directory) fs.rmSync(directory, { recursive: true, force: true }); app.exit(exit); }
});
