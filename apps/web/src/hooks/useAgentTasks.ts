import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface AgentTaskItem {
  id: string;
  sessionId: string;
  prompt: string;
  status: 'queued' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
  resultLog?: string | null;
  executorKind?: 'docker' | 'kubernetes' | null;
  executionNamespace?: string | null;
  executionRef?: string | null;
  failureCode?: string | null;
  priority: number;
  resourceWaitCount: number;
  startedAt?: string | null;
  createdAt: string;
  finishedAt?: string | null;
  session: { project: { id: string; name: string; language: string } };
}

export interface AgentTaskPage {
  items: AgentTaskItem[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}

export function useAgentTasks(input: { status?: string; page: number; search?: string }) {
  return useQuery<AgentTaskPage>({
    queryKey: ['agent-task-center', input],
    queryFn: async () => (await api.get('/agent/tasks', { params: { ...input, pageSize: 20 } })).data,
    refetchInterval: (query) => query.state.data?.items.some((x) => ['queued', 'running', 'cancelling'].includes(x.status)) ? 5_000 : false,
  });
}

export function useAgentTaskActions() {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ['agent-task-center'] });
  const retry = useMutation({ mutationFn: (id: string) => api.post(`/agent/tasks/${id}/retry`), onSuccess: refresh });
  const cancel = useMutation({ mutationFn: (id: string) => api.post(`/agent/tasks/${id}/cancel`), onSuccess: refresh });
  return { retry, cancel };
}
