import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface SessionTask {
  id: string;
  prompt: string;
  status: string; // queued | running | cancelling | succeeded | failed | cancelled | timed_out
  resultLog?: string | null;
  createdAt: string;
  finishedAt?: string | null;
}

// 拉取某会话的历史任务（用于恢复对话记录）
export function useSessionTasks(sessionId?: string) {
  return useQuery<SessionTask[]>({
    queryKey: ['history', sessionId],
    enabled: !!sessionId,
    queryFn: async () =>
      (await api.get(`/agent/sessions/${sessionId}/tasks?limit=100`)).data,
  });
}
