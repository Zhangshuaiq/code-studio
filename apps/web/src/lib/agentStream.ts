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
  let taskId: string | undefined;
  let terminal = false;
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

  if (!(await validateResponse(res, handlers))) return;
  await consume(res);

  // POST 已成功入队后只按 taskId 恢复订阅；绝不重放原始生成请求。
  for (let attempt = 1; !terminal && taskId && attempt <= 3; attempt += 1) {
    await delay(attempt * 1_000);
    try {
      res = await fetch(`/api/agent/tasks/${encodeURIComponent(taskId)}/stream`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    } catch {
      continue;
    }
    if (!(await validateResponse(res, handlers, attempt === 3))) {
      if (res.status === 401) {
        terminal = true;
        break;
      }
      continue;
    }
    await consume(res);
  }

  if (!terminal) {
    handlers.onError?.(
      taskId
        ? '实时连接已中断，任务仍在后台执行，可在任务中心查看最终结果'
        : '请求连接已中断，请确认任务是否成功提交',
    );
  }

  async function consume(response: Response) {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
          if (!dataLine) continue;
          const json = dataLine.slice(5).trim();
          if (!json) continue;
          try {
            const msg = JSON.parse(json);
            if (msg.type === 'queued') {
              taskId = msg.taskId;
              handlers.onQueued?.(msg.taskId);
            } else if (msg.type === 'event') {
              handlers.onEvent?.(msg.event);
            } else if (msg.type === 'done') {
              terminal = true;
              handlers.onDone?.(msg);
            } else if (msg.type === 'error') {
              terminal = true;
              handlers.onError?.(msg.message);
            }
          } catch {
            // 单个非法事件不应中止仍在工作的任务流。
          }
        }
      }
    } catch {
      // 网络异常由外层按已有 taskId 恢复订阅。
    } finally {
      reader.releaseLock();
    }
  }
}

async function validateResponse(
  response: Response,
  handlers: Handlers,
  reportError = true,
) {
  if (response.status === 401) {
    useAuth.getState().logout();
    handlers.onError?.('登录已过期');
    return false;
  }
  if (!response.ok || !response.body) {
    if (reportError) handlers.onError?.(`请求失败 (HTTP ${response.status})`);
    return false;
  }
  return true;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
}
