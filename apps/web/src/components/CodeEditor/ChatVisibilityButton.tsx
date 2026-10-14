import { MessageSquare } from 'lucide-react';
import { useEditorPreferences } from '../../store/editorPreferences';
export function ChatVisibilityButton() {
  const { chatVisible, setChatVisible } = useEditorPreferences();
  return <button className="icon-btn" aria-label={chatVisible ? '关闭对话区域' : '打开对话区域'} aria-pressed={chatVisible} title={chatVisible ? '关闭对话区域' : '打开对话区域'} onClick={() => setChatVisible(!chatVisible)}><MessageSquare size={16} /></button>;
}
