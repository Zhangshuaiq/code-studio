import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

export interface DeployStatus {
  status: "none" | "building" | "running" | "failed" | "stopped";
  url?: string | null;
  gitSha?: string | null;
  image?: string | null;
  targetName?: string | null;
  logsTail?: string | null; // 构建日志 / 失败原因
  runtimeLogs?: string | null; // 容器运行时 stdout/stderr
  deploymentKind?: "container" | "k8s" | "artifact";
  artifactPath?: string | null;
}

export interface DeployTarget {
  id: string;
  name: string;
  kind: string;
  summary: string | null;
  scope: "personal" | "team" | "platform";
  teamId: string | null;
  team: { id: string; name: string } | null;
  purposes: Array<"preview" | "deploy">;
  labels: string[];
  enabled: boolean;
  maxPreviewInstances: number;
  capacityCpu: number | null;
  capacityMemoryMb: number | null;
  activePreviewInstances: number;
  createdAt: string;
  updatedAt: string;
}

export interface DeployTargetDetail extends DeployTarget {
  config: {
    host?: string;
    publicHost?: string | null;
    port?: number;
    tls?: boolean;
    username?: string;
    privateKeyConfigured?: boolean;
    passphraseConfigured?: boolean;
    hostFingerprintConfigured?: boolean;
    remotePath?: string;
    restartCmd?: string | null;
    namespace?: string;
    businessNamespaces?: string[];
    baseDomain?: string | null;
    registryId?: string | null;
    kubeconfigConfigured?: boolean;
    kubeconfigValid?: boolean;
    currentContext?: string | null;
    clusterName?: string | null;
    clusterServer?: string | null;
    prometheusUrl?: string | null;
    prometheusAuthConfigured?: boolean;
    prometheusClusterLabel?: string | null;
    prometheusClusterValue?: string | null;
  };
}

export interface Registry {
  id: string;
  name: string;
  summary: string | null;
}

export function useRegistries() {
  return useQuery<Registry[]>({
    queryKey: ["registries"],
    queryFn: async () => (await api.get("/registries")).data,
  });
}

export function useRegistryOps() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["registries"] });
  const create = useMutation({
    mutationFn: (body: { name: string; config: Record<string, any> }) =>
      api.post("/registries", body),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/registries/${id}`),
    onSuccess: invalidate,
  });
  return { create, remove };
}

export function useDeployTargets(purpose?: "preview" | "deploy") {
  return useQuery<DeployTarget[]>({
    queryKey: ["deploy-targets", purpose],
    queryFn: async () =>
      (await api.get("/deploy-targets", { params: { purpose } })).data,
  });
}

export function useDeployTarget(id?: string) {
  return useQuery<DeployTargetDetail>({
    queryKey: ["deploy-targets", id],
    enabled: !!id,
    queryFn: async () => (await api.get(`/deploy-targets/${id}`)).data,
  });
}

export function useDeployTargetOps() {
  const qc = useQueryClient();
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["deploy-targets"] });
  const create = useMutation({
    mutationFn: (body: {
      name: string;
      kind: string;
      config: Record<string, any>;
      scope?: string;
      teamId?: string;
      purposes?: string[];
      labels?: string[];
      enabled?: boolean;
      maxPreviewInstances?: number;
      capacityCpu?: number;
      capacityMemoryMb?: number;
    }) => api.post("/deploy-targets", body),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Record<string, unknown>) =>
      api.patch(`/deploy-targets/${id}`, body),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/deploy-targets/${id}`),
    onSuccess: invalidate,
  });
  return { create, update, remove };
}

export function useDeployStatus(sessionId?: string) {
  return useQuery<DeployStatus>({
    queryKey: ["deploy", sessionId],
    enabled: !!sessionId,
    queryFn: async () => (await api.get(`/sessions/${sessionId}/deploy`)).data,
    // 构建中快轮询；运行中慢轮询（刷新运行日志 + 及时发现崩溃）
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      if (s === "building") return 2500;
      if (s === "running") return 5000;
      return false;
    },
  });
}

export function useDeployActions(sessionId?: string) {
  const qc = useQueryClient();
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["deploy", sessionId] });
  const deploy = useMutation({
    mutationFn: (targetId?: string) =>
      api.post(`/sessions/${sessionId}/deploy`, { targetId }),
    onSuccess: invalidate,
  });
  const stop = useMutation({
    mutationFn: () => api.post(`/sessions/${sessionId}/deploy/stop`),
    onSuccess: invalidate,
  });
  return { deploy, stop };
}
