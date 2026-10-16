import { workspacePathFromUri } from './monaco';
type Link = { path: string; line: number; column: number; direction: string; label: string };
type Row = { line: number; column: number; links: Link[] };
export function installWorkspaceRelations(editor: any, monaco: any, options: {
  request: (input: Record<string, unknown>) => Promise<any>;
  open: (path: string, line: number, column: number) => Promise<unknown> | void;
}) {
  let disposed = false, generation = 0, failures = 0, pendingKey = '', pendingGeneration = -1, timer: ReturnType<typeof setTimeout>, retryTimer: ReturnType<typeof setTimeout>, rows: Row[] = [], widget: any;
  const decorations = editor.createDecorationsCollection();
  editor.getDomNode()?.classList.add('workspace-relations-editor');
  // Give folding and navigation their own hit areas rather than stacking two
  // decorations on top of each other in Monaco's default narrow lane.
  editor.updateOptions({ lineDecorationsWidth: 30 });
  const close = () => { if (widget) { editor.removeOverlayWidget(widget); widget = undefined; } };
  const navigate = (link: Link) => { close(); void Promise.resolve(options.open(link.path, link.line, link.column)).catch(() => {}); };
  const select = (row: Row, showScope = false) => {
    close();
    if (!showScope && row.links.length === 1) { navigate(row.links[0]); return; }
    const node = document.createElement('div'); node.className = 'workspace-relation-picker'; node.setAttribute('role', 'dialog'); node.setAttribute('aria-label', '选择跳转目标');
    const cancel = document.createElement('button'); cancel.textContent = '选择跳转目标 · 关闭'; cancel.onclick = close; node.append(cancel);
    for (const link of row.links) {
      const button = document.createElement('button'); button.textContent = `${link.direction === 'up' ? '↑' : '↓'} ${link.label} — ${link.path}:${link.line}`;
      button.title = button.textContent; button.onclick = () => navigate(link); node.append(button);
    }
    node.onkeydown = event => { if (event.key === 'Escape') { close(); editor.focus(); } };
    widget = { getId: () => 'workspace-relation-picker', getDomNode: () => node, getPosition: () => ({ preference: monaco.editor.OverlayWidgetPositionPreference.TOP_CENTER }) };
    editor.addOverlayWidget(widget); cancel.focus();
  };
  async function update() {
    const model = editor.getModel(), path = workspacePathFromUri(model?.uri);
    if (disposed || !model || !path || path.startsWith('@java-source/') || !/\.(java|xml)$/.test(path)) return;
    const version = model.getVersionId();
    const key = `${model.uri.toString()}:${version}`; if (pendingKey === key && pendingGeneration === generation) return;
    pendingKey = key; const serial = ++generation; pendingGeneration = serial; clearTimeout(retryTimer);
    try {
      const body = await options.request({ path, content: model.getValue() });
      if (disposed || generation !== serial || model.isDisposed() || editor.getModel() !== model || model.getVersionId() !== version) return;
      rows = (body.result?.rows || []).filter((row: Row) => row.line > 0 && row.line <= model.getLineCount() && row.links.length);
      failures = 0;
      decorations.set(rows.map(row => ({ range: new monaco.Range(row.line, 1, row.line, 1), options: {
        linesDecorationsClassName: `workspace-relation-arrow workspace-relation-${row.links.every(l => l.direction === 'up') ? 'up' : row.links.every(l => l.direction === 'down') ? 'down' : 'both'}`,
        linesDecorationsTooltip: [...row.links.map(l => `${l.direction === 'up' ? '↑' : '↓'} ${l.label}`), ...(body.result.incomplete ? ['关联索引未完整加载'] : [])].join('\n'),
      } })));
    } catch {
      // Startup, worker contention and transient transport failures must not
      // remove the navigation markers permanently until the next edit.
      if (!disposed && generation === serial && editor.getModel() === model && model.getVersionId() === version && ++failures <= 3) retryTimer = setTimeout(() => void update(), failures * 2000);
    } finally { if (pendingGeneration === serial) pendingKey = ''; }
  }
  const schedule = () => { ++generation; failures = 0; clearTimeout(timer); clearTimeout(retryTimer); close(); rows = []; decorations.clear(); timer = setTimeout(() => void update(), 700); };
  const projectImplementation = editor.addAction({
    id: 'workspace-project-implementations', label: '跳转项目内实现（声明索引）',
    contextMenuGroupId: 'navigation', contextMenuOrder: 1.6,
    run: async () => {
      const model = editor.getModel(), position = editor.getPosition(), path = workspacePathFromUri(model?.uri);
      if (!model || !position || !path?.endsWith('.java') || path.startsWith('@java-source/')) return;
      const version = model.getVersionId();
      let body: any;
      try { body = await options.request({ path, content: model.getValue(), line: position.lineNumber, column: position.column }); }
      catch { body = { error: true }; }
      if (disposed || model.isDisposed() || editor.getModel() !== model || model.getVersionId() !== version) return;
      const links = (body.result?.rows || []).flatMap((row: Row) => row.links);
      // Always disclose scope, including empty/partial results; keep the full
      // language-server implementation action unchanged in the context menu.
      select({ line: position.lineNumber, column: position.column, links }, true);
      if (widget) {
        const heading = widget.getDomNode().firstChild;
        heading.textContent = body.error ? '项目索引暂不可用，请稍后重试 · 关闭' : `${body.result?.incomplete ? '索引尚未完整加载 · ' : ''}项目内声明匹配${links.length ? '' : '：未找到，请将光标放在声明名称上或使用 Go to Implementations'} · 关闭`;
      }
    },
  });
  const listeners = [editor.onDidChangeModel(schedule), editor.onDidChangeModelContent(schedule), editor.onDidFocusEditorText(() => { if (!rows.length) void update(); }), editor.onMouseDown((event: any) => {
    if (event.target?.type !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS || event.event?.browserEvent?.button !== 0) return;
    const hit = event.event.browserEvent.target || event.target.element;
    if (!hit?.closest?.('.workspace-relation-arrow')) return;
    const row = rows.find(item => item.line === event.target.position?.lineNumber); if (!row) return;
    event.event.browserEvent.preventDefault(); select(row);
  })];
  const refresh = setInterval(() => { const node = editor.getDomNode(); if (document.visibilityState === 'visible' && node?.isConnected && node.offsetParent !== null) void update(); }, 15000);
  const dispose = () => { disposed = true; ++generation; clearTimeout(timer); clearTimeout(retryTimer); clearInterval(refresh); close(); decorations.clear(); projectImplementation.dispose(); editor.getDomNode()?.classList.remove('workspace-relations-editor'); listeners.forEach(listener => listener.dispose()); };
  editor.onDidDispose(dispose); schedule(); return { dispose };
}
