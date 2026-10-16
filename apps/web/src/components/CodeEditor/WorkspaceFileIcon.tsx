import { Database, File, FileArchive, FileCode2, FileImage, FileText, Sheet, Terminal } from 'lucide-react';
import registry from '../../../../../packages/code-intelligence/file-types.json';
import { workspaceFileLanguage } from '../../lib/workspace-file-type';
export function WorkspaceFileIcon({ path, className, size = 13 }: { path: string; className?: string; size?: number }) {
  const extension = path.split('.').pop()?.toLowerCase() || '';
  const language = workspaceFileLanguage(path);
  const image = Object.prototype.hasOwnProperty.call(registry.images, extension);
  const binary = Object.prototype.hasOwnProperty.call(registry.binary, extension);
  const Icon = image ? FileImage : ['pdf', 'md', 'markdown', 'mdown', 'mkd'].includes(extension) ? FileText : ['csv', 'xlsx', 'xls'].includes(extension) ? Sheet : binary ? FileArchive : language === 'sql' ? Database : ['shell', 'powershell', 'bat'].includes(language) ? Terminal : language === 'plaintext' ? File : FileCode2;
  return <Icon size={size} className={`shrink-0 ${className || ''}`} style={{ width: size, height: size, minWidth: size, flexShrink: 0 }} aria-label={`文件类型：${image ? '图片' : binary ? (registry.binary as Record<string, string>)[extension] : extension === 'pdf' ? 'PDF' : language}`} />;
}
