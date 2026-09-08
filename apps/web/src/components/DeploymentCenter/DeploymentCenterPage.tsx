import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Activity,
  Boxes,
  ChevronRight,
  GitBranch,
  History,
  Link2,
  Plus,
  Rocket,
  ServerCog,
  Settings2,
  Square,
  Trash2,
} from "lucide-react";
import {
  RuntimeBinding,
  useDeploymentBranches,
  useDeploymentCenterActions,
  useDeploymentProjects,
  useDeploymentRecords,
  useDeploymentStatus,
} from "../../hooks/useDeploymentCenter";
import { useDeployTarget, useDeployTargets, useRegistries } from "../../hooks/useDeploy";
import { useMe } from "../../hooks/useMe";
import { useDatasources } from "../../hooks/useDatasources";
import { Select } from "../common/Select";
import { useFeedback } from "../common/FeedbackProvider";
import { errText, PageHeader } from "../Settings/ui";

export function DeploymentCenterPage() {
  const navigate = useNavigate();
  const { toast, confirm } = useFeedback();
  const me = useMe();
  const projectsQuery = useDeploymentProjects();
  const projects = projectsQuery.data ?? [];
  const [teamId, setTeamId] = useState("all");
  const [projectId, setProjectId] = useState("");
  const [bindingId, setBindingId] = useState("");
  const [branch, setBranch] = useState("");
  const [showConfig, setShowConfig] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const canDeploy = !!me.data?.permissions.includes("deploy:execute");
  const canManage = !!me.data?.permissions.includes("deploy-target:manage");

  const teams = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projects) {
      if (project.team) map.set(project.team.id, project.team.name);
    }
    return [...map].map(([id, name]) => ({ id, name }));
  }, [projects]);
  const filtered = projects.filter((project) =>
    teamId === "all" ? true : (project.team?.id || "personal") === teamId,
  );
  const project = projects.find((item) => item.id === projectId);
  const canManageSelectedProject = canManage && (project?.accessRole === "owner" || project?.accessRole === "maintainer");
  const deployBindings =
    project?.environments.filter((item) => item.purpose === "deploy") ?? [];
  const binding = deployBindings.find((item) => item.id === bindingId);
  const branches = useDeploymentBranches(projectId || undefined);
  const records = useDeploymentRecords(projectId || undefined);
  const deploymentStatus = useDeploymentStatus(projectId || undefined);
  const actions = useDeploymentCenterActions();

  useEffect(() => {
    if (!filtered.some((item) => item.id === projectId)) {
      setProjectId(filtered[0]?.id || "");
    }
  }, [filtered, projectId]);

  useEffect(() => {
    if (!deployBindings.some((item) => item.id === bindingId)) {
      setBindingId(deployBindings[0]?.id || "");
    }
  }, [bindingId, deployBindings]);

  useEffect(() => {
    if (!branches.data) return;
    const preferred =
      project?.remote?.branch || branches.data.current || branches.data.list[0];
    setBranch((value) =>
      value && branches.data!.list.includes(value) ? value : preferred || "",
    );
  }, [branches.data, project?.remote?.branch, projectId]);

  async function runDeploy() {
    if (!project || !binding || !branch) return;
    if (
      !(await confirm({
        title: `部署到 ${binding.environment}`,
        message: `将项目「${project.name}」的 ${branch} 分支部署到「${binding.target.name}」。部署环境是团队共享实例。`,
        confirmText: "确认部署",
      }))
    )
      return;
    try {
      await actions.deploy.mutateAsync({
        projectId: project.id,
        bindingId: binding.id,
        branch,
      });
      toast("部署任务已提交，可在下方记录中查看进度。", {
        title: "开始部署",
        tone: "success",
      });
    } catch (error) {
      toast(errText(error), { title: "部署失败", tone: "error" });
    }
  }

  async function stopDeployment() {
    if (!project) return;
    if (
      !(await confirm({
        title: "停止当前部署",
        message: `确认停止项目「${project.name}」当前运行中的共享服务？`,
        confirmText: "停止服务",
        tone: "danger",
      }))
    )
      return;
    try {
      await actions.stop.mutateAsync(project.id);
      toast("当前部署已停止", { tone: "success" });
    } catch (error) {
      toast(errText(error), { title: "停止失败", tone: "error" });
    }
  }

  return (
    <div className="h-full overflow-y-auto rounded-[22px] border border-white/80 bg-white/45 backdrop-blur-sm dark:border-slate-800/80 dark:bg-slate-950/25">
      <div className="page-shell max-w-7xl">
        <PageHeader
          title="部署中心"
          desc="由发布负责人选择项目、分支和环境执行统一部署。开发者的个人预览不会出现在这里。"
          action={
            canManageSelectedProject ? (
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setShowConfig((value) => !value)}
              >
                <Settings2 size={15} /> 项目环境配置
              </button>
            ) : undefined
          }
        />

        <div className="mb-5 grid gap-3 lg:grid-cols-[220px_minmax(260px,1fr)_minmax(260px,1fr)]">
          <FilterCard label="项目组" icon={<Boxes size={15} />}>
            <Select
              value={teamId}
              onChange={setTeamId}
              options={[
                { value: "all", label: "全部项目组" },
                { value: "personal", label: "未归属项目组" },
                ...teams.map((team) => ({ value: team.id, label: team.name })),
              ]}
            />
          </FilterCard>
          <FilterCard label="项目" icon={<Rocket size={15} />}>
            <Select
              value={projectId}
              onChange={setProjectId}
              options={filtered.map((item) => ({
                value: item.id,
                label: `${item.name} · ${item.language}`,
              }))}
              placeholder="请选择项目"
            />
          </FilterCard>
          <FilterCard label="发布分支" icon={<GitBranch size={15} />}>
            <Select
              value={branch}
              onChange={setBranch}
              options={(branches.data?.list ?? []).map((item) => ({
                value: item,
                label: item,
              }))}
              placeholder={branches.isLoading ? "正在读取分支…" : "请选择分支"}
            />
          </FilterCard>
        </div>

        {showConfig && project && canManageSelectedProject && (
          <EnvironmentConfig
            projectId={project.id}
            bindings={project.environments}
            onClose={() => setShowConfig(false)}
          />
        )}

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
          <section className="card min-w-0 p-5">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <div className="eyebrow">Deployment environments</div>
                <h2 className="mt-1 text-base font-bold">选择部署环境</h2>
              </div>
              {project?.deployment && (
                <StatusBadge status={project.deployment.status} />
              )}
            </div>
            {!project ? (
              <Empty text="当前范围内没有可部署项目" />
            ) : deployBindings.length === 0 ? (
              <Empty
                text={
                  canManageSelectedProject
                    ? "项目还没有部署环境，请打开“项目环境配置”绑定运行资源。"
                    : "项目还没有可用的部署环境，请联系运维负责人配置。"
                }
              />
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                {deployBindings.map((item) => (
                  <EnvironmentCard
                    key={item.id}
                    binding={item}
                    active={item.id === bindingId}
                    onClick={() => setBindingId(item.id)}
                  />
                ))}
              </div>
            )}
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200/70 pt-4 dark:border-slate-800">
              <div className="text-xs text-muted">
                {binding ? (
                  <>
                    分支规则 <code>{binding.branchPattern}</code> · 目标{" "}
                    {binding.target.name}
                  </>
                ) : (
                  "先选择一个部署环境"
                )}
              </div>
              <button
                className="btn btn-primary"
                disabled={
                  !canDeploy ||
                  !binding ||
                  !branch ||
                  actions.deploy.isPending ||
                  project?.deployment?.status === "building"
                }
                onClick={runDeploy}
              >
                <Rocket size={16} />
                {actions.deploy.isPending ? "正在提交…" : "部署此分支"}
              </button>
            </div>
          </section>

          <aside className="card p-5">
            <div className="eyebrow">Current release</div>
            <h2 className="mt-1 text-base font-bold">当前部署</h2>
            {project?.deployment ? (
              <dl className="mt-4 space-y-3 text-xs">
                <CurrentRow label="状态">
                  <StatusBadge status={project.deployment.status} />
                </CurrentRow>
                <CurrentRow label="环境">
                  {project.deployment.environment}
                </CurrentRow>
                <CurrentRow label="分支">
                  {project.deployment.branch || "—"}
                </CurrentRow>
                <CurrentRow label="目标">
                  {project.deployment.targetName || "—"}
                </CurrentRow>
                <CurrentRow label="数据库">
                  {project.deployment.datasourceName || "未绑定"}
                </CurrentRow>
                <CurrentRow label="操作者">
                  {project.deployment.deployedByName || "—"}
                </CurrentRow>
                <CurrentRow label="更新时间">
                  {formatTime(project.deployment.updatedAt)}
                </CurrentRow>
                {project.deployment.url && (
                  <a
                    className="btn btn-ghost btn-sm mt-2 w-full"
                    href={project.deployment.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    打开服务 <ChevronRight size={14} />
                  </a>
                )}
                {project.deployment.status === "running" &&
                  project.deployment.targetId &&
                  project.deployment.containerId?.startsWith("k8s://") && (
                    <button
                      className="btn btn-ghost btn-sm mt-2 w-full"
                      onClick={() => {
                        const [namespace, workload] = project.deployment!.containerId!.slice(6).split("/");
                        const params = new URLSearchParams({ targetId: project.deployment!.targetId!, namespace });
                        if (workload) params.set("podPrefix", workload);
                        navigate(`/monitoring/pods?${params}`);
                      }}
                    >
                      <Activity size={13} /> 查看 Pod 资源
                    </button>
                  )}
                <button
                  className="btn btn-ghost btn-sm mt-2 w-full"
                  onClick={() => setShowDetails((value) => !value)}
                >
                  <History size={13} /> {showDetails ? "收起部署详情" : "查看部署详情"}
                </button>
                {project.deployment.status === "running" && (
                  <button
                    className="btn btn-ghost btn-sm mt-2 w-full text-red-600 dark:text-red-400"
                    onClick={stopDeployment}
                    disabled={actions.stop.isPending}
                  >
                    <Square size={13} />
                    {actions.stop.isPending ? "正在停止…" : "停止当前部署"}
                  </button>
                )}
              </dl>
            ) : (
              <Empty text="该项目尚未部署" compact />
            )}
          </aside>
        </div>

        {showDetails && project?.deployment && (
          <DeploymentDetails
            status={deploymentStatus.data}
            loading={deploymentStatus.isFetching}
            onRefresh={() => deploymentStatus.refetch()}
          />
        )}

        <section className="card mt-5 overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-200/70 px-5 py-4 dark:border-slate-800">
            <div className="flex items-center gap-2">
              <History size={16} className="text-indigo-500" />
              <h2 className="text-sm font-bold">部署记录</h2>
            </div>
            <span className="text-[11px] text-muted">保留最近 100 条</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[850px] text-left text-xs">
              <thead className="bg-slate-50/80 text-[10px] uppercase tracking-wider text-slate-400 dark:bg-slate-950/35">
                <tr>
                  <th className="px-5 py-3">项目 / 项目组</th>
                  <th className="px-4 py-3">环境</th>
                  <th className="px-4 py-3">分支 / Commit</th>
                  <th className="px-4 py-3">运行目标</th>
                  <th className="px-4 py-3">数据库</th>
                  <th className="px-4 py-3">操作者</th>
                  <th className="px-4 py-3">状态</th>
                  <th className="px-5 py-3 text-right">时间</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200/70 dark:divide-slate-800">
                {(records.data ?? []).map((record) => (
                  <tr
                    key={record.id}
                    className="hover:bg-slate-50/60 dark:hover:bg-slate-800/25"
                  >
                    <td className="px-5 py-3">
                      <div className="font-semibold">{record.project.name}</div>
                      <div className="mt-0.5 text-[10px] text-muted">
                        {record.project.team?.name || "未归属项目组"}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-medium">
                      {record.environment}
                    </td>
                    <td className="px-4 py-3 font-mono">
                      <div>{record.branch}</div>
                      <div className="mt-0.5 text-[10px] text-muted">
                        {record.gitSha?.slice(0, 8) || "building"}
                      </div>
                    </td>
                    <td className="px-4 py-3">{record.targetName || "—"}</td>
                    <td className="px-4 py-3">{record.datasourceName || "—"}</td>
                    <td className="px-4 py-3">{record.deployedByName}</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={record.status} />
                    </td>
                    <td className="px-5 py-3 text-right text-muted">
                      {formatTime(record.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!records.isLoading && (records.data?.length ?? 0) === 0 && (
              <Empty text="暂无部署记录" />
            )}
          </div>
        </section>

        {canManage && (
          <button
            onClick={() => navigate("/resources/targets")}
            className="mt-4 inline-flex items-center gap-1.5 text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
          >
            <ServerCog size={14} /> 管理运行资源与容量
          </button>
        )}
      </div>
    </div>
  );
}

function DeploymentDetails({ status, loading, onRefresh }: { status?: import("../../hooks/useDeploymentCenter").DeploymentStatus; loading: boolean; onRefresh: () => void }) {
  const sections = [
    { title: "构建与发布日志", value: status?.logsTail },
    { title: "容器运行日志", value: status?.runtimeLogs },
    { title: "Kubernetes 事件", value: status?.runtimeEvents },
  ];
  return <section className="card mt-5 p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><div className="eyebrow">Deployment diagnostics</div><h2 className="mt-1 text-base font-bold">部署详情</h2></div>
      <button className="btn btn-ghost btn-sm" onClick={onRefresh} disabled={loading}><Activity size={13} className={loading ? "animate-spin" : ""}/>刷新状态</button>
    </div>
    <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <DetailValue label="状态" value={status?.status || "读取中"}/><DetailValue label="镜像" value={status?.image || "—"}/><DetailValue label="运行引用" value={status?.containerId || "—"}/><DetailValue label="更新时间" value={status?.updatedAt ? formatTime(status.updatedAt) : "—"}/>
    </div>
    <div className="mt-4 grid gap-4 xl:grid-cols-3">{sections.map((section) => <div key={section.title} className="min-w-0 rounded-2xl border border-slate-200/80 bg-slate-950 p-4 dark:border-slate-800"><div className="mb-3 text-xs font-bold text-slate-300">{section.title}</div><pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-5 text-slate-400">{section.value?.trim() || "暂无数据"}</pre></div>)}</div>
  </section>;
}

function DetailValue({ label, value }: { label: string; value: string }) { return <div className="surface-soft min-w-0 p-3"><div className="text-[10px] text-muted">{label}</div><div className="mt-1 truncate font-mono text-xs font-semibold" title={value}>{value}</div></div>; }

function EnvironmentConfig({
  projectId,
  bindings,
  onClose,
}: {
  projectId: string;
  bindings: RuntimeBinding[];
  onClose: () => void;
}) {
  const { toast, confirm } = useFeedback();
  const targets = useDeployTargets();
  const registries = useRegistries();
  const datasources = useDatasources('relational');
  const actions = useDeploymentCenterActions();
  const [editingBindingId, setEditingBindingId] = useState<string | null>(null);
  const [purpose, setPurpose] = useState<"preview" | "deploy">("deploy");
  const [environment, setEnvironment] = useState("test");
  const [targetId, setTargetId] = useState("");
  const [branchPattern, setBranchPattern] = useState("*");
  const [imageRepository, setImageRepository] = useState("");
  const [baseDomain, setBaseDomain] = useState("");
  const [testNamespace, setTestNamespace] = useState("");
  const [testServiceName, setTestServiceName] = useState("");
  const [testServicePort, setTestServicePort] = useState("80");
  const [registryId, setRegistryId] = useState("");
  const [sourceBaseUrl, setSourceBaseUrl] = useState("");
  const [allowInternet, setAllowInternet] = useState(false);
  const [datasourceId, setDatasourceId] = useState("");
  const available = (targets.data ?? []).filter(
    (item) => item.enabled && item.purposes.includes(purpose),
  );
  const selectedTarget = available.find((item) => item.id === targetId);
  const kubernetesPreview = purpose === "preview" && selectedTarget?.kind === "k8s";
  const selectedTargetDetail = useDeployTarget(kubernetesPreview ? targetId : undefined);
  const editingBinding = bindings.find((item) => item.id === editingBindingId);

  useEffect(() => {
    setEditingBindingId(null);
    setPurpose("deploy");
    setEnvironment("test");
    setTargetId("");
    setBranchPattern("*");
    setImageRepository("");
    setBaseDomain("");
    setTestNamespace("");
    setTestServiceName("");
    setTestServicePort("80");
    setRegistryId("");
    setSourceBaseUrl("");
    setAllowInternet(false);
    setDatasourceId("");
  }, [projectId]);

  useEffect(() => {
    const namespaces = selectedTargetDetail.data?.config.businessNamespaces ?? [];
    if (kubernetesPreview && !namespaces.includes(testNamespace)) setTestNamespace(namespaces[0] ?? "");
  }, [kubernetesPreview, selectedTargetDetail.data, testNamespace]);

  useEffect(() => {
    if (!available.some((item) => item.id === targetId)) {
      setTargetId(available[0]?.id || "");
    }
  }, [available, targetId]);

  useEffect(() => {
    if (purpose === "preview") {
      setEnvironment("preview");
      setBranchPattern("*");
    } else if (environment === "preview") {
      setEnvironment("test");
    }
  }, [purpose]);

  function edit(item: RuntimeBinding) {
    const config = item.config ?? {};
    setEditingBindingId(item.id);
    setPurpose(item.purpose);
    setEnvironment(item.environment);
    setTargetId(item.targetId);
    setBranchPattern(item.branchPattern || "*");
    setImageRepository(configString(config, "imageRepository"));
    setBaseDomain(configString(config, "baseDomain"));
    setTestNamespace(configString(config, "testNamespace"));
    setTestServiceName(configString(config, "testServiceName"));
    setTestServicePort(configNumber(config, "testServicePort", 80));
    setRegistryId(configString(config, "registryId"));
    setSourceBaseUrl(configString(config, "sourceBaseUrl"));
    setAllowInternet(config.allowInternet === true);
    setDatasourceId(configString(config, "datasourceId"));
  }

  function resetEditor() {
    setEditingBindingId(null);
    setPurpose("deploy");
    setEnvironment("test");
    setTargetId("");
    setBranchPattern("*");
    setImageRepository("");
    setBaseDomain("");
    setTestNamespace("");
    setTestServiceName("");
    setTestServicePort("80");
    setRegistryId("");
    setSourceBaseUrl("");
    setAllowInternet(false);
    setDatasourceId("");
  }

  async function save() {
    try {
      await actions.saveBinding.mutateAsync({
        projectId,
        targetId,
        purpose,
        environment,
        branchPattern,
        config: {
          ...(editingBinding?.config ?? {}),
          ...(purpose === 'deploy' ? { datasourceId } : {}),
          ...(kubernetesPreview ? {
          imageRepository: imageRepository.trim(),
          baseDomain: baseDomain.trim(),
          testNamespace,
          testServiceName: testServiceName.trim(),
          testServicePort: Number(testServicePort),
          registryId,
          sourceBaseUrl: sourceBaseUrl.trim(),
          allowInternet,
          buildAllowInternet: true,
          } : {}),
        },
      });
      resetEditor();
      toast("项目环境绑定已保存", { tone: "success" });
    } catch (error) {
      toast(errText(error), { title: "保存失败", tone: "error" });
    }
  }

  async function remove(item: RuntimeBinding) {
    if (
      !(await confirm({
        title: "删除环境绑定",
        message: `确认删除 ${item.environment} 环境？`,
        tone: "danger",
      }))
    )
      return;
    try {
      await actions.removeBinding.mutateAsync(item.id);
      if (editingBindingId === item.id) setEditingBindingId(null);
    } catch (error) {
      toast(errText(error), { title: "删除失败", tone: "error" });
    }
  }

  return (
    <section className="card mb-5 border-indigo-200/80 p-5 dark:border-indigo-500/25">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="eyebrow">Project runtime bindings</div>
          <h2 className="mt-1 text-base font-bold">项目环境配置</h2>
          <p className="mt-1 text-xs text-muted">
            预览绑定供每位开发者创建独立沙箱；部署绑定指向团队共享环境。
          </p>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onClose}>
          收起
        </button>
      </div>
      {kubernetesPreview && (
        <div className="mt-4 rounded-2xl border border-indigo-200/80 bg-indigo-50/50 p-4 dark:border-indigo-500/20 dark:bg-indigo-500/5">
          <div className="mb-3 text-xs font-bold">Kubernetes 预览构建</div>
          <div className="grid gap-3 md:grid-cols-2">
            <input className="input font-mono" value={imageRepository} onChange={(event) => setImageRepository(event.target.value)} placeholder="harbor.example.com/team/project" />
            <input className="input font-mono" value={baseDomain} onChange={(event) => setBaseDomain(event.target.value)} placeholder="preview.example.com" />
            <Select value={testNamespace} onChange={setTestNamespace} options={(selectedTargetDetail.data?.config.businessNamespaces ?? []).map((namespace) => ({ value: namespace, label: `测试 Namespace · ${namespace}` }))} placeholder="选择默认测试环境 Namespace" />
            <input className="input font-mono" value={testServiceName} onChange={(event) => setTestServiceName(event.target.value)} placeholder="测试 Service 名称，如 order-api" />
            <input className="input font-mono" type="number" min="1" max="65535" value={testServicePort} onChange={(event) => setTestServicePort(event.target.value)} placeholder="测试服务端口，默认 80" />
            <Select value={registryId} onChange={setRegistryId} options={(registries.data ?? []).map((item) => ({ value: item.id, label: `${item.name} · ${item.summary || "Registry"}` }))} placeholder="选择镜像仓库凭证" />
            <input className="input font-mono" value={sourceBaseUrl} onChange={(event) => setSourceBaseUrl(event.target.value)} placeholder="平台快照 HTTPS 地址，如 https://codegen.example.com" />
          </div>
          <label className="mt-3 flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={allowInternet} onChange={(event) => setAllowInternet(event.target.checked)} />
            允许运行中的预览应用访问公网（构建访问与此项独立）
          </label>
          <p className="mt-2 text-[10px] text-muted">测试 Service 必须存在、声明对应端口并带有 Pod selector；预览网络策略只允许访问这些后端 Pod。服务标识由需求关联项目维护。构建使用当前用户工作区的短期不可变快照；目标集群必须能访问上述平台 HTTPS 地址，下载令牌与 Registry 凭证仅进入临时 Secret。</p>
        </div>
      )}
      {purpose === "deploy" && (
        <div className="mb-4 rounded-2xl border border-emerald-200/80 bg-emerald-50/50 p-4 dark:border-emerald-500/20 dark:bg-emerald-500/5">
          <div className="mb-2 text-xs font-bold">环境数据库</div>
          <Select value={datasourceId} onChange={setDatasourceId} options={(datasources.data ?? []).map((item) => ({ value: item.id, label: `${item.name} · ${item.summary || item.type}` }))} placeholder="可选：选择该环境使用的关系型数据库" />
          <p className="mt-2 text-[10px] text-muted">数据库凭证将在部署时写入目标 Namespace 的 Kubernetes Secret，部署记录只保存数据源名称快照。</p>
        </div>
      )}
      <div className="grid gap-3 lg:grid-cols-[150px_150px_1fr_180px_auto]">
        <Select
          value={purpose}
          disabled={!!editingBindingId}
          onChange={(value) => setPurpose(value as "preview" | "deploy")}
          options={[
            { value: "deploy", label: "统一部署" },
            { value: "preview", label: "个人预览" },
          ]}
        />
        <input
          className="input"
          value={environment}
          disabled={purpose === "preview" || !!editingBindingId}
          onChange={(event) => setEnvironment(event.target.value)}
          placeholder="环境，如 test"
        />
        <Select
          value={targetId}
          onChange={setTargetId}
          options={available.map((item) => ({
            value: item.id,
            label: `${item.name} · ${item.activePreviewInstances}/${item.maxPreviewInstances}`,
          }))}
          placeholder="请选择运行资源"
        />
        <input
          className="input font-mono"
          value={branchPattern}
          onChange={(event) => setBranchPattern(event.target.value)}
          placeholder="分支规则，如 release/*"
        />
        <div className="flex gap-2">
          {editingBindingId && <button className="btn btn-ghost" onClick={resetEditor}>取消</button>}
          <button
            className="btn btn-primary"
            disabled={!targetId || actions.saveBinding.isPending || (kubernetesPreview && (!testNamespace || !testServiceName.trim() || !Number(testServicePort) || !imageRepository.trim() || !baseDomain.trim() || !sourceBaseUrl.trim() || !registryId))}
            onClick={save}
          >
            <Plus size={15} /> {editingBindingId ? "更新" : "保存"}
          </button>
        </div>
      </div>
      <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {bindings.map((item) => (
          <div
            key={item.id}
            className="surface-soft flex items-center gap-3 px-3 py-2.5"
          >
            <Link2 size={14} className="shrink-0 text-indigo-500" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-semibold">
                {item.purpose === "preview" ? "个人预览" : item.environment}
              </div>
              <div className="truncate text-[10px] text-muted">
                {item.target.name} · {item.branchPattern}
              </div>
            </div>
            <button
              className="icon-btn h-7 w-7"
              onClick={() => edit(item)}
              title="编辑环境绑定"
            >
              <Settings2 size={13} />
            </button>
            <button
              className="icon-btn h-7 w-7 text-red-500"
              onClick={() => remove(item)}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function configString(config: Record<string, unknown>, key: string) {
  return typeof config[key] === "string" ? config[key] as string : "";
}

function configNumber(config: Record<string, unknown>, key: string, fallback: number) {
  const value = config[key];
  return typeof value === "number" && Number.isFinite(value) ? String(value) : String(fallback);
}

function FilterCard({
  label,
  icon,
  children,
}: {
  label: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="card px-4 py-3">
      <div className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
        {icon} {label}
      </div>
      {children}
    </div>
  );
}

function EnvironmentCard({
  binding,
  active,
  onClick,
}: {
  binding: RuntimeBinding;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-2xl border p-4 text-left transition ${
        active
          ? "border-indigo-400 bg-indigo-50/70 ring-2 ring-indigo-500/10 dark:border-indigo-500 dark:bg-indigo-500/10"
          : "border-slate-200 hover:border-indigo-200 hover:bg-slate-50 dark:border-slate-800 dark:hover:border-indigo-500/30 dark:hover:bg-slate-800/30"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-bold capitalize">
          {binding.environment}
        </span>
        <span
          className={`h-2 w-2 rounded-full ${binding.target.enabled ? "bg-emerald-500" : "bg-slate-400"}`}
        />
      </div>
      <div className="mt-3 flex items-center gap-2 text-xs text-muted">
        <ServerCog size={14} />{" "}
        <span className="truncate">{binding.target.name}</span>
      </div>
      <div className="mt-1.5 flex items-center gap-2 text-[10px] text-slate-400">
        <GitBranch size={12} /> {binding.branchPattern}
      </div>
    </button>
  );
}

function CurrentRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-slate-100 pb-2.5 last:border-0 dark:border-slate-800">
      <dt className="text-muted">{label}</dt>
      <dd className="max-w-[210px] truncate text-right font-medium">
        {children}
      </dd>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const style =
    status === "running"
      ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
      : status === "building"
        ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
        : status === "failed"
          ? "bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300"
          : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-semibold ${style}`}
    >
      <Activity
        size={11}
        className={status === "building" ? "animate-pulse" : ""}
      />
      {status === "running"
        ? "运行中"
        : status === "building"
          ? "部署中"
          : status === "failed"
            ? "失败"
            : "已停止"}
    </span>
  );
}

function Empty({ text, compact = false }: { text: string; compact?: boolean }) {
  return (
    <div
      className={`text-center text-xs text-muted ${compact ? "py-8" : "px-4 py-12"}`}
    >
      {text}
    </div>
  );
}

function formatTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}
