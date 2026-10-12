import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useEffect, useMemo, useRef, useState } from 'react';
import { markdownResourcePath, markdownNavigation, remarkHeadingAnchors, type MarkdownNavigation } from '../../lib/markdown-resource';
export type MarkdownImageLoader = (path: string, signal: AbortSignal) => Promise<Blob>;
function MarkdownImage({ path, source, alt, loadImage }: { path: string; source?: string; alt?: string; loadImage?: MarkdownImageLoader }) {
  const resource = source ? markdownResourcePath(path, source) : null;
  const [image, setImage] = useState<{ resource: string; url: string }>();
  useEffect(() => {
    if (!resource || !loadImage) return;
    const controller = new AbortController(); let url: string | undefined;
    void loadImage(resource, controller.signal).then(blob => {
      if (controller.signal.aborted || !blob.type.startsWith('image/')) return;
      url = URL.createObjectURL(blob); setImage({ resource, url });
    }).catch(() => {});
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [resource, loadImage]);
  return image?.resource === resource ? <img src={image.url} alt={alt || ''} className="max-w-full" /> : <span className="text-muted">[图片：{alt || '未命名'}；{resource ? '资源加载中或不可用' : '外部资源未自动加载'}]</span>;
}
export default function MarkdownFilePreview({ content, path, loadImage, onNavigate, anchor, onAnchorApplied }: { content: string; path: string; loadImage?: MarkdownImageLoader; onNavigate?: (target: MarkdownNavigation) => void; anchor?: string; onAnchorApplied?: () => void }) {
  const article = useRef<HTMLElement>(null);
  const [notice, setNotice] = useState('');
  const scroll = (target: string) => {
    const heading = [...(article.current?.querySelectorAll('[id]') || [])].find(node => node.id === target);
    if (heading) { heading.scrollIntoView({ block: 'start' }); setNotice(''); }
    else setNotice('未找到该章节，请确认链接中的章节名称');
  };
  useEffect(() => { if (anchor !== undefined) { scroll(anchor); onAnchorApplied?.(); } }, [anchor, content, onAnchorApplied]);
  const components = useMemo<Components>(() => ({
    a: ({ children, href }) => {
      if (href && /^https?:\/\//i.test(href)) return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
      const target = href ? markdownNavigation(path, href) : null;
      return <a href={target ? '#' : undefined} title={target ? href : '链接路径或位置无效'} aria-disabled={!target || (!onNavigate && target.path !== path)} onClick={event => {
        event.preventDefault(); if (!target) return;
        if (target.path === path && target.anchor) scroll(target.anchor);
        else onNavigate?.(target);
      }}>{children}</a>;
    },
    img: ({ src, alt }) => <MarkdownImage path={path} source={src} alt={alt} loadImage={loadImage} />,
  }), [path, loadImage, onNavigate]);
  if (content.length > 500000) return <div role="status" className="p-6 text-sm text-muted">Markdown 内容较大，请使用源码视图；预览支持最多 500,000 个字符。</div>;
  return <>{notice && <p role="status" className="p-2 text-xs text-amber-600">{notice}</p>}<article ref={article} data-markdown-preview className="workspace-markdown min-h-full overflow-auto p-6 text-sm text-slate-700 dark:text-slate-200">
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkHeadingAnchors]} skipHtml components={components}>{content}</ReactMarkdown>
  </article></>;
}
