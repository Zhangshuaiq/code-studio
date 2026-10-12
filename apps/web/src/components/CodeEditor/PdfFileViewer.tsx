import { useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions, version, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;
const assets = `/pdfjs/${version}/`;

export default function PdfFileViewer({ path, rawUrl }: { path: string; rawUrl?: string }) {
  const [document, setDocument] = useState<PDFDocumentProxy>();
  const [pageNumber, setPageNumber] = useState(1);
  const [zoom, setZoom] = useState(1.25);
  const [error, setError] = useState('');
  const [rendering, setRendering] = useState(true);
  const [text, setText] = useState('');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef(rawUrl); sourceRef.current = rawUrl;
  const documentRef = useRef(document); documentRef.current = document;
  const loadedSource = useRef<string>();
  useEffect(() => {
    loadedSource.current = undefined;
    setDocument(undefined); setPageNumber(1); setZoom(1.25); setError(''); setText(''); setRendering(true);
    if (!rawUrl) return;
    let active = true;
    const task = getDocument({ url: rawUrl, cMapUrl: `${assets}cmaps/`, cMapPacked: true, standardFontDataUrl: `${assets}standard_fonts/`, wasmUrl: `${assets}wasm/`, maxImageSize: 16_777_216, canvasMaxAreaInBytes: 32 * 1024 * 1024, enableHWA: false });
    void task.promise.then(value => { if (active) { loadedSource.current = rawUrl; setDocument(value); } }).catch(reason => {
      if (active) setError(reason?.name === 'PasswordException' ? '此 PDF 已加密，暂不支持密码文件预览' : '无法读取 PDF，请检查文件是否完整');
    });
    return () => { active = false; void task.destroy().catch(() => {}); };
  }, [rawUrl]);
  useEffect(() => {
    if (!document || loadedSource.current !== rawUrl) return;
    let active = true; let render: RenderTask | undefined;
    setRendering(true); setText(''); setError('');
    const draw = async () => {
      try {
        const page = await document.getPage(pageNumber);
        const canvas = canvasRef.current;
        if (!active || !canvas || loadedSource.current !== rawUrl) return;
        const viewport = page.getViewport({ scale: zoom });
        if (!Number.isFinite(viewport.width * viewport.height) || viewport.width <= 0 || viewport.height <= 0) throw new Error('Invalid page dimensions');
        const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(16_777_216 / (viewport.width * viewport.height)));
        canvas.width = Math.max(1, Math.floor(viewport.width * ratio)); canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
        canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
        render = page.render({ canvas, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
        await render.promise;
        if (!active) return;
        canvas.dataset.pdfRendered = 'true'; setRendering(false);
        const content = await page.getTextContent();
        if (active) setText(content.items.flatMap(item => 'str' in item ? [item.str] : []).join(' ').slice(0, 100000));
      } catch (reason: any) { if (active && reason?.name !== 'RenderingCancelledException') { setRendering(false); setError('PDF 页面无法显示，请尝试其他页面'); } }
    };
    void draw();
    return () => { active = false; render?.cancel(); };
  }, [document, pageNumber, zoom, rawUrl]);
  const fitWidth = async () => {
    if (!document || !containerRef.current) return;
    const current = document;
    const page = await current.getPage(pageNumber);
    if (current !== documentRef.current || rawUrl !== sourceRef.current || !containerRef.current) return;
    setZoom(Math.max(0.25, Math.min(4, (containerRef.current.clientWidth - 48) / page.getViewport({ scale: 1 }).width)));
  };
  return <div className="flex h-full min-h-0 flex-col bg-slate-100 dark:bg-slate-950" data-pdf-viewer>
    <div className="flex shrink-0 items-center justify-center gap-2 border-b border-slate-200 bg-white p-2 text-xs dark:border-slate-800 dark:bg-slate-900">
      <button className="btn btn-ghost btn-sm" disabled={!document || pageNumber <= 1} onClick={() => setPageNumber(value => value - 1)}>上一页</button>
      <span>{pageNumber} / {document?.numPages || '—'} 页</span>
      <button className="btn btn-ghost btn-sm" disabled={!document || pageNumber >= document.numPages} onClick={() => setPageNumber(value => value + 1)}>下一页</button>
      <button className="btn btn-ghost btn-sm" aria-label="缩小 PDF" disabled={!document || zoom <= 0.25} onClick={() => setZoom(value => Math.max(0.25, value - 0.25))}>−</button>
      <span>{Math.round(zoom * 100)}%</span>
      <button className="btn btn-ghost btn-sm" aria-label="放大 PDF" disabled={!document || zoom >= 4} onClick={() => setZoom(value => Math.min(4, value + 0.25))}>+</button>
      <button className="btn btn-ghost btn-sm" disabled={!document} onClick={() => void fitWidth().catch(() => {})}>适应宽度</button>
    </div>
    <div ref={containerRef} className="relative min-h-0 flex-1 overflow-auto p-6">
      {error ? <div role="status" className="grid h-full place-items-center text-sm text-muted">{error}</div> : <>
        {rendering && <div role="status" className="mb-3 text-center text-xs text-muted">正在加载 PDF…</div>}
        <canvas key={`${rawUrl}:${pageNumber}:${zoom}`} ref={canvasRef} aria-label={`${path} 第 ${pageNumber} 页`} className="mx-auto bg-white shadow-lg" />
        <p className="sr-only" data-pdf-text>{text}</p>
      </>}
    </div>
  </div>;
}
