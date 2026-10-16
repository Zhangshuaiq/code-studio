import { useEffect, useRef, type ReactNode } from 'react';
import { Panel, PanelResizeHandle, type ImperativePanelHandle } from 'react-resizable-panels';
import { useEditorPreferences } from '../../store/editorPreferences';
export function WorkspaceChatPanel({ children }: { children: ReactNode }) {
  const { chatVisible, setChatVisible } = useEditorPreferences(); const panel = useRef<ImperativePanelHandle>(null);
  useEffect(() => { if (chatVisible) panel.current?.expand(); else panel.current?.collapse(); }, [chatVisible]);
  return <>
    <Panel ref={panel} id="workspace-chat" order={1} defaultSize={chatVisible ? 28 : 0} minSize={18} maxSize={50} collapsible collapsedSize={0} onCollapse={() => { if (useEditorPreferences.persist.hasHydrated()) setChatVisible(false); }} onExpand={() => { if (useEditorPreferences.persist.hasHydrated()) setChatVisible(true); }}>
      <div className="h-full min-w-0" style={{ visibility: chatVisible ? 'visible' : 'hidden' }} aria-hidden={!chatVisible} data-workspace-chat>{children}</div>
    </Panel>
    <PanelResizeHandle aria-label="调整项目对话宽度" className="resize-handle-x" disabled={!chatVisible} style={{ display: chatVisible ? undefined : 'none' }} />
  </>;
}
