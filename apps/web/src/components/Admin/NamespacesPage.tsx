import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  Plus,
  Trash2,
  RefreshCw,
  Box,
  Package,
  Server,
  Boxes,
  Layers3,
} from "lucide-react";
import {
  useK8sTargets,
  useNamespaces,
  useCreateNamespace,
  useDeleteNamespace,
  usePods,
  useDeployments,
  useServices,
  useDeletePod,
  useScaleDeployment,
  useRestartDeployment,
  usePodLogs,
} from "../../hooks/useK8s";
import { useFeedback } from "../common/FeedbackProvider";
import { Select } from "../common/Select";
import { useMe } from "../../hooks/useMe";
import { ACCESS } from "../../lib/access";

type Tab = "pods" | "deployments" | "services";

const K8S_BUILTIN_NAMESPACES = new Set([
  "default",
  "kube-system",
  "kube-public",
  "kube-node-lease",
]);

function isBusinessNamespace(name: string) {
  return !K8S_BUILTIN_NAMESPACES.has(name) && !name.startsWith("kube-");
}

export function NamespacesPage() {
  const targets = useK8sTargets();
  const me = useMe();
  const canManage = me.data?.permissions.includes(ACCESS.namespaces) ?? false;
  const { toast, confirm: askConfirm, prompt: askPrompt } = useFeedback();
  const [selectedTarget, setSelectedTarget] = useState<string>("");
  const [selectedNamespace, setSelectedNamespace] = useState<string>("");
  const [tab, setTab] = useState<Tab>("pods");
  const [newNsName, setNewNsName] = useState("");
  const [showCreateModal, setShowCreateModal] = useState(false);

  const namespaces = useNamespaces(selectedTarget);
  const createNs = useCreateNamespace(selectedTarget);
  const deleteNs = useDeleteNamespace(selectedTarget);

  const pods = usePods(selectedTarget, selectedNamespace);
  const deployments = useDeployments(selectedTarget, selectedNamespace);
  const services = useServices(selectedTarget, selectedNamespace);

  const deletePod = useDeletePod(selectedTarget, selectedNamespace);
  const scaleDeployment = useScaleDeployment(selectedTarget, selectedNamespace);
  const restartDeployment = useRestartDeployment(
    selectedTarget,
    selectedNamespace,
  );

  const [selectedPod, setSelectedPod] = useState<string>();
  const podLogs = usePodLogs(selectedTarget, selectedNamespace, selectedPod);

  const handleCreateNamespace = async () => {
    if (!newNsName.trim()) return;
    try {
      await createNs.mutateAsync(newNsName);
      setNewNsName("");
      setShowCreateModal(false);
      toast(`Namespace「${newNsName.trim()}」已创建`, {
        title: "创建成功",
        tone: "success",
      });
    } catch (err: any) {
      toast(err?.response?.data?.message || "创建失败", {
        title: "创建 Namespace 失败",
        tone: "error",
      });
    }
  };

  const handleDeleteNamespace = async (name: string) => {
    if (
      !(await askConfirm({
        title: "删除 Namespace",
        message: `确认删除 Namespace「${name}」？其中的所有资源也会被删除。`,
        confirmText: "删除 Namespace",
        tone: "danger",
      }))
    )
      return;
    try {
      await deleteNs.mutateAsync(name);
      if (selectedNamespace === name) {
        setSelectedNamespace("");
      }
      toast(`Namespace「${name}」已删除`, {
        title: "删除成功",
        tone: "success",
      });
    } catch (err: any) {
      toast(err?.response?.data?.message || "删除失败", {
        title: "删除 Namespace 失败",
        tone: "error",
      });
    }
  };

  const handleDeletePod = async (name: string) => {
    if (
      !(await askConfirm({
        title: "删除 Pod",
        message: `确认删除 Pod「${name}」？控制器可能会自动创建新的实例。`,
        confirmText: "删除 Pod",
        tone: "danger",
      }))
    )
      return;
    try {
      await deletePod.mutateAsync(name);
    } catch (err: any) {
      toast(err?.response?.data?.message || "删除失败", {
        title: "删除 Pod 失败",
        tone: "error",
      });
    }
  };

  const handleScaleDeployment = async (
    name: string,
    currentReplicas: number,
  ) => {
    const input = await askPrompt({
      title: "调整 Deployment 副本数",
      message: `${name} 当前有 ${currentReplicas} 个副本。`,
      initialValue: String(currentReplicas),
      inputType: "number",
      confirmText: "应用副本数",
      validate: (value) => {
        const next = Number(value);
        return Number.isInteger(next) && next >= 0
          ? undefined
          : "请输入大于或等于 0 的整数";
      },
    });
    if (input === null) return;
    const replicas = Number(input);
    try {
      await scaleDeployment.mutateAsync({ name, replicas });
      toast(`${name} 已调整为 ${replicas} 个副本`, {
        title: "扩缩容指令已提交",
        tone: "success",
      });
    } catch (err: any) {
      toast(err?.response?.data?.message || "扩缩容失败", {
        title: "扩缩容失败",
        tone: "error",
      });
    }
  };

  const handleRestartDeployment = async (name: string) => {
    if (
      !(await askConfirm({
        title: "重启 Deployment",
        message: `确认滚动重启 Deployment「${name}」？`,
        confirmText: "确认重启",
        tone: "danger",
      }))
    )
      return;
    try {
      await restartDeployment.mutateAsync(name);
      toast(`Deployment「${name}」正在滚动重启`, {
        title: "重启指令已提交",
        tone: "success",
      });
    } catch (err: any) {
      toast(err?.response?.data?.message || "重启失败", {
        title: "重启失败",
        tone: "error",
      });
    }
  };

  const targetList = targets.data || [];
  const nsList = useMemo(
    () => (namespaces.data || []).filter((ns) => isBusinessNamespace(ns.name)),
    [namespaces.data],
  );
  const podList = pods.data || [];
  const deploymentList = deployments.data || [];
  const serviceList = services.data || [];

  useEffect(() => {
    if (!selectedTarget && targetList.length > 0) {
      setSelectedTarget(targetList[0].id);
    }
  }, [selectedTarget, targetList]);

  useEffect(() => {
    if (
      nsList.length > 0 &&
      !nsList.some((namespace) => namespace.name === selectedNamespace)
    ) {
      setSelectedNamespace(nsList[0].name);
    }
  }, [selectedNamespace, nsList]);

  const isRefreshing =
    namespaces.isFetching ||
    pods.isFetching ||
    deployments.isFetching ||
    services.isFetching;

  const handleRefresh = () => {
    namespaces.refetch();
    if (selectedNamespace) {
      pods.refetch();
      deployments.refetch();
      services.refetch();
    }
  };

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex items-center gap-3">
          <div className="grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg shadow-indigo-500/20">
            <Layers3 size={22} />
          </div>
          <div>
            <p className="eyebrow">Kubernetes workspace</p>
            <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
              Namespace 资源
            </h1>
            <p className="mt-1 text-sm text-muted">
              在一个工作台内查看 Pod、Deployment 与 Service
            </p>
          </div>
        </div>

        {targetList.length > 0 && (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="min-w-0 sm:w-72">
              <span className="label mb-1.5">当前集群</span>
              <Select
                value={selectedTarget}
                onChange={(value) => {
                  setSelectedTarget(value);
                  setSelectedNamespace("");
                }}
                options={targetList.map((target) => ({
                  value: target.id,
                  label: target.name,
                }))}
              />
            </div>
            <button
              onClick={handleRefresh}
              disabled={isRefreshing}
              className="btn btn-ghost mt-auto"
              title="刷新当前资源"
            >
              <RefreshCw
                size={16}
                className={isRefreshing ? "animate-spin" : ""}
              />
              刷新
            </button>
          </div>
        )}
      </header>

      {targetList.length === 0 && !targets.isLoading ? (
        <div className="card px-6 py-16 text-center">
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-slate-100 text-slate-400 dark:bg-slate-800">
            <Boxes size={24} />
          </div>
          <h2 className="mt-4 text-sm font-semibold">暂无 Kubernetes 集群</h2>
          <p className="mt-1 text-xs text-muted">
            请先在部署目标中配置 Kubernetes 集群。
          </p>
        </div>
      ) : (
        <>
          <section className="card p-4 sm:p-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                    Namespaces
                  </h2>
                  <span className="status-pill">{nsList.length}</span>
                </div>
                <p className="mt-1 text-xs text-muted">
                  仅显示业务命名空间，Kubernetes 内置命名空间已隐藏
                </p>
              </div>
              {canManage && (
                <button
                  onClick={() => setShowCreateModal(true)}
                  disabled={!selectedTarget}
                  className="btn btn-primary btn-sm"
                >
                  <Plus size={14} />
                  新建 Namespace
                </button>
              )}
            </div>

            {namespaces.isLoading ? (
              <div className="surface-soft py-7 text-center text-xs text-muted">
                正在读取 Namespace…
              </div>
            ) : nsList.length === 0 ? (
              <div className="surface-soft py-7 text-center text-xs text-muted">
                当前集群暂无业务 Namespace
              </div>
            ) : (
              <div className="flex max-h-36 flex-wrap gap-2 overflow-y-auto pr-1">
                {nsList.map((namespace) => {
                  const active = selectedNamespace === namespace.name;
                  return (
                    <div
                      key={namespace.name}
                      className={`group flex items-center overflow-hidden rounded-xl border transition-all ${
                        active
                          ? "border-indigo-300 bg-indigo-50 text-indigo-800 shadow-sm dark:border-indigo-500/40 dark:bg-indigo-500/10 dark:text-indigo-200"
                          : "border-slate-200 bg-white/70 text-slate-600 hover:border-slate-300 hover:shadow-sm dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-400 dark:hover:border-slate-600"
                      }`}
                    >
                      <button
                        onClick={() => setSelectedNamespace(namespace.name)}
                        className="flex items-center gap-2 px-3 py-2 text-xs font-medium"
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${
                            namespace.status === "Active"
                              ? "bg-emerald-500"
                              : "bg-amber-500"
                          }`}
                        />
                        {namespace.name}
                      </button>
                      {canManage && (
                        <button
                          onClick={() => handleDeleteNamespace(namespace.name)}
                          className="mr-1 grid h-7 w-7 place-items-center rounded-lg text-slate-400 opacity-0 transition hover:bg-red-50 hover:text-red-600 group-hover:opacity-100 focus:opacity-100 dark:hover:bg-red-500/10"
                          title={`删除 ${namespace.name}`}
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {selectedNamespace && (
            <>
              <section className="grid gap-3 sm:grid-cols-3">
                <ResourceTab
                  active={tab === "pods"}
                  icon={<Box size={18} />}
                  label="Pods"
                  count={podList.length}
                  tone="indigo"
                  onClick={() => setTab("pods")}
                />
                <ResourceTab
                  active={tab === "deployments"}
                  icon={<Package size={18} />}
                  label="Deployments"
                  count={deploymentList.length}
                  tone="violet"
                  onClick={() => setTab("deployments")}
                />
                <ResourceTab
                  active={tab === "services"}
                  icon={<Server size={18} />}
                  label="Services"
                  count={serviceList.length}
                  tone="sky"
                  onClick={() => setTab("services")}
                />
              </section>

              <section className="card overflow-hidden">
                <div className="flex items-center justify-between border-b px-4 py-3 dark:border-slate-800 sm:px-5">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-slate-900 dark:text-white">
                      {tab === "pods"
                        ? "Pods"
                        : tab === "deployments"
                          ? "Deployments"
                          : "Services"}
                    </span>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 font-mono text-[10px] text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                      {selectedNamespace}
                    </span>
                  </div>
                  <span className="text-[11px] text-muted">
                    Pods 与 Deployments 每 5 秒自动更新
                  </span>
                </div>
                <div className="overflow-x-auto p-4 sm:p-5">
                  {tab === "pods" && (
                    <PodsTable
                      pods={podList}
                      loading={pods.isLoading}
                      onDelete={canManage ? handleDeletePod : undefined}
                      onViewLogs={(name) => setSelectedPod(name)}
                    />
                  )}
                  {tab === "deployments" && (
                    <DeploymentsTable
                      deployments={deploymentList}
                      loading={deployments.isLoading}
                      onScale={canManage ? handleScaleDeployment : undefined}
                      onRestart={canManage ? handleRestartDeployment : undefined}
                    />
                  )}
                  {tab === "services" && (
                    <ServicesTable
                      services={serviceList}
                      loading={services.isLoading}
                    />
                  )}
                </div>
              </section>
            </>
          )}
        </>
      )}

      {/* 创建 Namespace 模态框 */}
      {canManage && showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-sm">
          <div className="card w-full max-w-sm p-5">
            <h2 className="text-base font-semibold">创建 Namespace</h2>
            <p className="mb-4 mt-1 text-xs text-muted">
              在当前 Kubernetes 集群中创建新的命名空间。
            </p>
            <input
              type="text"
              value={newNsName}
              onChange={(e) => setNewNsName(e.target.value)}
              placeholder="namespace-name"
              className="input mb-4 font-mono text-sm"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowCreateModal(false)}
                className="btn btn-ghost btn-sm"
              >
                取消
              </button>
              <button
                onClick={handleCreateNamespace}
                disabled={!newNsName.trim() || createNs.isPending}
                className="btn btn-primary btn-sm"
              >
                {createNs.isPending ? "创建中..." : "创建"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pod 日志模态框 */}
      {selectedPod && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="card flex h-[80vh] w-[90vw] max-w-5xl flex-col overflow-hidden">
            <div className="flex items-center justify-between border-b px-4 py-2.5 dark:border-slate-800">
              <h2 className="text-sm font-semibold">Pod 日志: {selectedPod}</h2>
              <button
                onClick={() => setSelectedPod(undefined)}
                className="btn btn-ghost btn-sm"
              >
                关闭
              </button>
            </div>
            <div className="flex-1 overflow-auto rounded-b-lg bg-slate-950 p-3 font-mono text-[11px] leading-relaxed text-slate-100">
              <pre className="whitespace-pre-wrap">
                {podLogs.data?.logs || "加载中..."}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ResourceTab({
  active,
  icon,
  label,
  count,
  tone,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  count: number;
  tone: "indigo" | "violet" | "sky";
  onClick: () => void;
}) {
  const tones = {
    indigo:
      "bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300",
    violet:
      "bg-violet-50 text-violet-600 dark:bg-violet-500/10 dark:text-violet-300",
    sky: "bg-sky-50 text-sky-600 dark:bg-sky-500/10 dark:text-sky-300",
  };

  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`card flex items-center gap-3 p-4 text-left transition-all hover:-translate-y-0.5 hover:shadow-lg ${
        active
          ? "ring-2 ring-indigo-500/50"
          : "ring-1 ring-transparent hover:ring-slate-200 dark:hover:ring-slate-700"
      }`}
    >
      <span
        className={`grid h-10 w-10 place-items-center rounded-xl ${tones[tone]}`}
      >
        {icon}
      </span>
      <span>
        <span className="block text-xs font-medium text-muted">{label}</span>
        <span className="mt-0.5 block text-xl font-bold tracking-tight text-slate-900 dark:text-white">
          {count}
        </span>
      </span>
    </button>
  );
}

// Pods 表格组件
function PodsTable({
  pods,
  loading,
  onDelete,
  onViewLogs,
}: {
  pods: any[];
  loading: boolean;
  onDelete?: (name: string) => void;
  onViewLogs: (name: string) => void;
}) {
  if (loading) {
    return <div className="py-6 text-center text-xs text-muted">加载中...</div>;
  }

  if (pods.length === 0) {
    return <div className="py-6 text-center text-xs text-muted">暂无 Pod</div>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b text-[10px] uppercase tracking-wider text-muted dark:border-slate-800">
            <th className="pb-2.5 text-left font-semibold">名称</th>
            <th className="pb-2.5 text-left font-semibold">状态</th>
            <th className="pb-2.5 text-left font-semibold">就绪</th>
            <th className="pb-2.5 text-left font-semibold">重启</th>
            <th className="pb-2.5 text-left font-semibold">IP</th>
            <th className="pb-2.5 text-left font-semibold">节点</th>
            <th className="pb-2.5 text-right font-semibold">操作</th>
          </tr>
        </thead>
        <tbody>
          {pods.map((pod) => (
            <tr
              key={pod.name}
              className="border-b transition-colors last:border-0 hover:bg-slate-50/80 dark:border-slate-800 dark:hover:bg-slate-800/40"
            >
              <td className="py-3 font-mono font-medium">{pod.name}</td>
              <td className="py-3">
                <span
                  className={`inline-flex items-center rounded-full px-2 py-1 text-[10px] font-semibold ${
                    pod.status === "Running"
                      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400"
                      : "bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400"
                  }`}
                >
                  {pod.status}
                </span>
              </td>
              <td className="py-3">{pod.ready}</td>
              <td className="py-3">{pod.restarts}</td>
              <td className="py-3 font-mono text-[10px] text-muted">
                {pod.ip}
              </td>
              <td className="py-3 text-[10px] text-muted">{pod.node}</td>
              <td className="py-3 text-right">
                <button
                  onClick={() => onViewLogs(pod.name)}
                  className="btn btn-ghost btn-sm mr-1 min-h-7 px-2 text-[10px] text-indigo-600 dark:text-indigo-300"
                  title="查看日志"
                >
                  日志
                </button>
                {onDelete && (
                  <button
                    onClick={() => onDelete(pod.name)}
                    className="inline-grid h-7 w-7 place-items-center rounded-lg text-red-500 transition hover:bg-red-50 dark:hover:bg-red-500/10"
                    title="删除"
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Deployments 表格组件
function DeploymentsTable({
  deployments,
  loading,
  onScale,
  onRestart,
}: {
  deployments: any[];
  loading: boolean;
  onScale?: (name: string, replicas: number) => void;
  onRestart?: (name: string) => void;
}) {
  if (loading) {
    return <div className="py-6 text-center text-xs text-muted">加载中...</div>;
  }

  if (deployments.length === 0) {
    return (
      <div className="py-6 text-center text-xs text-muted">暂无 Deployment</div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b text-[10px] uppercase tracking-wider text-muted dark:border-slate-800">
            <th className="pb-2.5 text-left font-semibold">名称</th>
            <th className="pb-2.5 text-left font-semibold">副本数</th>
            <th className="pb-2.5 text-left font-semibold">就绪</th>
            <th className="pb-2.5 text-left font-semibold">可用</th>
            <th className="pb-2.5 text-right font-semibold">操作</th>
          </tr>
        </thead>
        <tbody>
          {deployments.map((dep) => (
            <tr
              key={dep.name}
              className="border-b transition-colors last:border-0 hover:bg-slate-50/80 dark:border-slate-800 dark:hover:bg-slate-800/40"
            >
              <td className="py-3 font-mono font-medium">{dep.name}</td>
              <td className="py-3">{dep.replicas}</td>
              <td className="py-3">{dep.ready}</td>
              <td className="py-3">{dep.available}</td>
              <td className="py-3 text-right">
                {onScale && (
                  <button
                    onClick={() => onScale(dep.name, dep.replicas)}
                    className="btn btn-ghost btn-sm mr-1 min-h-7 px-2 text-[10px] text-indigo-600 dark:text-indigo-300"
                    title="扩缩容"
                  >
                    扩缩容
                  </button>
                )}
                {onRestart && (
                  <button
                    onClick={() => onRestart(dep.name)}
                    className="inline-grid h-7 w-7 place-items-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-white"
                    title="重启"
                  >
                    <RefreshCw size={12} />
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Services 表格组件
function ServicesTable({
  services,
  loading,
}: {
  services: any[];
  loading: boolean;
}) {
  if (loading) {
    return <div className="py-6 text-center text-xs text-muted">加载中...</div>;
  }

  if (services.length === 0) {
    return (
      <div className="py-6 text-center text-xs text-muted">暂无 Service</div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b text-[10px] uppercase tracking-wider text-muted dark:border-slate-800">
            <th className="pb-2.5 text-left font-semibold">名称</th>
            <th className="pb-2.5 text-left font-semibold">类型</th>
            <th className="pb-2.5 text-left font-semibold">Cluster IP</th>
            <th className="pb-2.5 text-left font-semibold">端口</th>
          </tr>
        </thead>
        <tbody>
          {services.map((svc) => (
            <tr
              key={svc.name}
              className="border-b transition-colors last:border-0 hover:bg-slate-50/80 dark:border-slate-800 dark:hover:bg-slate-800/40"
            >
              <td className="py-3 font-mono font-medium">{svc.name}</td>
              <td className="py-3">
                <span className="rounded-full bg-sky-50 px-2 py-1 text-[10px] font-semibold text-sky-700 dark:bg-sky-500/10 dark:text-sky-300">
                  {svc.type}
                </span>
              </td>
              <td className="py-3 font-mono text-[10px] text-muted">
                {svc.clusterIP}
              </td>
              <td className="py-3 text-[10px] text-muted">
                {svc.ports?.join(", ")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
