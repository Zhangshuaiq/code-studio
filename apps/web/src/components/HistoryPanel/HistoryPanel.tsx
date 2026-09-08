import { useEffect, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { History } from "lucide-react";
import { monacoLang } from "../../lib/monaco";
import { useTheme } from "../../store/theme";
import {
  useCommits,
  useCommitDiff,
  useRollback,
} from "../../hooks/useGit";
import { useFeedback } from "../common/FeedbackProvider";
import { Select } from "../common/Select";

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}秒前`;
  if (s < 3600) return `${Math.floor(s / 60)}分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)}小时前`;
  return new Date(ts).toLocaleString();
}

const KIND_LABEL: Record<string, string> = {
  added: "新增",
  modified: "修改",
  deleted: "删除",
};

export function HistoryPanel({ sessionId }: { sessionId?: string }) {
  const theme = useTheme((s) => s.theme);
  const { confirm: askConfirm } = useFeedback();
  const commits = useCommits(sessionId);
  const rollback = useRollback(sessionId);
  const [sel, setSel] = useState<string>();
  const [file, setFile] = useState<string>();

  useEffect(() => {
    if (!sel && commits.data?.length) setSel(commits.data[0].hash);
  }, [commits.data, sel]);

  const diff = useCommitDiff(sessionId, sel);
  useEffect(() => {
    setFile(diff.data?.[0]?.path);
  }, [diff.data]);

  const current = diff.data?.find((item) => item.path === file);
  const selectedCommit = commits.data?.find((commit) => commit.hash === sel);

  return (
    <div className="flex h-full min-h-0 bg-white dark:bg-slate-900">
      <aside className="w-64 shrink-0 overflow-y-auto border-r border-slate-200 bg-slate-50/70 dark:border-slate-800 dark:bg-slate-950/30">
        <div className="border-b border-slate-200/80 px-4 py-3 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <History size={15} className="text-indigo-500" />
            <div>
              <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted">
                提交历史
                {commits.data?.length ? ` (${commits.data.length})` : ""}
              </div>
              <div className="mt-1 text-[11px] text-slate-400">
                查看变更与恢复历史版本
              </div>
            </div>
          </div>
        </div>

        {commits.isLoading ? (
          <p className="px-4 py-3 text-xs text-muted">加载中…</p>
        ) : !commits.data?.length ? (
          <p className="px-4 py-3 text-xs text-muted">
            还没有提交（先生成一次）
          </p>
        ) : (
          <ul className="py-1">
            {commits.data.map((commit) => (
              <li key={commit.hash}>
                <button
                  onClick={() => setSel(commit.hash)}
                  className={`mx-1.5 my-1 block w-[calc(100%_-_0.75rem)] rounded-xl border px-3 py-2.5 text-left transition ${
                    sel === commit.hash
                      ? "border-indigo-200 bg-white shadow-sm dark:border-indigo-500/30 dark:bg-indigo-500/10"
                      : "border-transparent hover:bg-white/80 dark:hover:bg-slate-800/70"
                  }`}
                >
                  <div className="truncate text-xs font-medium text-slate-700 dark:text-slate-200">
                    {commit.subject}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted">
                    <span className="font-mono">{commit.short}</span>
                    <span>{timeAgo(commit.date)}</span>
                  </div>
                  <div
                    className="mt-1 truncate text-[10px] text-slate-400"
                    title={`${commit.authorName} <${commit.authorEmail}>`}
                  >
                    {commit.authorName} · {commit.authorEmail}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="panel flex min-h-[54px] items-center gap-3 border-b px-4">
          <div className="min-w-0">
            <div className="truncate text-xs font-semibold text-slate-700 dark:text-slate-200">
              {selectedCommit?.subject ?? "选择一次提交"}
            </div>
            <div className="mt-0.5 text-[10px] text-muted">
              {diff.data ? `${diff.data.length} 个文件改动` : "查看提交差异"}
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {!!diff.data?.length && (
              <Select
                value={file ?? ""}
                onChange={setFile}
                options={diff.data.map((item) => ({
                  value: item.path,
                  label: `[${KIND_LABEL[item.kind]}] ${item.path}`,
                }))}
                size="sm"
                className="w-[260px]"
                buttonClassName="text-[11px]"
                ariaLabel="选择改动文件"
              />
            )}
            <button
              onClick={async () => {
                if (
                  sel &&
                  (await askConfirm({
                    title: "回滚到此版本",
                    message:
                      "当前代码会被覆盖，并记录为一次新的提交；之后仍可恢复到更新版本。",
                    confirmText: "确认回滚",
                    tone: "danger",
                  }))
                ) {
                  rollback.mutate(sel);
                }
              }}
              disabled={!sel || rollback.isPending}
              className="btn btn-ghost btn-sm"
              title="把项目还原到这次提交的状态"
            >
              {rollback.isPending ? "回滚中…" : "⤺ 回滚到此版本"}
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1">
          {diff.isLoading ? (
            <Center>加载改动…</Center>
          ) : !current ? (
            <Center>该提交无可显示的文本改动</Center>
          ) : (
            <DiffEditor
              key={`${sel}-${current.path}`}
              language={monacoLang(current.path)}
              original={current.before}
              modified={current.after}
              theme={theme === "dark" ? "vs-dark" : "light"}
              options={{
                fontSize: 13,
                readOnly: true,
                renderSideBySide: true,
                minimap: { enabled: false },
                automaticLayout: true,
                scrollBeyondLastLine: false,
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted">
      {children}
    </div>
  );
}
