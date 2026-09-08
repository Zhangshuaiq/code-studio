import { useAuth } from '../store/auth';

// 带鉴权头下载项目 zip（fetch → blob → 触发浏览器下载）
export async function downloadProjectZip(
  sessionId: string,
  filename: string,
): Promise<void> {
  const token = useAuth.getState().token;
  const res = await fetch(`/api/sessions/${sessionId}/files/download`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (res.status === 401) {
    useAuth.getState().logout();
    throw new Error('登录已过期');
  }
  if (!res.ok) throw new Error(`下载失败 (HTTP ${res.status})`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
