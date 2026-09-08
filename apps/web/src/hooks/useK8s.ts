import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

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
  return useQuery({
    queryKey: ['pod', targetId, namespace, name],
    queryFn: async () => {
      if (!targetId || !namespace || !name) return null;
      const res = await api.get(`/k8s/${targetId}/namespaces/${namespace}/pods/${name}`);
      return res.data;
    },
    enabled: !!targetId && !!namespace && !!name,
  });
}

// Pod 日志
export function usePodLogs(
  targetId: string | undefined,
  namespace: string | undefined,
  name: string | undefined,
) {
  return useQuery({
    queryKey: ['pod-logs', targetId, namespace, name],
    queryFn: async () => {
      if (!targetId || !namespace || !name) return { logs: '' };
      const res = await api.get(`/k8s/${targetId}/namespaces/${namespace}/pods/${name}/logs`);
      return res.data as { logs: string };
    },
    enabled: !!targetId && !!namespace && !!name,
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
