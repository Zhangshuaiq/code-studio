import { useAuth } from '../store/auth';

export interface AgentEvent {
  kind: 'text' | 'tool_use' | 'result' | 'system';
  text?: string;
  toolName?: string;
  toolInput?: unknown;
}

export interface DoneResult {
  taskId: string;
  status: 'succeeded' | 'failed';
  log: string;
}

interface Handlers {
  onQueued?: (taskId: string) => void;
  onEvent?: (e: AgentEvent) => void;
  onDone?: (r: DoneResult) => void;
  onError?: (msg: string) => void;
}

// 流式调用 /agent/run/stream：用 fetch 读取 SSE 流（支持 POST + 鉴权头）
export async function streamAgentRun(
  sessionId: string,
  prompt: string,
  handlers: Handlers,
): Promise<void> {
  const token = useAuth.getState().token;
  let res: Response;
  try {
    res = await fetch('/api/agent/run/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ sessionId, prompt }),
    });
  } catch (e) {
    handlers.onError?.(String(e));
    return;
  }

  if (res.status === 401) {
    useAuth.getState().logout();
    handlers.onError?.('登录已过期');
    return;
  }
  if (!res.ok || !res.body) {
    handlers.onError?.(`请求失败 (HTTP ${res.status})`);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    // SSE 帧以空行分隔
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = frame
        .split('\n')
        .find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      const json = dataLine.slice(5).trim();
      if (!json) continue;
      try {
        const msg = JSON.parse(json);
        if (msg.type === 'queued') handlers.onQueued?.(msg.taskId);
        else if (msg.type === 'event') handlers.onEvent?.(msg.event);
        else if (msg.type === 'done') handlers.onDone?.(msg);
        else if (msg.type === 'error') handlers.onError?.(msg.message);
      } catch {
        /* 忽略不完整/非法帧 */
      }
    }
  }
}
