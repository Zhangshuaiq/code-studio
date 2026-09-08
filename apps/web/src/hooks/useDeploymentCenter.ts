import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

export interface RuntimeBinding {
  id: string;
  projectId: string;
  targetId: string;
  purpose: "preview" | "deploy";
  environment: string;
  branchPattern: string;
  enabled: boolean;
  config?: Record<string, unknown> | null;
  target: {
    id: string;
    name: string;
    kind: string;
    summary?: string | null;
    purposes?: string[];
    labels?: string[];
    enabled: boolean;
  };
}

export interface DeploymentProject {
  id: string;
  name: string;
  language: string;
  status: string;
  team: { id: string; name: string } | null;
  remote: { branch: string; remoteUrl: string } | null;
  accessRole: string;
  environments: RuntimeBinding[];
  deployment: {
    id: string;
    status: string;
    environment: string;
    branch: string | null;
    targetName: string | null;
    datasourceId: string | null;
    datasourceName: string | null;
    targetId: string | null;
    containerId: string | null;
    url: string | null;
    deployedByName: string | null;
    updatedAt: string;
  } | null;
}

export interface DeploymentRecord {
  id: string;
  projectId: string;
  targetName: string | null;
  datasourceId: string | null;
  datasourceName: string | null;
  environment: string;
  branch: string;
  gitSha: string | null;
  status: string;
  url: string | null;
  logsTail: string | null;
  deployedByName: string;
  createdAt: string;
  updatedAt: string;
  project: {
    id: string;
    name: string;
    team: { id: string; name: string } | null;
  };
}

export interface DeploymentStatus {
  status: "none" | "building" | "running" | "failed" | "stopped";
  image?: string | null;
  containerId?: string | null;
  url?: string | null;
  logsTail?: string | null;
  runtimeLogs?: string | null;
  runtimeEvents?: string | null;
  updatedAt?: string;
}

export function useDeploymentProjects() {
  return useQuery<DeploymentProject[]>({
    queryKey: ["deployment-center-projects"],
    queryFn: async () => (await api.get("/deployment-center/projects")).data,
    refetchInterval: (query) =>
      query.state.data?.some((item) => item.deployment?.status === "building")
        ? 3000
        : false,
  });
}

export function useDeploymentBranches(projectId?: string) {
  return useQuery<{ current: string; list: string[] }>({
    queryKey: ["deployment-center-branches", projectId],
    enabled: !!projectId,
    queryFn: async () =>
      (await api.get(`/deployment-center/projects/${projectId}/branches`)).data,
  });
}

export function useDeploymentRecords(projectId?: string) {
  return useQuery<DeploymentRecord[]>({
    queryKey: ["deployment-records", projectId],
    queryFn: async () =>
      (await api.get("/deployment-center/records", { params: { projectId } }))
        .data.items,
    refetchInterval: (query) =>
      query.state.data?.some((item) => item.status === "building")
        ? 3000
        : false,
  });
}

export function useDeploymentStatus(projectId?: string) {
  return useQuery<DeploymentStatus>({
    queryKey: ["deployment-status", projectId],
    enabled: !!projectId,
    queryFn: async () => (await api.get(`/deployment-center/projects/${projectId}/status`)).data,
    refetchInterval: (query) => query.state.data?.status === "building" ? 3000 : 15_000,
  });
}

export function useDeploymentCenterActions() {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["deployment-center-projects"] });
    qc.invalidateQueries({ queryKey: ["deployment-records"] });
    qc.invalidateQueries({ queryKey: ["deployment-status"] });
  };
  const deploy = useMutation({
    mutationFn: (body: {
      projectId: string;
      bindingId: string;
      branch: string;
    }) => api.post("/deployment-center/deploy", body),
    onSuccess: invalidate,
  });
  const stop = useMutation({
    mutationFn: (projectId: string) =>
      api.post(`/deployment-center/projects/${projectId}/stop`),
    onSuccess: invalidate,
  });
  const saveBinding = useMutation({
    mutationFn: (body: {
      projectId: string;
      targetId: string;
      purpose: "preview" | "deploy";
      environment: string;
      branchPattern?: string;
      enabled?: boolean;
      config?: Record<string, unknown>;
    }) => api.post("/deployment-center/bindings", body),
    onSuccess: invalidate,
  });
  const removeBinding = useMutation({
    mutationFn: (id: string) => api.delete(`/deployment-center/bindings/${id}`),
    onSuccess: invalidate,
  });
  return { deploy, stop, saveBinding, removeBinding };
}
