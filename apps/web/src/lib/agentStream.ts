import { useAuth } from '../store/auth';

export interface AgentEvent {
  kind: 'text' | 'tool_use' | 'result' | 'system' | 'reasoning';
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  sequence?: number;
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

// 先提交任务取得 ID，再订阅；刷新时可直接按 ID 恢复，不重复创建任务。
export async function streamAgentRun(
  sessionId: string,
  prompt: string,
  handlers: Handlers,
): Promise<void> {
  const token = useAuth.getState().token;
  let res: Response;
  try {
    res = await fetch('/api/agent/run/start', {
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
  if (!res.ok) {
    handlers.onError?.(`任务提交失败 (HTTP ${res.status})`);
    return;
  }
  const started = await res.json() as { taskId: string };
  handlers.onQueued?.(started.taskId);
  await watchAgentTask(started.taskId, handlers);
}

export async function watchAgentTask(taskId: string, handlers: Handlers, signal?: AbortSignal): Promise<void> {
  const token = useAuth.getState().token;
  let terminal = false;
  let lastSequence = 0;
  const seenUnsequenced = new Set<string>();
  let pollTimer: number | undefined;
  const streamController = new AbortController();
  const stop = () => streamController.abort();
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  const finish = (result: DoneResult) => {
    if (terminal || streamController.signal.aborted) return;
    terminal = true;
    handlers.onDone?.(result);
    streamController.abort();
  };
  const forward = (event: AgentEvent) => {
    if (terminal || streamController.signal.aborted) return;
    if (event.sequence) {
      if (event.sequence <= lastSequence) return;
      lastSequence = event.sequence;
    } else {
      // 兼容仍在旧 Worker 中运行的任务：轮询和 SSE 可能反复送来同一条进度。
      const fingerprint = JSON.stringify([event.kind, event.text, event.toolName, event.toolInput]);
      if (seenUnsequenced.has(fingerprint)) return;
      seenUnsequenced.add(fingerprint);
    }
    handlers.onEvent?.(event);
  };
  const poll = async () => {
    if (terminal || streamController.signal.aborted) return;
    try {
      const response = await fetch(`/api/agent/tasks/${encodeURIComponent(taskId)}/live`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) return;
      const live = await response.json() as { taskId: string; status: string; log?: string; progress?: AgentEvent };
      if (streamController.signal.aborted) return;
      if (live.progress) forward(live.progress);
      if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(live.status)) {
        finish({ taskId: live.taskId, status: live.status === 'succeeded' ? 'succeeded' : 'failed', log: live.log ?? '' });
      }
    } catch { /* 下一轮继续检查，不重复提交任务。 */ }
  };
  pollTimer = window.setInterval(() => void poll(), 1_500);
  try {
  // 独立订阅已有任务；断线只重连 taskId，绝不重放原始生成请求。
  for (let attempt = 0; !terminal && !streamController.signal.aborted; attempt += 1) {
    await poll();
    if (terminal) break;
    if (attempt) await delay(Math.min(attempt, 5) * 1_000);
    try {
      const res = await fetch(`/api/agent/tasks/${encodeURIComponent(taskId)}/stream`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: streamController.signal,
      });
      if (!(await validateResponse(res, handlers, false))) {
        if (res.status === 401) {
          terminal = true;
          break;
        }
        continue;
      }
      await consume(res);
    } catch {
      continue;
    }
  }

  if (!terminal && !streamController.signal.aborted) {
    handlers.onError?.(
      taskId
        ? '实时连接已中断，任务仍在后台执行，可在任务中心查看最终结果'
        : '请求连接已中断，请确认任务是否成功提交',
    );
  }
  } finally {
    if (pollTimer !== undefined) window.clearInterval(pollTimer);
    signal?.removeEventListener('abort', stop);
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
              handlers.onQueued?.(msg.taskId);
            } else if (msg.type === 'event') {
              forward(msg.event);
            } else if (msg.type === 'done') {
              finish(msg);
            } else if (msg.type === 'error') {
              terminal = true;
              handlers.onError?.(msg.message);
              streamController.abort();
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
