import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface FileChange {
  path: string;
  before: string;
  after: string;
  kind: 'added' | 'modified';
}

// 最近一次生成的文件改动（用于文件树标记 + 编辑器 diff）
export function useSessionChanges(sessionId?: string) {
  return useQuery<FileChange[]>({
    queryKey: ['changes', sessionId],
    enabled: !!sessionId,
    queryFn: async () =>
      (await api.get(`/agent/sessions/${sessionId}/changes`)).data,
  });
}
