import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface DependencyHealth {
  available: boolean;
  latencyMs?: number;
  error?: string;
  [key: string]: unknown;
}

export interface PlatformHealth {
  status: 'healthy' | 'degraded' | 'unavailable';
  checkedAt: string;
  uptimeSeconds: number;
  build: { version:string; gitSha:string; builtAt:string; image:string };
  dependencies: Record<'database' | 'redis' | 'generationExecutor' | 'openSearch' | 'tempo' | 'prometheus', DependencyHealth>;
  operationalIssues: Array<{ code: string; severity: string; count: number; message: string }>;
}

export function usePlatformHealth() {
  return useQuery<PlatformHealth>({
    queryKey: ['platform-health'],
    queryFn: async () => (await api.get('/platform-health')).data,
    refetchInterval: 15_000,
    retry: 1,
  });
}

export interface ProjectResourceUsage {
  generation: { used: number; limit: number; percent: number; active: number };
  previews: { used: number; limit: number; statuses: Record<string, number> };
  sandboxes: { running: number; statuses: Record<string, number>; perInstanceCpu: number; perInstanceMemoryMb: number };
  deployment: { status: string; image?: string | null; updatedAt: string } | null;
}

export function useProjectResourceUsage(projectId: string) {
  return useQuery<ProjectResourceUsage>({
    queryKey: ['project-resource-usage', projectId],
    enabled: !!projectId,
    queryFn: async () => (await api.get(`/platform-health/projects/${projectId}/usage`)).data,
    refetchInterval: 30_000,
  });
}
