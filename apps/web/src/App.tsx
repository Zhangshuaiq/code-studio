import { lazy, Suspense, useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Routes,
  Route,
  Navigate,
  useNavigate,
  useLocation,
  useParams,
} from "react-router-dom";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
  ChevronLeft,
  CodeXml,
  Download,
  Eye,
  History,
  ScrollText,
} from "lucide-react";
import { AppShell } from "./components/Shell/AppShell";
import { ChatPanel } from "./components/ChatPanel/ChatPanel";
import { FileTree } from "./components/FileTree/FileTree";
import { PreviewPanel } from "./components/PreviewPanel/PreviewPanel";
import { HistoryPanel } from "./components/HistoryPanel/HistoryPanel";
import { BranchControl } from "./components/SourceControl/BranchControl";
import { LogPanel } from "./components/LogPanel/LogPanel";
import { LoginForm } from "./components/Auth/LoginForm";
import { ModelSwitcher } from "./components/ModelSettings/ModelSwitcher";
import { EditorTabs } from "./components/EditorTabs/EditorTabs";
import { useEditorTabs } from "./store/editorTabs";
import { SettingsLayout } from "./components/Settings/SettingsLayout";
import { AdminLayout } from "./components/Admin/AdminLayout";
import { ProjectList } from "./components/Projects/ProjectList";
import { useFeedback } from "./components/common/FeedbackProvider";
import { useAuth } from "./store/auth";
import { useProject, useProjectSession } from "./hooks/useProjects";
import { useSessionChanges } from "./hooks/useSessionChanges";
import { downloadProjectZip } from "./lib/download";
import { PermissionGate } from "./components/Auth/PermissionGate";
import { ACCESS } from "./lib/access";
import { useMe } from "./hooks/useMe";

const CodeEditor = lazy(() => import("./components/CodeEditor/CodeEditor").then((m) => ({ default: m.CodeEditor })));
const BusinessLogsPage = lazy(() => import("./components/BusinessLogs/BusinessLogsPage").then((m) => ({ default: m.BusinessLogsPage })));
const ApplicationMonitoringPage = lazy(() => import("./components/Monitoring/ApplicationMonitoringPage").then((m) => ({ default: m.ApplicationMonitoringPage })));
const DeploymentCenterPage = lazy(() => import("./components/DeploymentCenter/DeploymentCenterPage").then((m) => ({ default: m.DeploymentCenterPage })));
const PlatformHealthPage = lazy(() => import("./components/PlatformHealth/PlatformHealthPage").then((m) => ({ default: m.PlatformHealthPage })));
const DbQueryPage = lazy(() => import("./components/DbQuery/DbQueryPage").then((m) => ({ default: m.DbQueryPage })));
const ModelsPage = lazy(() => import("./components/Settings/ModelsPage").then((m) => ({ default: m.ModelsPage })));
const DeployTargetsPage = lazy(() => import("./components/Settings/DeployTargetsPage").then((m) => ({ default: m.DeployTargetsPage })));
const RegistriesPage = lazy(() => import("./components/Settings/RegistriesPage").then((m) => ({ default: m.RegistriesPage })));
const AccountPage = lazy(() => import("./components/Settings/AccountPage").then((m) => ({ default: m.AccountPage })));
const UsersPage = lazy(() => import("./components/Admin/UsersPage").then((m) => ({ default: m.UsersPage })));
const RolesPage = lazy(() => import("./components/Admin/RolesPage").then((m) => ({ default: m.RolesPage })));
const AuditPage = lazy(() => import("./components/Admin/AuditPage").then((m) => ({ default: m.AuditPage })));
const TeamsPage = lazy(() => import("./components/Admin/TeamsPage").then((m) => ({ default: m.TeamsPage })));
const DatasourcesPage = lazy(() => import("./components/Admin/DatasourcesPage").then((m) => ({ default: m.DatasourcesPage })));
const NamespacesPage = lazy(() => import("./components/Admin/NamespacesPage").then((m) => ({ default: m.NamespacesPage })));
const TaskCenterPage = lazy(() => import("./components/TaskCenter/TaskCenterPage").then((m) => ({ default: m.TaskCenterPage })));
const DeadLettersPage = lazy(() => import("./components/Admin/DeadLettersPage").then((m) => ({ default: m.DeadLettersPage })));
const PreviewBuildQueuePage = lazy(() => import("./components/Admin/PreviewBuildQueuePage").then((m) => ({ default: m.PreviewBuildQueuePage })));
const GenerationQueuePage = lazy(() => import("./components/Admin/GenerationQueuePage").then((m) => ({ default: m.GenerationQueuePage })));
const ProjectCleanupsPage = lazy(() => import("./components/Admin/ProjectCleanupsPage").then((m) => ({ default: m.ProjectCleanupsPage })));
const DatabaseApprovalsPage = lazy(() => import("./components/Admin/DatabaseApprovalsPage").then((m) => ({ default: m.DatabaseApprovalsPage })));
const ScheduledTasksPage = lazy(() => import("./components/ScheduledTasks/ScheduledTasksPage").then((m) => ({ default: m.ScheduledTasksPage })));
const TraceExplorerPage = lazy(() => import("./components/Monitoring/TraceExplorerPage").then((m) => ({ default: m.TraceExplorerPage })));
const ExceptionCenterPage = lazy(() => import("./components/Monitoring/ExceptionCenterPage").then((m) => ({ default: m.ExceptionCenterPage })));
const PodMonitoringPage = lazy(() => import("./components/Monitoring/PodMonitoringPage").then((m) => ({ default: m.PodMonitoringPage })));
const KafkaConsolePage = lazy(() => import("./components/Kafka/KafkaConsolePage").then((m) => ({ default: m.KafkaConsolePage })));
const RequirementsPage = lazy(() => import("./components/Requirements/RequirementsPage").then((m) => ({ default: m.RequirementsPage })));
const RequirementDetailPage = lazy(() => import("./components/Requirements/RequirementsPage").then((m) => ({ default: m.RequirementDetailPage })));
const RequirementDocumentPage = lazy(() => import("./components/Requirements/RequirementDocumentPage").then((m) => ({ default: m.RequirementDocumentPage })));
const KnowledgeBasePage = lazy(() => import("./components/Knowledge/KnowledgeBasePage").then((m) => ({ default: m.KnowledgeBasePage })));
const KnowledgeDocumentPage = lazy(() => import("./components/Knowledge/KnowledgeDocumentPage").then((m) => ({ default: m.KnowledgeDocumentPage })));
const McpApprovalsPage = lazy(() => import("./components/Approvals/McpApprovalsPage").then((m) => ({ default: m.McpApprovalsPage })));

type RightTab = "code" | "preview" | "history";

export default function App() {
  const token = useAuth((s) => s.token);
  const location = useLocation();

  if (!token) return <LoginForm />;

  if (/^\/requirements\/[^/]+\/document\/?$/.test(location.pathname)) {
    return <Suspense fallback={<div className="grid h-screen place-items-center text-sm text-muted">正在加载文档…</div>}><Routes><Route path="/requirements/:id/document" element={<PermissionGate anyOf={[ACCESS.requirements]}><RequirementDocumentPage /></PermissionGate>} /></Routes></Suspense>;
  }
  if (/^\/knowledge\/documents\/[^/]+\/?$/.test(location.pathname)) return <Suspense fallback={<div className="grid h-screen place-items-center text-sm text-muted">正在加载文档…</div>}><Routes><Route path="/knowledge/documents/:id" element={<KnowledgeDocumentPage/>}/></Routes></Suspense>;

  return (
    <AppShell>
      <Suspense fallback={<div className="grid h-full place-items-center text-sm text-muted">正在加载页面…</div>}><Routes>
        <Route path="/" element={<PermissionGate anyOf={[ACCESS.projectRead]}><ProjectsPage /></PermissionGate>} />
        <Route path="/projects/:id" element={<PermissionGate anyOf={[ACCESS.projectRead]}><WorkspacePage /></PermissionGate>} />
        <Route path="/tasks" element={<PermissionGate anyOf={[ACCESS.projectRead]}><TaskCenterPage /></PermissionGate>} />
        <Route path="/requirements" element={<PermissionGate anyOf={[ACCESS.requirements]}><RequirementsPage /></PermissionGate>} />
        <Route path="/requirements/:id" element={<PermissionGate anyOf={[ACCESS.requirements]}><RequirementDetailPage /></PermissionGate>} />
        <Route path="/knowledge" element={<KnowledgeBasePage />} />
        <Route path="/logs" element={<PermissionGate anyOf={[ACCESS.observability]}><BusinessLogsPage /></PermissionGate>} />
        <Route path="/monitoring" element={<PermissionGate anyOf={[ACCESS.observability]}><ApplicationMonitoringPage /></PermissionGate>} />
        <Route path="/monitoring/traces" element={<PermissionGate anyOf={[ACCESS.observability]}><TraceExplorerPage /></PermissionGate>} />
        <Route path="/monitoring/exceptions" element={<PermissionGate anyOf={[ACCESS.observability]}><ExceptionCenterPage /></PermissionGate>} />
        <Route path="/monitoring/pods" element={<PermissionGate anyOf={[ACCESS.observability]}><PodMonitoringPage /></PermissionGate>} />
        <Route path="/health" element={<PermissionGate anyOf={[ACCESS.observability]}><PlatformHealthPage /></PermissionGate>} />
        <Route path="/database-approvals" element={<PermissionGate anyOf={[ACCESS.projectRead]}><DatabaseApprovalsPage /></PermissionGate>} />
        <Route path="/mcp-approvals" element={<PermissionGate anyOf={[ACCESS.mcpApprovalReview]}><McpApprovalsPage /></PermissionGate>} />
        <Route path="/scheduled-tasks" element={<PermissionGate anyOf={[ACCESS.scheduledTasks]}><ScheduledTasksPage /></PermissionGate>} />
        <Route path="/kafka" element={<PermissionGate anyOf={[ACCESS.kafka]}><KafkaConsolePage /></PermissionGate>} />
        <Route path="/deployments" element={<PermissionGate anyOf={[ACCESS.deploy]}><DeploymentCenterPage /></PermissionGate>} />
        <Route path="/resources" element={<SettingsLayout />}>
          <Route index element={<PermissionIndex choices={[[ACCESS.deployTargets, 'targets'], [ACCESS.registries, 'registries']]} />} />
          <Route path="targets" element={<PermissionGate anyOf={[ACCESS.deployTargets]}><DeployTargetsPage /></PermissionGate>} />
          <Route path="registries" element={<PermissionGate anyOf={[ACCESS.registries]}><RegistriesPage /></PermissionGate>} />
        </Route>
        <Route path="/settings" element={<SettingsLayout />}>
          <Route index element={<Navigate to="account" replace />} />
          <Route path="models" element={<PermissionGate anyOf={[ACCESS.models]}><ModelsPage /></PermissionGate>} />
          <Route
            path="deploy-targets"
            element={<Navigate to="/resources/targets" replace />}
          />
          <Route
            path="registries"
            element={<Navigate to="/resources/registries" replace />}
          />
          <Route path="account" element={<AccountPage />} />
        </Route>
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<PermissionIndex choices={[
            [ACCESS.adminUsers, 'users'],
            [ACCESS.adminRoles, 'roles'],
            [ACCESS.audit, 'audit'],
            [ACCESS.systemSettings, 'generation-queue'],
            [ACCESS.teams, 'teams'],
            [ACCESS.datasources, 'datasources/relational'],
            [ACCESS.deployTargets, 'namespaces'],
          ]} />} />
          <Route path="users" element={<PermissionGate anyOf={[ACCESS.adminUsers]}><UsersPage /></PermissionGate>} />
          <Route path="roles" element={<PermissionGate anyOf={[ACCESS.adminRoles]}><RolesPage /></PermissionGate>} />
          <Route path="audit" element={<PermissionGate anyOf={[ACCESS.audit]}><AuditPage /></PermissionGate>} />
          <Route path="task-dlq" element={<PermissionGate anyOf={[ACCESS.systemSettings]}><DeadLettersPage /></PermissionGate>} />
          <Route path="generation-queue" element={<PermissionGate anyOf={[ACCESS.systemSettings]}><GenerationQueuePage /></PermissionGate>} />
          <Route path="project-cleanups" element={<PermissionGate anyOf={[ACCESS.systemSettings]}><ProjectCleanupsPage /></PermissionGate>} />
          <Route path="database-approvals" element={<Navigate to="/database-approvals" replace />} />
          <Route path="preview-builds" element={<PermissionGate anyOf={[ACCESS.systemSettings]}><PreviewBuildQueuePage /></PermissionGate>} />
          <Route path="teams" element={<PermissionGate anyOf={[ACCESS.teams]}><TeamsPage /></PermissionGate>} />
          <Route path="datasources/relational" element={<PermissionGate anyOf={[ACCESS.datasources]}><DatasourcesPage /></PermissionGate>} />
          <Route path="datasources/nosql" element={<PermissionGate anyOf={[ACCESS.datasources]}><DatasourcesPage /></PermissionGate>} />
          <Route path="namespaces" element={<PermissionGate anyOf={[ACCESS.deployTargets]}><NamespacesPage /></PermissionGate>} />
        </Route>
        <Route path="/db-query/:datasourceId" element={<PermissionGate anyOf={[ACCESS.projectRead]}><DbQueryPage /></PermissionGate>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes></Suspense>
    </AppShell>
  );
}

function PermissionIndex({ choices }: { choices: ReadonlyArray<readonly [string, string]> }) {
  const me = useMe();
  if (me.isLoading) return <div className="grid h-full place-items-center text-sm text-muted">正在校验权限…</div>;
  const target = choices.find(([permission]) => me.data?.permissions.includes(permission))?.[1];
  return <Navigate to={target || '/'} replace />;
}

function ProjectsPage() {
  const navigate = useNavigate();
  return (
    <div className="h-full overflow-auto rounded-[22px] border border-white/80 bg-white/40 shadow-sm backdrop-blur-sm dark:border-slate-800/80 dark:bg-slate-950/25">
      <ProjectList onOpen={(p) => navigate(`/projects/${p.id}`)} />
    </div>
  );
}

function WorkspacePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const project = useProject(id);
  const session = useProjectSession(id);
  const qc = useQueryClient();
  const { toast } = useFeedback();
  const [tab, setTab] = useState<RightTab>("preview");
  const [genSeq, setGenSeq] = useState(0);
  const [logOpen, setLogOpen] = useState(false);

  // 使用多标签页状态
  const { activeFile, openFile, closeAllFiles } = useEditorTabs();

  const sessionId = session.data?.sessionId;
  const projectName = project.data?.name ?? "项目";

  const changes = useSessionChanges(sessionId);
  const currentChange = (changes.data ?? []).find((c) => c.path === activeFile);

  // 清理：离开工作区时关闭所有标签
  useEffect(() => {
    return () => {
      closeAllFiles();
    };
  }, [closeAllFiles]);

  function handleGenerated() {
    setTab("preview");
    setGenSeq((n) => n + 1);
    setLogOpen(true); // 运行后自动弹出日志
    if (sessionId) {
      qc.invalidateQueries({ queryKey: ["preview", sessionId] });
      qc.invalidateQueries({ queryKey: ["files", sessionId] }); // 文件树
      qc.invalidateQueries({ queryKey: ["file", sessionId] }); // 已打开文件的内容(AI 改动后同步到编辑器)
      qc.invalidateQueries({ queryKey: ["changes", sessionId] }); // 本次改动(diff)
      qc.invalidateQueries({ queryKey: ["commits", sessionId] }); // 提交历史
    }
  }

  return (
    <PanelGroup
      direction="horizontal"
      className="workspace-frame h-full"
      autoSaveId="ws-h"
    >
      {/* 左：对话（可拖拽宽度） */}
      <Panel defaultSize={28} minSize={18} maxSize={50}>
        <div className="h-full">
          <ChatPanel
            sessionId={sessionId}
            onGenerated={handleGenerated}
            readOnly={project.data?.accessRole === "viewer"}
          />
        </div>
      </Panel>
      <PanelResizeHandle className="resize-handle-x" />

      {/* 右：代码/预览 + 底部日志 */}
      <Panel minSize={30}>
        <PanelGroup direction="vertical" className="h-full">
          <Panel minSize={20}>
            <section className="flex h-full min-w-0 flex-col bg-white dark:bg-slate-900">
              <div className="panel flex min-h-[58px] items-center gap-2 border-b px-3">
                <button
                  onClick={() => navigate("/")}
                  className="icon-btn"
                  title="返回项目列表"
                >
                  <ChevronLeft size={18} />
                </button>
                <div className="mr-2 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.12)]" />
                    <span className="max-w-[150px] truncate text-xs font-bold text-slate-800 dark:text-slate-100">
                      {projectName}
                    </span>
                  </div>
                  <span
                    className="mt-0.5 block max-w-[170px] truncate pl-3 text-[9px] tracking-[0.12em] text-slate-400"
                    title={`个人工作区：${session.data?.workspaceBranch || "默认"}`}
                  >
                    个人工作区
                  </span>
                </div>
                <div className="flex items-center gap-1 rounded-xl bg-slate-100/90 p-1 dark:bg-slate-950/60">
                  <TabButton
                    active={tab === "code"}
                    onClick={() => setTab("code")}
                  >
                    <CodeXml size={14} /> 代码
                  </TabButton>
                  <TabButton
                    active={tab === "preview"}
                    onClick={() => setTab("preview")}
                  >
                    <Eye size={14} /> 预览
                  </TabButton>
                  <TabButton
                    active={tab === "history"}
                    onClick={() => setTab("history")}
                  >
                    <History size={14} /> 历史
                  </TabButton>
                </div>
                <div className="ml-auto flex items-center gap-1.5">
                  <button
                    onClick={() => {
                      if (!sessionId) return;
                      downloadProjectZip(sessionId, projectName).catch((e) =>
                        toast(String(e?.message ?? e), {
                          title: "下载失败",
                          tone: "error",
                        }),
                      );
                    }}
                    disabled={!sessionId}
                    className="btn btn-ghost btn-sm"
                    title="下载项目 zip"
                  >
                    <Download size={14} />
                    <span className="hidden 2xl:inline">下载</span>
                  </button>
                  <button
                    onClick={() => setLogOpen((v) => !v)}
                    className={`btn btn-sm ${logOpen ? "btn-primary" : "btn-ghost"}`}
                    title="运行日志"
                  >
                    <ScrollText size={14} />
                    <span className="hidden 2xl:inline">日志</span>
                  </button>
                  <ModelSwitcher sessionId={sessionId} />
                </div>
              </div>

              <div className="min-h-0 flex-1">
                {session.isLoading ? (
                  <Centered>正在准备工作区…</Centered>
                ) : session.isError ? (
                  <Centered>工作区加载失败</Centered>
                ) : tab === "code" ? (
                  <PanelGroup
                    direction="horizontal"
                    className="h-full"
                    autoSaveId="ws-code"
                  >
                    {/* 文件树（可拖拽宽度） */}
                    <Panel defaultSize={22} minSize={12} maxSize={40}>
                      <div className="flex h-full min-h-0 flex-col">
                        <div className="min-h-0 flex-1">
                          <FileTree
                            sessionId={sessionId}
                            rootName={projectName}
                            selected={activeFile}
                            onSelect={(path, line, column) => {
                              openFile(path, line ?? undefined, column ?? undefined);
                              setTab("code");
                            }}
                          />
                        </div>
                        <BranchControl
                          sessionId={sessionId}
                          readOnly={project.data?.accessRole === "viewer"}
                        />
                      </div>
                    </Panel>
                    <PanelResizeHandle className="resize-handle-x" />
                    {/* 编辑区 */}
                    <Panel minSize={30}>
                      <div className="flex h-full flex-col">
                        <EditorTabs />
                        <div className="flex-1 overflow-hidden">
                          <CodeEditor
                            sessionId={sessionId}
                            path={activeFile}
                            change={currentChange}
                            readOnly={project.data?.accessRole === "viewer"}
                          />
                        </div>
                      </div>
                    </Panel>
                  </PanelGroup>
                ) : tab === "history" ? (
                  <HistoryPanel sessionId={sessionId} />
                ) : (
                  <PreviewPanel sessionId={sessionId!} generationSeq={genSeq} />
                )}
              </div>
            </section>
          </Panel>

          {logOpen && (
            <>
              <PanelResizeHandle className="resize-handle-y" />
              <Panel defaultSize={28} minSize={10}>
                <LogPanel
                  sessionId={sessionId}
                  onClose={() => setLogOpen(false)}
                />
              </Panel>
            </>
          )}
        </PanelGroup>
      </Panel>
    </PanelGroup>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
        active
          ? "bg-white text-indigo-700 shadow-sm ring-1 ring-slate-200/80 dark:bg-slate-800 dark:text-indigo-300 dark:ring-slate-700"
          : "text-slate-500 hover:bg-white/70 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800/60 dark:hover:text-slate-200"
      }`}
    >
      {children}
    </button>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted">
      {children}
    </div>
  );
}
