import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { File } from "lucide-react";
import { workspaceFileLanguage } from '../../lib/workspace-file-type';
import type { MarkdownImageLoader } from './MarkdownFilePreview';
import type { MarkdownNavigation } from '../../lib/markdown-resource';
const PdfFileViewer = lazy(() => import('./PdfFileViewer'));
const MarkdownFilePreview = lazy(() => import('./MarkdownFilePreview'));
export interface WorkspaceFileView {
  kind: "text" | "image" | "pdf" | "spreadsheet" | "unsupported";
  mime: string;
  reason?: string;
  readOnly?: boolean;
  sheets?: Array<{ name: string; rows: string[][] }>;
  truncated?: boolean;
  language?: string;
  preview?: string;
  encoding?: string;
  bom?: boolean;
}
export function WorkspaceFileViewer({
  rawUrl,
  path,
  view,
  children,
  content,
  loadMarkdownImage,
  onMarkdownNavigate,
  markdownAnchor,
  onMarkdownAnchorApplied,
}: {
  rawUrl?: string;
  path: string;
  view: WorkspaceFileView;
  children?: ReactNode;
  content?: string;
  loadMarkdownImage?: MarkdownImageLoader;
  onMarkdownNavigate?: (target: MarkdownNavigation) => void;
  markdownAnchor?: string;
  onMarkdownAnchorApplied?: () => void;
}) {
  const [sheetIndex, setSheetIndex] = useState(0);
  const [imageFailed, setImageFailed] = useState(false);
  const [textMode, setTextMode] = useState<'source' | 'preview' | 'split'>('source');
  useEffect(() => setTextMode('source'), [path]);
  useEffect(() => { if (markdownAnchor !== undefined) setTextMode('preview'); }, [path, markdownAnchor]);
  useEffect(() => setSheetIndex(0), [path]);
  useEffect(() => setImageFailed(false), [path, rawUrl]);
  if (view.kind === "text") {
    const label = view.encoding && (view.encoding !== 'utf-8' || view.bom) ? `${view.encoding.toUpperCase()}${view.bom ? ' · BOM' : ''}` : '';
    if ((view.language || workspaceFileLanguage(path)) !== 'markdown') return label ? <div className="flex h-full min-h-0 flex-col"><p data-file-encoding className="shrink-0 border-b border-slate-200 px-3 py-1 text-[10px] text-muted dark:border-slate-800">{label} · 保存时保留原编码</p><div className="min-h-0 flex-1">{children}</div></div> : <>{children}</>;
    return <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 gap-1 border-b border-slate-200 px-2 py-1 dark:border-slate-800" aria-label="Markdown 视图">
        {(['source', 'preview', 'split'] as const).map(mode => <button key={mode} type="button" aria-pressed={textMode === mode} className={`rounded px-3 py-1 text-xs ${textMode === mode ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300' : 'text-muted'}`} onClick={() => setTextMode(mode)}>{({ source: '源码', preview: '预览', split: '分屏' })[mode]}</button>)}
        {label && <span data-file-encoding className="ml-auto self-center text-[10px] text-muted">{label} · 保存时保留原编码</span>}
      </div>
      <div className="flex min-h-0 flex-1">
        <div className={`${textMode === 'preview' ? 'hidden' : 'min-w-0 flex-1'}`}>{children}</div>
        {textMode !== 'source' && <div className="min-w-0 flex-1 overflow-auto border-l border-slate-200 dark:border-slate-800"><Suspense fallback={<div role="status" className="p-6 text-muted">加载 Markdown 预览…</div>}><MarkdownFilePreview path={path} content={content || ''} loadImage={loadMarkdownImage} onNavigate={onMarkdownNavigate} anchor={markdownAnchor} onAnchorApplied={onMarkdownAnchorApplied} /></Suspense></div>}
      </div>
    </div>;
  }
  if (view.kind === "image" && imageFailed) return <div role="status" className="grid h-full place-items-center text-sm text-muted">无法显示此图片，请检查文件是否完整</div>;
  if (view.kind === "image")
    return (
      <div className="grid h-full overflow-auto bg-[linear-gradient(45deg,#e5e7eb_25%,transparent_25%),linear-gradient(-45deg,#e5e7eb_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#e5e7eb_75%),linear-gradient(-45deg,transparent_75%,#e5e7eb_75%)] bg-[length:20px_20px] bg-[position:0_0,0_10px,10px_-10px,-10px_0px] p-6 dark:opacity-90">
        <img
          src={rawUrl}
          alt={path}
          onError={() => setImageFailed(true)}
          className="m-auto max-h-full max-w-full object-contain shadow-xl"
        />
      </div>
    );
  if (view.kind === "pdf")
    return (
      <Suspense fallback={<div role="status" className="grid h-full place-items-center text-sm text-muted">加载 PDF 查看器…</div>}><PdfFileViewer path={path} rawUrl={rawUrl} /></Suspense>
    );
  if (view.kind === "spreadsheet") {
    const sheets = view.sheets || [];
    const sheet = sheets[sheetIndex];
    return (
      <div className="flex h-full min-h-0 flex-col bg-white dark:bg-slate-950">
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-slate-200 p-2 dark:border-slate-800">
          {sheets.map((item, index) => (
            <button
              key={`${item.name}:${index}`}
              type="button"
              onClick={() => setSheetIndex(index)}
              className={`rounded-lg px-3 py-1.5 text-xs ${index === sheetIndex ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"}`}
            >
              {item.name}
            </button>
          ))}
          {view.truncated && (
            <span className="ml-auto self-center text-[10px] text-amber-500">
              大表格预览已截断：最多 20 个工作表、500 行、100 列及 4 MiB 显示内容
            </span>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {sheet ? (
            <table className="min-w-full border-collapse font-mono text-[11px]">
              <tbody>
                {sheet.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    <th className="sticky left-0 z-10 border border-slate-200 bg-slate-100 px-2 py-1 text-right font-normal text-slate-400 dark:border-slate-700 dark:bg-slate-900">
                      {rowIndex + 1}
                    </th>
                    {row.map((cell, columnIndex) => (
                      <td
                        key={columnIndex}
                        className="max-w-80 whitespace-pre-wrap border border-slate-200 px-2 py-1 align-top dark:border-slate-700"
                      >
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="grid h-full place-items-center text-sm text-slate-400">
              表格中没有工作表
            </div>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="grid h-full place-items-center px-8 text-center text-sm text-slate-400">
      <div>
        <File size={28} className="mx-auto mb-3" />
        <p className="font-semibold text-slate-600 dark:text-slate-300">
          暂不支持预览此文件
        </p>
        <p className="mt-1 text-xs">
          {view.reason || "该二进制格式暂时无法在工作区内打开"}
        </p>
      </div>
    </div>
  );
}
