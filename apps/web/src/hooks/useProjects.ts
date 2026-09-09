import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../store/auth';

export interface Project {
  id: string;
  userId: string;
  name: string;
  language: string;
  status: string;
  importError?: string | null;
  importAttempts?: number;
  accessRole: 'owner' | 'maintainer' | 'developer' | 'viewer';
  createdAt: string;
  teamId?: string;
  team?: {
    id: string;
    name: string;
    members?: Array<{ id: string; username: string; email?: string }>;
  };
  members?: Array<{
    role: 'maintainer' | 'developer' | 'viewer';
    user: { id: string; username: string; email: string | null };
  }>;
  _count?: { members: number };
  remote?: { remoteUrl: string; branch: string } | null;
}

export function useProjects() {
  const token = useAuth((s) => s.token);
  return useQuery<Project[]>({
    queryKey: ['projects'],
    enabled: !!token,
    queryFn: async () => (await api.get('/projects', { params: { pageSize: 200 } })).data.items,
    refetchInterval: (query) =>
      query.state.data?.some((project) =>
        ['import_queued', 'importing'].includes(project.status),
      )
        ? 3_000
        : false,
  });
}

export function useProject(id?: string) {
  const token = useAuth((s) => s.token);
  return useQuery<Project>({
    queryKey: ['project', id],
    enabled: !!token && !!id,
    queryFn: async () => (await api.get(`/projects/${id}`)).data,
  });
}

export function useProjectMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['projects'] });

  const create = useMutation({
    mutationFn: (input: {
      source: 'blank' | 'git';
      name: string;
      language: string;
      teamId?: string;
      repositoryUrl?: string;
      defaultBranch?: string;
    }) =>
      api.post('/projects', input).then((r) => r.data as Project),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: ({ id, ...data }: { id: string; name?: string; teamId?: string }) =>
      api.patch(`/projects/${id}`, data),
    onSuccess: () => {
      invalidate();
      qc.invalidateQueries({ queryKey: ['project'] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${id}`),
    onSuccess: invalidate,
  });
  const retryImport = useMutation({
    mutationFn: (id: string) => api.post(`/projects/${id}/import/retry`),
    onSuccess: invalidate,
  });
  return { create, update, remove, retryImport };
}

export interface ProjectRepository {
  remoteUrl: string;
  branch: string;
  updatedAt?: string;
}

export function useProjectRepository(projectId?: string) {
  return useQuery<ProjectRepository | null>({
    queryKey: ['project-repository', projectId],
    enabled: !!projectId,
    queryFn: async () => (await api.get(`/projects/${projectId}/repository`)).data,
  });
}

export function useProjectRepositoryMutations(projectId?: string) {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['project-repository', projectId] });
    qc.invalidateQueries({ queryKey: ['projects'] });
    qc.invalidateQueries({ queryKey: ['project', projectId] });
  };
  const save = useMutation({
    mutationFn: (body: { remoteUrl: string; branch?: string }) =>
      api.put(`/projects/${projectId}/repository`, body),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/projects/${projectId}/repository`),
    onSuccess: invalidate,
  });
  return { save, remove };
}

export function useProjectMembers() {
  const qc = useQueryClient();
  const invalidate = (projectId: string) => {
    qc.invalidateQueries({ queryKey: ['project', projectId] });
    qc.invalidateQueries({ queryKey: ['projects'] });
  };

  const add = useMutation({
    mutationFn: ({
      projectId,
      userIds,
      role,
    }: {
      projectId: string;
      userIds: string[];
      role?: 'maintainer' | 'developer' | 'viewer';
    }) => api.post(`/projects/${projectId}/members`, { userIds, role }),
    onSuccess: (_data, vars) => invalidate(vars.projectId),
  });

  const remove = useMutation({
    mutationFn: ({ projectId, userIds }: { projectId: string; userIds: string[] }) =>
      api.delete(`/projects/${projectId}/members`, { data: { userIds } }),
    onSuccess: (_data, vars) => invalidate(vars.projectId),
  });

  const updateRole = useMutation({
    mutationFn: ({
      projectId,
      userId,
      role,
    }: {
      projectId: string;
      userId: string;
      role: 'maintainer' | 'developer' | 'viewer';
    }) => api.patch(`/projects/${projectId}/members/${userId}`, { role }),
    onSuccess: (_data, vars) => invalidate(vars.projectId),
  });

  return { add, remove, updateRole };
}

// 打开某个项目时，确保它有一个会话可用（复用第一个，否则新建）
export function useProjectSession(projectId?: string) {
  return useQuery<{
    projectId: string;
    sessionId: string;
    workspaceBranch?: string;
    userWorkspace: boolean;
  }>({
    queryKey: ['project-session', projectId],
    enabled: !!projectId,
    staleTime: Infinity,
    queryFn: async () => {
      const sessions = (
        await api.get('/sessions', { params: { projectId } })
      ).data;
      const session =
        sessions[0] ?? (await api.post('/sessions', { projectId })).data;
      return {
        projectId: projectId!,
        sessionId: session.id,
        workspaceBranch: session.workspaceBranch,
        userWorkspace: session.userWorkspace !== false,
      };
    },
  });
}
