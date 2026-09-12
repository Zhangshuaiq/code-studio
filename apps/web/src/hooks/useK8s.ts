import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface ClusterPod {
  name: string;
  namespace: string;
  phase: string;
  ready: string;
  restarts: number;
  node: string | null;
  podIP: string | null;
  hostIP: string | null;
  images: string[];
  workloadKind: string | null;
  workloadName: string | null;
  createdAt: string | null;
}

export interface ClusterOverview {
  reachable: true;
  observedAt: string;
  target: { id: string; name: string };
  namespaces: string[];
  pods: ClusterPod[];
  deployments: ClusterDeployment[];
}

export interface ClusterDeployment {
  name: string;
  namespace: string;
  desired: number;
  current: number;
  ready: number;
  available: number;
  updated: number;
  images: string[];
  strategy: string;
  createdAt: string | null;
  conditions: Array<{ type: string; status: string; reason: string | null; message: string | null; updatedAt: string | null }>;
}

export interface PodDetail {
  name: string;
  namespace: string;
  status: string;
  ready: string;
  restarts: number;
  age: string | null;
  ip: string | null;
  node: string | null;
  labels: Record<string, string>;
  containers: Array<{ name: string; image: string; ports?: number[]; ready: boolean; restartCount: number; state: Record<string, unknown>; lastState: Record<string, unknown> }>;
  conditions: Array<{ type: string; status: string; reason?: string; message?: string; lastTransitionTime?: string }>;
  events: Array<{ type: string; reason: string | null; message: string | null; count: number; firstAt: string | null; lastAt: string | null; source: string | null }>;
}

export function useClusterOverview(targetId: string | undefined) {
  return useQuery<ClusterOverview>({
    queryKey: ['k8s-cluster-overview', targetId],
    enabled: !!targetId,
    retry: false,
    refetchInterval: 5_000,
    queryFn: async () => (await api.get(`/k8s/${targetId}/overview`)).data,
  });
}

export function useDeleteClusterPod(targetId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ namespace, name }: { namespace: string; name: string }) =>
      api.delete(`/k8s/${targetId}/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(name)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['k8s-cluster-overview', targetId] }),
  });
}

export function useClusterDeploymentActions(targetId: string | undefined) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ['k8s-cluster-overview', targetId] });
  const scale = useMutation({
    mutationFn: ({ namespace, name, replicas }: { namespace: string; name: string; replicas: number }) =>
      api.post(`/k8s/${targetId}/namespaces/${encodeURIComponent(namespace)}/deployments/${encodeURIComponent(name)}/scale`, { replicas }),
    onSuccess: refresh,
  });
  const restart = useMutation({
    mutationFn: ({ namespace, name }: { namespace: string; name: string }) =>
      api.post(`/k8s/${targetId}/namespaces/${encodeURIComponent(namespace)}/deployments/${encodeURIComponent(name)}/restart`),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: ({ namespace, name }: { namespace: string; name: string }) =>
      api.delete(`/k8s/${targetId}/namespaces/${encodeURIComponent(namespace)}/deployments/${encodeURIComponent(name)}`),
    onSuccess: refresh,
  });
  return { scale, restart, remove };
}

// K8s 部署目标
export function useK8sTargets() {
  return useQuery({
    queryKey: ['k8s-targets'],
    queryFn: async () => {
      const res = await api.get('/k8s/targets');
      return res.data as Array<{
        id: string;
        name: string;
        summary: string;
        createdAt: string;
      }>;
    },
  });
}

// Namespace 列表
export function useNamespaces(targetId: string | undefined) {
  return useQuery({
    queryKey: ['namespaces', targetId],
    queryFn: async () => {
      if (!targetId) return [];
      const res = await api.get(`/k8s/${targetId}/namespaces`);
      return res.data as Array<{
        name: string;
        status: string;
        createdAt: string;
        labels: Record<string, string>;
      }>;
    },
    enabled: !!targetId,
  });
}

// 创建 Namespace
export function useCreateNamespace(targetId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      const res = await api.post(`/k8s/${targetId}/namespaces`, { name });
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['namespaces', targetId] });
    },
  });
}

// 删除 Namespace
export function useDeleteNamespace(targetId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      const res = await api.delete(`/k8s/${targetId}/namespaces/${name}`);
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['namespaces', targetId] });
    },
  });
}

// Pod 列表
export function usePods(targetId: string | undefined, namespace: string | undefined) {
  return useQuery({
    queryKey: ['pods', targetId, namespace],
    queryFn: async () => {
      if (!targetId || !namespace) return [];
      const res = await api.get(`/k8s/${targetId}/namespaces/${namespace}/pods`);
      return res.data as Array<{
        name: string;
        namespace: string;
        status: string;
        ready: string;
        restarts: number;
        age: string;
        ip: string;
        node: string;
      }>;
    },
    enabled: !!targetId && !!namespace,
    refetchInterval: 5000, // 5秒自动刷新
  });
}

// Pod 详情
export function usePod(
  targetId: string | undefined,
  namespace: string | undefined,
  name: string | undefined,
) {
  return useQuery<PodDetail | null>({
    queryKey: ['pod', targetId, namespace, name],
    queryFn: async () => {
      if (!targetId || !namespace || !name) return null;
      const res = await api.get(`/k8s/${targetId}/namespaces/${namespace}/pods/${name}`);
      return res.data;
    },
    enabled: !!targetId && !!namespace && !!name,
    retry: false,
    refetchInterval: 5_000,
  });
}

// Pod 日志
export function usePodLogs(
  targetId: string | undefined,
  namespace: string | undefined,
  name: string | undefined,
  container?: string,
  previous = false,
) {
  return useQuery({
    queryKey: ['pod-logs', targetId, namespace, name, container, previous],
    queryFn: async () => {
      if (!targetId || !namespace || !name) return { logs: '' };
      const res = await api.get(`/k8s/${targetId}/namespaces/${namespace}/pods/${name}/logs`, { params: { container, previous, tail: 500 } });
      return res.data as { logs: string };
    },
    enabled: !!targetId && !!namespace && !!name,
    retry: false,
  });
}

// 删除 Pod
export function useDeletePod(targetId: string | undefined, namespace: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      const res = await api.delete(`/k8s/${targetId}/namespaces/${namespace}/pods/${name}`);
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pods', targetId, namespace] });
    },
  });
}

// Deployment 列表
export function useDeployments(targetId: string | undefined, namespace: string | undefined) {
  return useQuery({
    queryKey: ['deployments', targetId, namespace],
    queryFn: async () => {
      if (!targetId || !namespace) return [];
      const res = await api.get(`/k8s/${targetId}/namespaces/${namespace}/deployments`);
      return res.data as Array<{
        name: string;
        namespace: string;
        replicas: number;
        ready: string;
        upToDate: number;
        available: number;
        age: string;
      }>;
    },
    enabled: !!targetId && !!namespace,
    refetchInterval: 5000,
  });
}

// 扩缩容 Deployment
export function useScaleDeployment(targetId: string | undefined, namespace: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ name, replicas }: { name: string; replicas: number }) => {
      const res = await api.post(
        `/k8s/${targetId}/namespaces/${namespace}/deployments/${name}/scale`,
        { replicas },
      );
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['deployments', targetId, namespace] });
    },
  });
}

// 重启 Deployment
export function useRestartDeployment(targetId: string | undefined, namespace: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      const res = await api.post(
        `/k8s/${targetId}/namespaces/${namespace}/deployments/${name}/restart`,
      );
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['deployments', targetId, namespace] });
      qc.invalidateQueries({ queryKey: ['pods', targetId, namespace] });
    },
  });
}

// Service 列表
export function useServices(targetId: string | undefined, namespace: string | undefined) {
  return useQuery({
    queryKey: ['services', targetId, namespace],
    queryFn: async () => {
      if (!targetId || !namespace) return [];
      const res = await api.get(`/k8s/${targetId}/namespaces/${namespace}/services`);
      return res.data as Array<{
        name: string;
        namespace: string;
        type: string;
        clusterIP: string;
        externalIPs: string[];
        ports: string[];
        age: string;
      }>;
    },
    enabled: !!targetId && !!namespace,
  });
}
