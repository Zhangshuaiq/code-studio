import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

export function JavaRunConfigurationDialog({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (!ref.current || event.defaultPrevented) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); return; }
      // A Select menu is portalled outside the dialog; let it handle its keys first.
      if (ref.current.querySelector('[aria-expanded="true"][aria-controls]')) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(); }
      if (event.key !== 'Tab') return;
      const items = [...ref.current.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),[tabindex="0"]')].filter(node => node.offsetParent !== null);
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); if (previous?.isConnected) previous.focus(); };
  }, []);
  return createPortal(<div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 p-4" data-java-run-modal>
    <section ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} className="card max-h-[85vh] w-full max-w-2xl overflow-auto p-5 text-xs">
      <header className="mb-5 flex items-center justify-between"><h2 id={titleId} className="text-sm font-semibold">运行 / 调试配置</h2><button type="button" className="icon-btn" aria-label="关闭运行配置" onClick={onClose}><X size={16} /></button></header>
      {children}
    </section>
  </div>, document.body);
}
