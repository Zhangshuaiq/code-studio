import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Plus,
  Trash2,
  CheckCircle2,
  Eye,
  X,
  Upload,
  Copy,
  Boxes,
  Server,
  HardDrive,
  KeyRound,
  CalendarDays,
  CircleHelp,
  TriangleAlert,
  Power,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import {
  type DeployTarget,
  useDeployTarget,
  useDeployTargets,
  useDeployTargetOps,
  useRegistries,
} from "../../hooks/useDeploy";
import { PageHeader, EmptyState, Card, Field, errText } from "./ui";
import { Select } from "../common/Select";
import { useFeedback } from "../common/FeedbackProvider";
import { useDeploymentProjects } from "../../hooks/useDeploymentCenter";
import { useClusterDeploymentActions, useClusterOverview, useDeleteClusterPod, usePod, usePodLogs } from "../../hooks/useK8s";

const KIND_LABEL: Record<string, string> = {
  "local-docker": "平台本机 Docker",
  "docker-tcp": "Docker 主机 (IP:端口)",
  "docker-ssh": "远程单机 Docker (SSH)",
  k8s: "Kubernetes 集群",
  "server-artifact": "产物直传服务器 (jar/war)",
};
const READY_KINDS = new Set([
  "local-docker",
  "docker-tcp",
  "docker-ssh",
  "k8s",
  "server-artifact",
]);
const KUBECONFIG_COMMAND = "kubectl config view --raw --minify --flatten";

const KIND_DESCRIPTION: Record<string, string> = {
  "local-docker": "使用平台 API 节点上的 Docker，适合本地开发与小规模预览。",
  "docker-tcp": "通过 Docker Engine API 部署到可远程访问的 Docker 主机。",
  "docker-ssh": "通过 SSH 连接远程服务器，并调用服务器上的 Docker CLI。",
  k8s: "连接 Kubernetes API Server，构建镜像后创建 Deployment 与 Service。",
  "server-artifact":
    "在平台沙箱中构建 Java Maven 项目，再通过 SSH/SFTP 原子上传 JAR/WAR，并可选执行重启命令。",
};

export function DeployTargetsPage() {
  const navigate = useNavigate();
  const { data: targets = [] } = useDeployTargets();
  const { create, update, remove } = useDeployTargetOps();
  const { data: registries = [] } = useRegistries();
  const { data: projects = [] } = useDeploymentProjects();
  const { toast, confirm: askConfirm } = useFeedback();

  const [showForm, setShowForm] = useState(false);
  const [selectedTargetId, setSelectedTargetId] = useState<string>();
  const [kind, setKind] = useState("local-docker");
  const [name, setName] = useState("");
  const [scope, setScope] = useState("platform");
  const [teamId, setTeamId] = useState("");
  const [purposes, setPurposes] = useState<string[]>(["preview", "deploy"]);
  const [labels, setLabels] = useState("");
  const [maxInstances, setMaxInstances] = useState("10");
  const [capacityCpu, setCapacityCpu] = useState("");
  const [capacityMemory, setCapacityMemory] = useState("");
  const [f, setF] = useState<Record<string, string>>({});
  const [err, setErr] = useState("");
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));
  const teams = [
    ...new Map(
      projects
        .filter((project) => project.team)
        .map((project) => [project.team!.id, project.team!] as const),
    ).values(),
  ];

  const handleKindChange = (value: string) => {
    setKind(value);
    setF({});
    setErr("");
    setPurposes(
      value === "k8s" || value === "server-artifact"
        ? ["deploy"]
        : ["preview", "deploy"],
    );
  };

  const handleKubeconfigFile = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      set("kubeconfig", await file.text());
      toast(`已读取 ${file.name}`, {
        title: "kubeconfig 已导入",
        tone: "success",
      });
    } catch {
      toast("无法读取该文件，请尝试复制文件内容后手动粘贴。", {
        title: "导入失败",
        tone: "error",
      });
    } finally {
      event.target.value = "";
    }
  };

  const copyKubeconfigCommand = async () => {
    try {
      await navigator.clipboard.writeText(KUBECONFIG_COMMAND);
      toast("命令已复制到剪贴板", { tone: "success" });
    } catch {
      toast(KUBECONFIG_COMMAND, {
        title: "复制失败，请手动复制",
        tone: "warning",
        duration: 7000,
      });
    }
  };

  const handleRemove = async (target: DeployTarget) => {
    if (
      !(await askConfirm({
        title: "删除运行资源",
        message: `确认删除「${target.name}」？已绑定的预览和部署环境将无法继续使用。`,
        confirmText: "删除资源",
        tone: "danger",
      }))
    )
      return;
    try {
      await remove.mutateAsync(target.id);
      if (selectedTargetId === target.id) setSelectedTargetId(undefined);
      toast(`运行资源「${target.name}」已删除`, {
        title: "删除成功",
        tone: "success",
      });
    } catch (error) {
      toast(errText(error), { title: "删除失败", tone: "error" });
    }
  };

  const toggleEnabled = async (target: DeployTarget) => {
    try {
      await update.mutateAsync({ id: target.id, enabled: !target.enabled });
      toast(target.enabled ? "运行资源已停用" : "运行资源已启用", {
        tone: "success",
      });
    } catch (error) {
      toast(errText(error), { title: "状态更新失败", tone: "error" });
    }
  };

  async function add() {
    setErr("");
    if (!name.trim())
      return setErr("请填写名称（作为你的备注，用于区分不同目标）");
    if (!purposes.length) return setErr("请至少选择一种用途");
    if (scope === "team" && !teamId) return setErr("请选择资源所属项目组");
    if (kind === "k8s" && !f.kubeconfig?.trim())
      return setErr("请粘贴或导入 kubeconfig 文件");
    const config: Record<string, any> = {};
    if (kind === "local-docker") {
      if (f.publicHost) config.publicHost = f.publicHost;
    } else if (kind === "docker-tcp") {
      config.host = f.host;
      config.port = f.port ? Number(f.port) : 2375;
      config.tls = false;
      if (f.publicHost) config.publicHost = f.publicHost;
    } else if (kind === "docker-ssh" || kind === "server-artifact") {
      config.host = f.host;
      config.port = f.port ? Number(f.port) : 22;
      config.username = f.username;
      config.privateKey = f.privateKey;
      if (f.publicHost) config.publicHost = f.publicHost;
      if (f.passphrase) config.passphrase = f.passphrase;
      if (f.hostFingerprint) config.hostFingerprint = f.hostFingerprint.trim();
      if (kind === "server-artifact") {
        config.remotePath = f.remotePath;
        config.restartCmd = f.restartCmd;
      }
    } else if (kind === "k8s") {
      config.kubeconfig = f.kubeconfig;
      config.namespace = f.namespace;
      config.baseDomain = f.baseDomain;
      config.registryId = f.registryId || undefined;
      config.prometheusUrl = f.prometheusUrl?.trim() || undefined;
      config.prometheusBearerToken = f.prometheusBearerToken?.trim() || undefined;
      config.prometheusUsername = f.prometheusUsername?.trim() || undefined;
      config.prometheusPassword = f.prometheusPassword || undefined;
      config.prometheusClusterLabel = f.prometheusClusterLabel?.trim() || undefined;
      config.prometheusClusterValue = f.prometheusClusterValue?.trim() || undefined;
    }
    try {
      await create.mutateAsync({
        name: name.trim(),
        kind,
        config,
        scope,
        teamId: scope === "team" ? teamId : undefined,
        purposes,
        labels: labels
          .split(/[,，\s]+/)
          .map((item) => item.trim())
          .filter(Boolean),
        maxPreviewInstances: Number(maxInstances) || 10,
        capacityCpu: Number(capacityCpu) || undefined,
        capacityMemoryMb: Number(capacityMemory) || undefined,
      });
      setName("");
      setF({});
      setLabels("");
      setShowForm(false);
    } catch (e: any) {
      setErr(e?.response?.data?.message ?? errText(e));
    }
  }

  return (
    <div>
      <PageHeader
        title="运行资源"
        desc="统一维护本机 Docker、远程 Docker、服务器和 Kubernetes，并为预览设置实例与容量上限。连接凭证加密存储。"
        action={
          <button
            onClick={() => {
              setShowForm((visible) => !visible);
              setErr("");
            }}
            className="btn btn-primary btn-sm inline-flex items-center gap-1.5"
          >
            {showForm ? (
              "取消"
            ) : (
              <>
                <Plus size={15} /> 新建资源
              </>
            )}
          </button>
        }
      />

      {showForm && (
        <div className="mb-6">
          <Card title="添加运行资源">
            <div className="space-y-3">
              <div>
                <label className="label mb-1">类型</label>
                <Select
                  value={kind}
                  onChange={handleKindChange}
                  options={Object.entries(KIND_LABEL).map(([value, label]) => ({
                    value,
                    label,
                  }))}
                />
                {READY_KINDS.has(kind) ? (
                  <p className="mt-1 inline-flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 size={13} />{" "}
                    该驱动已接入，可按所选用途用于预览或部署。
                  </p>
                ) : (
                  <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                    注：目标框架已就绪，但该驱动尚未接入（可先保存配置）。
                  </p>
                )}
              </div>
              <Field
                label="名称（备注）"
                value={name}
                onChange={setName}
                placeholder="如 阿里云生产 k8s / 公司内网 Docker"
              />

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="label mb-1">可见范围</label>
                  <Select
                    value={scope}
                    onChange={setScope}
                    options={[
                      { value: "platform", label: "整个平台" },
                      { value: "team", label: "指定项目组" },
                      { value: "personal", label: "仅创建者" },
                    ]}
                  />
                </div>
                {scope === "team" && (
                  <div>
                    <label className="label mb-1">项目组</label>
                    <Select
                      value={teamId}
                      onChange={setTeamId}
                      options={teams.map((team) => ({
                        value: team.id,
                        label: team.name,
                      }))}
                      placeholder="请选择项目组"
                    />
                  </div>
                )}
              </div>

              <div>
                <label className="label mb-2">用途</label>
                <div className="flex flex-wrap gap-2">
                  {[
                    ["preview", "个人预览"],
                    ["deploy", "统一部署"],
                  ].map(([value, label]) => {
                    const disabled =
                      value === "preview" &&
                      (kind === "k8s" || kind === "server-artifact");
                    const checked = purposes.includes(value);
                    return (
                      <label
                        key={value}
                        className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-xs ${
                          checked
                            ? "border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-500/40 dark:bg-indigo-500/10 dark:text-indigo-300"
                            : "border-slate-200 text-muted dark:border-slate-800"
                        } ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={disabled}
                          onChange={() =>
                            setPurposes((current) =>
                              checked
                                ? current.filter((item) => item !== value)
                                : [...current, value],
                            )
                          }
                        />
                        {label}
                      </label>
                    );
                  })}
                </div>
              </div>

              {purposes.includes("preview") && (
                <div className="surface-soft grid gap-3 p-4 sm:grid-cols-3">
                  <Field
                    label="最大预览实例"
                    value={maxInstances}
                    onChange={setMaxInstances}
                    type="number"
                    placeholder="10"
                  />
                  <Field
                    label="总 CPU（可选）"
                    value={capacityCpu}
                    onChange={setCapacityCpu}
                    type="number"
                    placeholder="例如 16"
                  />
                  <Field
                    label="总内存 MB（可选）"
                    value={capacityMemory}
                    onChange={setCapacityMemory}
                    type="number"
                    placeholder="例如 32768"
                  />
                </div>
              )}
              <Field
                label="标签（逗号分隔）"
                value={labels}
                onChange={setLabels}
                placeholder="例如 env=dev, region=shanghai, high-memory"
              />

              {kind === "local-docker" && (
                <Field
                  label="外部访问主机名（可选）"
                  value={f.publicHost}
                  onChange={(x) => set("publicHost", x)}
                  placeholder="默认使用 PREVIEW_PUBLIC_HOST"
                />
              )}

              {kind === "docker-tcp" && (
                <>
                  <div className="grid grid-cols-3 gap-2">
                    <div className="col-span-2">
                      <Field
                        label="主机 host"
                        value={f.host}
                        onChange={(x) => set("host", x)}
                        placeholder="127.0.0.1"
                      />
                    </div>
                    <Field
                      label="端口"
                      value={f.port}
                      onChange={(x) => set("port", x)}
                      placeholder="2375"
                    />
                  </div>
                  <Field
                    label="预览访问主机名（可选）"
                    value={f.publicHost}
                    onChange={(x) => set("publicHost", x)}
                    placeholder="浏览器可访问的域名或 IP，默认同 host"
                  />
                  <p className="text-[11px] text-muted">
                    Docker Engine API 地址（tcp://host:port）。需目标机开启
                    Docker 远程访问端口 2375/2376。
                  </p>
                </>
              )}

              {(kind === "docker-ssh" || kind === "server-artifact") && (
                <>
                  <div className="grid grid-cols-3 gap-2">
                    <div className="col-span-2">
                      <Field
                        label="主机 host"
                        value={f.host}
                        onChange={(x) => set("host", x)}
                        placeholder="1.2.3.4"
                      />
                    </div>
                    <Field
                      label="端口"
                      value={f.port}
                      onChange={(x) => set("port", x)}
                      placeholder="22"
                    />
                  </div>
                  <Field
                    label="用户名"
                    value={f.username}
                    onChange={(x) => set("username", x)}
                    placeholder="deploy"
                  />
                  {kind === "docker-ssh" && (
                    <Field
                      label="预览访问主机名（可选）"
                      value={f.publicHost}
                      onChange={(x) => set("publicHost", x)}
                      placeholder="浏览器可访问的域名或 IP，默认同 host"
                    />
                  )}
                  <div>
                    <label className="label mb-1">SSH 私钥</label>
                    <textarea
                      value={f.privateKey ?? ""}
                      onChange={(e) => set("privateKey", e.target.value)}
                      rows={3}
                      placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                      className="input font-mono text-xs"
                    />
                  </div>
                  <Field
                    label="私钥口令(可选)"
                    value={f.passphrase}
                    onChange={(x) => set("passphrase", x)}
                    placeholder="私钥有加密口令才填"
                  />
                  {kind === "server-artifact" && (
                    <div>
                      <Field
                        label="SSH 主机指纹（可选，推荐）"
                        value={f.hostFingerprint}
                        onChange={(x) => set("hostFingerprint", x)}
                        placeholder="SHA256:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                      />
                      <p className="mt-1 text-[11px] text-muted">
                        可在可信终端执行 <code>ssh-keyscan</code> 配合{" "}
                        <code>ssh-keygen -lf -</code>{" "}
                        获取，用于防止连接到伪造服务器。
                      </p>
                    </div>
                  )}
                  {kind === "docker-ssh" && (
                    <p className="text-[11px] text-muted">
                      经 SSH 连远程 Docker（跑{" "}
                      <code>docker system dial-stdio</code>）。远程需 sshd 可达
                      + 装有 docker CLI(≥18.09) + 该用户能访问 docker。
                    </p>
                  )}
                  {kind === "server-artifact" && (
                    <>
                      <div className="rounded-2xl border border-indigo-200/80 bg-indigo-50/60 p-4 dark:border-indigo-500/20 dark:bg-indigo-500/5">
                        <div className="flex items-start gap-3">
                          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-indigo-100 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300">
                            <CircleHelp size={17} />
                          </span>
                          <div>
                            <h4 className="text-sm font-semibold text-slate-900 dark:text-white">
                              服务器需要准备什么？
                            </h4>
                            <ol className="mt-2 space-y-1 text-xs leading-5 text-slate-600 dark:text-slate-300">
                              <li>1. SSH 用户可以使用所填私钥登录。</li>
                              <li>2. SSH 用户对目标目录拥有创建和写入权限。</li>
                              <li>
                                3.
                                如需自动重启，确保该用户可免交互执行重启命令。
                              </li>
                            </ol>
                            <p className="mt-2 text-[11px] text-indigo-700 dark:text-indigo-300">
                              当前支持 Java Maven 项目。平台会执行构建、识别主
                              JAR/WAR、上传临时文件后原子替换正式文件。
                            </p>
                          </div>
                        </div>
                      </div>
                      <Field
                        label="远端目标目录"
                        value={f.remotePath}
                        onChange={(x) => set("remotePath", x)}
                        placeholder="/opt/apps/demo"
                      />
                      <Field
                        label="重启命令(可选)"
                        value={f.restartCmd}
                        onChange={(x) => set("restartCmd", x)}
                        placeholder="sudo -n systemctl restart demo"
                      />
                      <p className="text-[11px] leading-5 text-muted">
                        命令在上传成功后执行。可使用 <code>{"{artifact}"}</code>{" "}
                        表示远端产物完整路径，使用 <code>{"{directory}"}</code>{" "}
                        表示目标目录；sudo 必须配置免密码执行。
                      </p>
                    </>
                  )}
                </>
              )}

              {kind === "k8s" && (
                <>
                  <div className="rounded-2xl border border-indigo-200/80 bg-indigo-50/60 p-4 dark:border-indigo-500/20 dark:bg-indigo-500/5">
                    <div className="flex items-start gap-3">
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-indigo-100 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300">
                        <CircleHelp size={17} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <h4 className="text-sm font-semibold text-slate-900 dark:text-white">
                          如何准备 kubeconfig？
                        </h4>
                        <ol className="mt-2 space-y-1.5 text-xs leading-5 text-slate-600 dark:text-slate-300">
                          <li>
                            1. 先确认当前电脑执行{" "}
                            <code>kubectl cluster-info</code>
                            能连接目标集群。
                          </li>
                          <li>2. 执行下面的命令，得到包含证书的完整配置。</li>
                          <li>
                            3. 将输出粘贴到下方，或从云厂商控制台下载 kubeconfig
                            后直接导入。
                          </li>
                        </ol>
                        <div className="mt-3 flex items-center gap-2 rounded-xl bg-slate-950 px-3 py-2.5 text-slate-100">
                          <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-[11px]">
                            {KUBECONFIG_COMMAND}
                          </code>
                          <button
                            type="button"
                            onClick={copyKubeconfigCommand}
                            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-slate-400 transition hover:bg-white/10 hover:text-white"
                            title="复制命令"
                          >
                            <Copy size={13} />
                          </button>
                        </div>
                        <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-300">
                          平台 API 服务所在机器必须能访问 kubeconfig 中的 API
                          Server 地址；仅能在你电脑访问的 localhost
                          地址通常不可用。
                        </p>
                      </div>
                    </div>
                  </div>

                  <div>
                    <div className="mb-1.5 flex items-center justify-between gap-3">
                      <label className="label">kubeconfig 内容</label>
                      <label className="btn btn-ghost btn-sm cursor-pointer">
                        <Upload size={13} />
                        从文件导入
                        <input
                          type="file"
                          accept=".yaml,.yml,.conf,text/yaml,text/plain"
                          onChange={handleKubeconfigFile}
                          className="hidden"
                        />
                      </label>
                    </div>
                    <textarea
                      value={f.kubeconfig ?? ""}
                      onChange={(e) => set("kubeconfig", e.target.value)}
                      rows={8}
                      spellCheck={false}
                      placeholder={`apiVersion: v1\nkind: Config\ncurrent-context: ...`}
                      className="input resize-y font-mono text-xs leading-5"
                    />
                    <div className="mt-1.5 flex items-center gap-1.5 text-[11px]">
                      {f.kubeconfig?.includes("current-context:") &&
                      f.kubeconfig?.includes("clusters:") ? (
                        <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                          <CheckCircle2 size={12} /> 已识别为 kubeconfig 配置
                        </span>
                      ) : (
                        <span className="text-muted">
                          配置会加密保存，详情页不会回显证书和访问令牌。
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Field
                        label="业务 Namespace（可选）"
                        value={f.namespace}
                        onChange={(x) => set("namespace", x)}
                        placeholder="例如 codegen-apps"
                      />
                      <p className="mt-1 text-[11px] text-muted">
                        必须提前存在；留空会部署到
                        default，但资源工作台会隐藏该内置空间。
                      </p>
                    </div>
                    <div>
                      <Field
                        label="访问域名或节点地址（可选）"
                        value={f.baseDomain}
                        onChange={(x) => set("baseDomain", x)}
                        placeholder="例如 apps.example.com"
                      />
                      <p className="mt-1 text-[11px] text-muted">
                        用于拼接 NodePort 访问地址；本机集群可留空使用
                        localhost。
                      </p>
                    </div>
                  </div>
                  <div>
                    <div className="mb-1 flex items-center justify-between">
                      <label className="label">镜像仓库（远程集群需要）</label>
                      <button
                        type="button"
                        onClick={() => navigate("../registries")}
                        className="text-[11px] text-indigo-600 hover:underline dark:text-indigo-400"
                      >
                        管理镜像仓库
                      </button>
                    </div>
                    <Select
                      value={f.registryId ?? ""}
                      onChange={(value) => set("registryId", value)}
                      options={[
                        {
                          value: "",
                          label:
                            "不使用（集群共享本地镜像库，如 Docker Desktop）",
                        },
                        ...registries.map((registry) => ({
                          value: registry.id,
                          label: `${registry.name}（${registry.summary}）`,
                        })),
                      ]}
                    />
                  </div>
                  <div className="rounded-2xl border border-sky-200/80 bg-sky-50/50 p-4 dark:border-sky-500/20 dark:bg-sky-500/5">
                    <h4 className="text-sm font-semibold">集群监控数据源</h4>
                    <p className="mt-1 text-[11px] leading-5 text-muted">填写部署目标集群的 Prometheus 地址。平台将按部署目标查询指标；新增 Pod 由集群 Prometheus 自动发现，不需要修改平台配置。</p>
                    <div className="mt-3 space-y-3">
                      <Field label="Prometheus 地址" value={f.prometheusUrl} onChange={(x) => set("prometheusUrl", x)} placeholder="例如 https://prometheus.example.com" />
                      <Field label="Bearer Token（可选）" value={f.prometheusBearerToken} onChange={(x) => set("prometheusBearerToken", x)} placeholder="使用 Bearer 认证时填写" />
                      <div className="grid grid-cols-2 gap-2">
                        <Field label="Basic 用户名（可选）" value={f.prometheusUsername} onChange={(x) => set("prometheusUsername", x)} />
                        <Field label="Basic 密码（可选）" value={f.prometheusPassword} onChange={(x) => set("prometheusPassword", x)} type="password" />
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <Field label="集群标签名（共享 Prometheus）" value={f.prometheusClusterLabel} onChange={(x) => set("prometheusClusterLabel", x)} placeholder="cluster" />
                        <Field label="当前集群标签值" value={f.prometheusClusterValue} onChange={(x) => set("prometheusClusterValue", x)} placeholder="test-cluster" />
                      </div>
                    </div>
                  </div>
                  <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50/70 p-3 text-[11px] leading-5 text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/5 dark:text-amber-300">
                    <TriangleAlert size={14} className="mt-0.5 shrink-0" />
                    <span>
                      远程集群通常必须选择镜像仓库，否则集群节点无法获取平台本地构建的镜像。Docker
                      Desktop 等与平台共享本地镜像库的环境可以留空。
                    </span>
                  </div>
                </>
              )}

              {err && <p className="text-xs text-red-500">{err}</p>}
              <button
                onClick={add}
                disabled={create.isPending}
                className="btn btn-primary w-full"
              >
                {create.isPending ? "保存中…" : "保存运行资源"}
              </button>
            </div>
          </Card>
        </div>
      )}

      <div className="space-y-2">
        {targets.length === 0 && (
          <EmptyState>
            还没有运行资源。点右上角「新建资源」添加本机 Docker、远程
            Docker、Kubernetes 集群或产物服务器。
          </EmptyState>
        )}
        {targets.map((t) => (
          <div
            key={t.id}
            className="card flex items-center gap-4 px-4 py-4 transition hover:border-indigo-200 hover:shadow-lg dark:hover:border-indigo-500/30"
          >
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-indigo-50 text-indigo-600 ring-1 ring-indigo-100 dark:bg-indigo-500/10 dark:text-indigo-300 dark:ring-indigo-500/20">
              <TargetKindIcon kind={t.kind} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <div className="truncate text-sm font-semibold">{t.name}</div>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                    READY_KINDS.has(t.kind) && t.enabled
                      ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
                      : "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300"
                  }`}
                >
                  {!t.enabled
                    ? "已停用"
                    : READY_KINDS.has(t.kind)
                      ? "可用"
                      : "暂未接入"}
                </span>
              </div>
              <div className="mt-0.5 truncate text-xs text-muted">
                {KIND_LABEL[t.kind] ?? t.kind} · {t.summary || "未生成摘要"}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {t.purposes.map((purpose) => (
                  <span
                    key={purpose}
                    className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[9px] font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-300"
                  >
                    {purpose === "preview" ? "个人预览" : "统一部署"}
                  </span>
                ))}
                <span className="text-[10px] text-muted">
                  {t.scope === "platform"
                    ? "平台"
                    : t.scope === "team"
                      ? t.team?.name || "项目组"
                      : "个人"}
                </span>
                {t.purposes.includes("preview") && (
                  <span className="text-[10px] font-medium text-indigo-600 dark:text-indigo-400">
                    实例 {t.activePreviewInstances}/{t.maxPreviewInstances}
                  </span>
                )}
              </div>
              {t.labels.length > 0 && (
                <div className="mt-1 truncate text-[10px] text-slate-400">
                  {t.labels.map((label) => `#${label}`).join("  ")}
                </div>
              )}
              <div className="mt-1 flex items-center gap-1 text-[10px] text-slate-400">
                <CalendarDays size={11} />
                {new Date(t.createdAt).toLocaleString("zh-CN")}
              </div>
            </div>
            <button
              onClick={() => toggleEnabled(t)}
              disabled={update.isPending}
              className="btn btn-ghost btn-sm"
              title={t.enabled ? "停用资源" : "启用资源"}
            >
              <Power size={14} />
              <span className="hidden xl:inline">
                {t.enabled ? "停用" : "启用"}
              </span>
            </button>
            <button
              onClick={() => setSelectedTargetId(t.id)}
              className="btn btn-ghost btn-sm"
              title="查看详细配置"
            >
              <Eye size={14} />
              <span className="hidden sm:inline">查看详情</span>
            </button>
            <button
              onClick={() => handleRemove(t)}
              disabled={remove.isPending}
              title="删除"
              className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 transition hover:bg-red-50 hover:text-red-500 disabled:opacity-40 dark:hover:bg-red-500/10"
            >
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </div>

      {selectedTargetId && (
        <TargetDetailModal
          targetId={selectedTargetId}
          registryName={(id) =>
            registries.find((registry) => registry.id === id)?.name
          }
          onClose={() => setSelectedTargetId(undefined)}
        />
      )}
    </div>
  );
}

function TargetKindIcon({ kind }: { kind: string }) {
  if (kind === "k8s") return <Boxes size={20} />;
  if (kind === "docker-ssh") return <Server size={20} />;
  if (kind === "server-artifact") return <HardDrive size={20} />;
  return <Server size={20} />;
}

function Info({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl bg-slate-50 p-2.5 dark:bg-slate-950/40"><div className="text-[9px] text-muted">{label}</div><div className="mt-1 break-all font-mono text-[10px]">{value}</div></div>;
}

function TargetDetailModal({
  targetId,
  registryName,
  onClose,
}: {
  targetId: string;
  registryName: (id: string) => string | undefined;
  onClose: () => void;
}) {
  const detail = useDeployTarget(targetId);
  const target = detail.data;
  const config = target?.config;
  const cluster = useClusterOverview(target?.kind === "k8s" ? targetId : undefined);
  const deletePod = useDeleteClusterPod(target?.kind === "k8s" ? targetId : undefined);
  const deploymentActions = useClusterDeploymentActions(target?.kind === "k8s" ? targetId : undefined);
  const { confirm: askConfirm, prompt: askPrompt, toast } = useFeedback();
  const [selectedPod, setSelectedPod] = useState<{ namespace: string; name: string }>();
  const [selectedContainer, setSelectedContainer] = useState("");
  const podDetail = usePod(target?.kind === "k8s" ? targetId : undefined, selectedPod?.namespace, selectedPod?.name);
  const podLogs = usePodLogs(target?.kind === "k8s" ? targetId : undefined, selectedPod?.namespace, selectedPod?.name, selectedContainer || undefined);

  const rows: Array<[string, string]> = [];
  if (target) {
    rows.push(
      [
        "可见范围",
        target.scope === "platform"
          ? "整个平台"
          : target.scope === "team"
            ? target.team?.name || "项目组"
            : "仅创建者",
      ],
      [
        "用途",
        target.purposes
          .map((item) => (item === "preview" ? "个人预览" : "统一部署"))
          .join("、") || "—",
      ],
    );
    if (target.purposes.includes("preview")) {
      rows.push(
        [
          "预览实例",
          `${target.activePreviewInstances} / ${target.maxPreviewInstances}`,
        ],
        [
          "容量",
          `${target.capacityCpu ? `${target.capacityCpu} CPU` : "CPU 未限制"} · ${target.capacityMemoryMb ? `${target.capacityMemoryMb} MB` : "内存未限制"}`,
        ],
      );
    }
  }
  if (target?.kind === "docker-tcp" && config) {
    rows.push(
      ["Docker 主机", `${config.host}:${config.port}`],
      ["TLS", config.tls ? "已启用" : "未启用"],
    );
  }
  if (
    (target?.kind === "docker-ssh" || target?.kind === "server-artifact") &&
    config
  ) {
    rows.push(
      ["SSH 地址", `${config.username}@${config.host}:${config.port}`],
      ["SSH 私钥", config.privateKeyConfigured ? "已安全保存" : "未配置"],
      ["私钥口令", config.passphraseConfigured ? "已安全保存" : "未配置"],
    );
    if (target.kind === "server-artifact") {
      rows.push(
        [
          "主机指纹校验",
          config.hostFingerprintConfigured ? "已启用" : "未配置",
        ],
        ["远端目标目录", config.remotePath || "—"],
        ["重启命令", config.restartCmd || "未配置"],
      );
    }
  }
  if (target?.kind === "k8s" && config) {
    rows.push(
      ["API Server", config.clusterServer || "未能从 kubeconfig 解析"],
      ["集群名称", config.clusterName || "—"],
      ["当前 Context", config.currentContext || "—"],
      ["部署 Namespace", config.namespace || "default"],
      ["监控数据源", config.prometheusUrl || "未配置 Prometheus"],
      ["监控认证", config.prometheusAuthConfigured ? "已安全保存" : "未配置"],
      ["集群指标选择器", config.prometheusClusterLabel ? `${config.prometheusClusterLabel}=${config.prometheusClusterValue}` : "独占数据源，无额外选择器"],
      ["访问域名", config.baseDomain || "默认使用 localhost"],
      [
        "镜像仓库",
        config.registryId
          ? registryName(config.registryId) || `已配置（${config.registryId}）`
          : "未配置，仅适合共享本地镜像库的集群",
      ],
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="card animate-fade-in max-h-[88vh] w-full max-w-2xl overflow-y-auto">
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-slate-200/80 bg-white/95 px-5 py-4 backdrop-blur dark:border-slate-800 dark:bg-slate-900/95">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300">
              <TargetKindIcon kind={target?.kind || ""} />
            </span>
            <div className="min-w-0">
              <h2 className="truncate text-base font-semibold">
                {target?.name || "部署目标详情"}
              </h2>
              <p className="mt-0.5 text-xs text-muted">
                {target ? KIND_LABEL[target.kind] || target.kind : "正在读取…"}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="icon-btn" aria-label="关闭详情">
            <X size={16} />
          </button>
        </div>

        <div className="space-y-5 p-5">
          {detail.isLoading ? (
            <div className="surface-soft py-12 text-center text-sm text-muted">
              正在读取安全配置概况…
            </div>
          ) : detail.isError || !target ? (
            <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300">
              读取部署目标详情失败。
            </div>
          ) : (
            <>
              <div>
                <div className="eyebrow">Connection overview</div>
                <p className="mt-1 text-sm leading-6 text-muted">
                  {KIND_DESCRIPTION[target.kind] || target.summary}
                </p>
              </div>

              {target.kind === "k8s" && (
                <div
                  className={`flex items-center gap-2 rounded-xl border px-3 py-2.5 text-xs ${
                    config?.kubeconfigValid
                      ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300"
                      : "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300"
                  }`}
                >
                  {config?.kubeconfigValid ? (
                    <CheckCircle2 size={15} />
                  ) : (
                    <TriangleAlert size={15} />
                  )}
                  {config?.kubeconfigValid
                    ? "kubeconfig 结构解析正常"
                    : "kubeconfig 已保存，但无法解析出当前集群信息"}
                </div>
              )}

              {target.kind === "k8s" && <section className="overflow-hidden rounded-2xl border border-slate-200/80 dark:border-slate-800">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200/80 px-4 py-3 dark:border-slate-800">
                  <div><h3 className="text-sm font-semibold">集群工作负载</h3><p className="mt-0.5 text-[10px] text-muted">直接读取 Kubernetes API，每 5 秒刷新 · 全部 Namespace</p></div>
                  <button className="btn btn-ghost btn-sm" disabled={cluster.isFetching} onClick={() => cluster.refetch()}><RefreshCw size={13} className={cluster.isFetching ? "animate-spin" : ""} />刷新</button>
                </div>
                {cluster.isLoading && <div className="p-8 text-center text-xs text-muted">正在连接集群并读取 Pod…</div>}
                {cluster.isError && <div className="m-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300"><div className="font-semibold">集群不可达/无法连接</div><p className="mt-1 break-all text-xs">{errText(cluster.error)}</p></div>}
                {cluster.data && <>
                  <div className="flex flex-wrap gap-3 bg-slate-50/70 px-4 py-2 text-[10px] text-muted dark:bg-slate-950/30"><span>Deployment {cluster.data.deployments.length}</span><span>Pod {cluster.data.pods.length}</span><span>Namespace {cluster.data.namespaces.length}</span><span>采集时间 {new Date(cluster.data.observedAt).toLocaleTimeString("zh-CN")}</span></div>
                  <div className="border-t border-slate-200/70 dark:border-slate-800"><div className="px-4 py-3 text-xs font-semibold">Deployments</div><div className="max-h-72 overflow-auto"><table className="w-full min-w-[900px] text-left text-xs"><thead className="sticky top-0 bg-white text-muted dark:bg-slate-900"><tr><th className="px-4 py-3">Deployment</th><th>Namespace</th><th>Ready</th><th>当前/期望</th><th>策略</th><th>镜像</th><th className="pr-4 text-right">操作</th></tr></thead><tbody>{cluster.data.deployments.map((deployment) => <tr key={`${deployment.namespace}/${deployment.name}`} className="border-t border-slate-200/70 dark:border-slate-800"><td className="px-4 py-3 font-semibold">{deployment.name}</td><td className="font-mono text-[10px]">{deployment.namespace}</td><td><span className={`rounded-full px-2 py-1 text-[9px] font-semibold ${deployment.ready === deployment.desired ? "bg-emerald-50 text-emerald-600" : "bg-amber-50 text-amber-600"}`}>{deployment.ready}/{deployment.desired}</span></td><td>{deployment.current}/{deployment.desired}</td><td>{deployment.strategy}</td><td className="max-w-52 truncate text-[10px]" title={deployment.images.join("\n")}>{deployment.images.join(", ") || "—"}</td><td className="pr-4"><div className="flex justify-end gap-1"><button className="btn btn-ghost btn-sm" disabled={deploymentActions.scale.isPending} onClick={async () => {
                    const value = await askPrompt({ title: "扩缩容 Deployment", message: `${deployment.namespace}/${deployment.name} 当前期望副本数为 ${deployment.desired}`, initialValue: String(deployment.desired), inputType: "number", confirmText: "应用", validate: (input) => Number.isInteger(Number(input)) && Number(input) >= 0 && Number(input) <= 1000 ? undefined : "请输入 0 到 1000 的整数" });
                    if (value == null) return;
                    try { await deploymentActions.scale.mutateAsync({ namespace: deployment.namespace, name: deployment.name, replicas: Number(value) }); toast("副本数更新请求已提交", { tone: "success" }); } catch (error) { toast(errText(error), { title: "扩缩容失败", tone: "error" }); }
                  }}>扩缩容</button><button className="btn btn-ghost btn-sm" disabled={deploymentActions.restart.isPending} onClick={async () => {
                    if (!(await askConfirm({ title: "滚动重启", message: `确认滚动重启 ${deployment.namespace}/${deployment.name}？`, confirmText: "重启", tone: "danger" }))) return;
                    try { await deploymentActions.restart.mutateAsync({ namespace: deployment.namespace, name: deployment.name }); toast("滚动重启请求已提交", { tone: "success" }); } catch (error) { toast(errText(error), { title: "重启失败", tone: "error" }); }
                  }}><RotateCcw size={12} />重启</button><button className="btn btn-ghost btn-sm text-red-500" disabled={deploymentActions.remove.isPending} onClick={async () => {
                    if (!(await askConfirm({ title: "删除 Deployment", message: `确认删除 ${deployment.namespace}/${deployment.name}？其管理的 Pod 也会被级联删除。`, confirmText: "删除 Deployment", tone: "danger" }))) return;
                    try { await deploymentActions.remove.mutateAsync({ namespace: deployment.namespace, name: deployment.name }); toast("Deployment 删除请求已提交", { tone: "success" }); } catch (error) { toast(errText(error), { title: "删除失败", tone: "error" }); }
                  }}><Trash2 size={12} />删除</button></div></td></tr>)}{!cluster.data.deployments.length && <tr><td colSpan={7} className="px-4 py-8 text-center text-muted">集群当前没有 Deployment</td></tr>}</tbody></table></div></div>
                  <div className="border-t border-slate-200/70 px-4 py-3 text-xs font-semibold dark:border-slate-800">Pods</div>
                  <div className="max-h-[420px] overflow-auto"><table className="w-full min-w-[900px] text-left text-xs"><thead className="sticky top-0 bg-white text-muted dark:bg-slate-900"><tr><th className="px-4 py-3">Pod / 工作负载</th><th>Namespace</th><th>状态</th><th>Ready</th><th>重启</th><th>节点 / Pod IP</th><th>镜像</th><th className="pr-4 text-right">操作</th></tr></thead><tbody>{cluster.data.pods.map((pod) => <tr key={`${pod.namespace}/${pod.name}`} onClick={() => { setSelectedPod({ namespace: pod.namespace, name: pod.name }); setSelectedContainer(""); }} className={`cursor-pointer border-t border-slate-200/70 dark:border-slate-800 ${selectedPod?.namespace === pod.namespace && selectedPod.name === pod.name ? "bg-indigo-50 dark:bg-indigo-500/10" : "hover:bg-slate-50 dark:hover:bg-slate-800/40"}`}><td className="max-w-56 px-4 py-3"><div className="truncate font-semibold" title={pod.name}>{pod.name}</div><div className="mt-1 text-[9px] text-muted">{pod.workloadKind && pod.workloadName ? `${pod.workloadKind}/${pod.workloadName}` : "独立 Pod"}</div></td><td className="font-mono text-[10px]">{pod.namespace}</td><td><span className={`rounded-full px-2 py-1 text-[9px] font-semibold ${pod.phase === "Running" ? "bg-emerald-50 text-emerald-600" : pod.phase === "Pending" ? "bg-amber-50 text-amber-600" : "bg-red-50 text-red-600"}`}>{pod.phase}</span></td><td>{pod.ready}</td><td>{pod.restarts}</td><td><div>{pod.node || "—"}</div><div className="mt-1 font-mono text-[9px] text-muted">{pod.podIP || "—"}</div></td><td className="max-w-52 truncate text-[10px]" title={pod.images.join("\n")}>{pod.images.join(", ") || "—"}</td><td className="pr-4 text-right"><button className="btn btn-ghost btn-sm text-red-500" disabled={deletePod.isPending} onClick={async (event) => {
                    event.stopPropagation();
                    if (!(await askConfirm({ title: "删除 Pod", message: `确认删除 ${pod.namespace}/${pod.name}？如果它由 Deployment 等控制器管理，集群通常会自动创建替代 Pod。`, confirmText: "删除 Pod", tone: "danger" }))) return;
                    try { await deletePod.mutateAsync({ namespace: pod.namespace, name: pod.name }); toast("Pod 删除请求已提交", { tone: "success" }); }
                    catch (error) { toast(errText(error), { title: "Pod 删除失败", tone: "error" }); }
                  }}><Trash2 size={12} />删除</button></td></tr>)}{!cluster.data.pods.length && <tr><td colSpan={8} className="px-4 py-10 text-center text-muted">集群当前没有 Pod</td></tr>}</tbody></table></div>
                  {selectedPod && <div className="border-t border-slate-200 p-4 dark:border-slate-800">
                    <div className="flex items-center justify-between gap-3"><div><h4 className="text-sm font-semibold">{selectedPod.name}</h4><p className="text-[10px] text-muted">{selectedPod.namespace} · API 实时详情</p></div><button className="icon-btn" onClick={() => setSelectedPod(undefined)}><X size={14} /></button></div>
                    {podDetail.isError && <div className="mt-3 rounded-xl bg-red-50 p-3 text-xs text-red-600">Pod 详情读取失败：{errText(podDetail.error)}</div>}
                    {podDetail.data && <div className="mt-3 grid gap-4 lg:grid-cols-2">
                      <div className="space-y-3"><div className="grid grid-cols-2 gap-2 text-xs"><Info label="状态" value={podDetail.data.status} /><Info label="Ready" value={podDetail.data.ready} /><Info label="节点" value={podDetail.data.node || "—"} /><Info label="Pod IP" value={podDetail.data.ip || "—"} /></div><div><div className="mb-2 text-xs font-semibold">容器</div><div className="space-y-2">{podDetail.data.containers.map((container) => <button key={container.name} onClick={() => setSelectedContainer(container.name)} className={`w-full rounded-xl border p-3 text-left text-xs dark:border-slate-700 ${selectedContainer === container.name ? "border-indigo-400 bg-indigo-50 dark:bg-indigo-500/10" : ""}`}><div className="flex justify-between gap-2"><b>{container.name}</b><span>{container.ready ? "Ready" : "Not Ready"} · 重启 {container.restartCount}</span></div><div className="mt-1 truncate text-[10px] text-muted" title={container.image}>{container.image}</div><div className="mt-1 text-[10px] text-muted">状态：{String(container.state.type || "unknown")}</div></button>)}</div></div></div>
                      <div><div className="mb-2 flex items-center justify-between"><span className="text-xs font-semibold">日志 {selectedContainer && `· ${selectedContainer}`}</span><button className="btn btn-ghost btn-sm" onClick={() => podLogs.refetch()}><RefreshCw size={12} className={podLogs.isFetching ? "animate-spin" : ""} />刷新</button></div><pre className="max-h-64 min-h-40 overflow-auto whitespace-pre-wrap rounded-xl bg-slate-950 p-3 text-[10px] text-slate-200">{podLogs.isLoading ? "正在读取日志…" : podLogs.isError ? errText(podLogs.error) : podLogs.data?.logs || "暂无日志"}</pre></div>
                      <div className="lg:col-span-2"><div className="mb-2 text-xs font-semibold">最近事件</div><div className="max-h-48 space-y-2 overflow-auto">{podDetail.data.events.map((event, index) => <div key={`${event.reason}-${event.lastAt}-${index}`} className={`rounded-xl p-3 text-xs ${event.type === "Warning" ? "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-200" : "bg-slate-50 dark:bg-slate-950/40"}`}><div className="flex justify-between gap-3"><b>{event.reason || event.type}</b><span className="text-[10px] opacity-70">{event.lastAt ? new Date(event.lastAt).toLocaleString("zh-CN") : "—"} · {event.count} 次</span></div><p className="mt-1 break-words text-[10px]">{event.message || "—"}</p></div>)}{!podDetail.data.events.length && <div className="text-xs text-muted">暂无事件</div>}</div></div>
                    </div>}
                  </div>}
                </>}
              </section>}

              <dl className="overflow-hidden rounded-2xl border border-slate-200/80 dark:border-slate-800">
                {rows.map(([label, value]) => (
                  <div
                    key={label}
                    className="grid gap-1 border-b border-slate-200/70 px-4 py-3 last:border-0 sm:grid-cols-[140px_1fr] dark:border-slate-800"
                  >
                    <dt className="text-xs font-medium text-muted">{label}</dt>
                    <dd className="break-all font-mono text-xs text-slate-700 dark:text-slate-200">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>

              <div className="flex items-start gap-2.5 rounded-xl bg-slate-50 p-3 text-[11px] leading-5 text-muted dark:bg-slate-950/45">
                <KeyRound
                  size={14}
                  className="mt-0.5 shrink-0 text-indigo-500"
                />
                <span>
                  为保护连接凭证，SSH 私钥、私钥口令、kubeconfig
                  原文、证书和访问令牌只在服务端解密使用，详情接口不会返回这些内容。
                </span>
              </div>

              <p className="flex items-center gap-1.5 text-[11px] text-slate-400">
                <CalendarDays size={12} /> 创建于{" "}
                {new Date(target.createdAt).toLocaleString("zh-CN")}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
