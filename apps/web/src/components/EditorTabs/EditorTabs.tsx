import { X } from "lucide-react";
import { useEditorTabs } from "../../store/editorTabs";
import { useFeedback } from "../common/FeedbackProvider";

// 文件图标映射
const fileIcons: Record<string, string> = {
  tsx: "⚛️",
  ts: "🔷",
  jsx: "⚛️",
  js: "📜",
  json: "📋",
  css: "🎨",
  html: "🌐",
  md: "📝",
  java: "☕",
  xml: "📄",
  yaml: "⚙️",
  yml: "⚙️",
  properties: "🔧",
};

function getFileIcon(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  return fileIcons[ext || ""] || "📄";
}

function getFileName(path: string): string {
  return path.split("/").pop() || path;
}

export function EditorTabs() {
  const { confirm: askConfirm } = useFeedback();
  const {
    openFiles,
    activeFile,
    drafts,
    setActiveFile,
    closeFile,
    closeOtherFiles,
    discardDrafts,
  } = useEditorTabs();

  if (openFiles.length === 0) {
    return null;
  }

  const handleClose = async (e: React.MouseEvent, path: string) => {
    e.stopPropagation();
    const draft = drafts[path];
    if (
      draft?.content !== draft?.baseline &&
      !(await askConfirm({
        title: "放弃未保存的修改",
        message: `${path} 还有未保存内容，关闭标签将放弃这些修改。`,
        confirmText: "放弃并关闭",
        tone: "danger",
      }))
    ) {
      return;
    }
    discardDrafts([path]);
    closeFile(path);
  };

  const handleContextMenu = async (e: React.MouseEvent, path: string) => {
    e.preventDefault();
    const discarded = openFiles.filter(
      (item) =>
        item !== path &&
        drafts[item] &&
        drafts[item].content !== drafts[item].baseline,
    );
    if (
      await askConfirm({
        title: "关闭其他标签",
        message: discarded.length
          ? `其他标签中有 ${discarded.length} 个文件尚未保存，继续将放弃这些修改。`
          : "保留当前文件并关闭其余已打开的标签？",
        confirmText: "关闭其他标签",
        tone: discarded.length ? "danger" : undefined,
      })
    ) {
      discardDrafts(openFiles.filter((item) => item !== path));
      closeOtherFiles(path);
    }
  };

  return (
    <div className="flex min-h-[40px] items-end gap-0.5 overflow-x-auto border-b border-slate-200/80 bg-slate-50/80 px-2 pt-1 dark:border-slate-800 dark:bg-slate-950/35">
      {openFiles.map((path) => {
        const isActive = activeFile === path;
        const fileName = getFileName(path);
        const icon = getFileIcon(path);
        const dirty =
          !!drafts[path] && drafts[path].content !== drafts[path].baseline;

        return (
          <div
            key={path}
            role="button"
            tabIndex={0}
            onClick={() => setActiveFile(path)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") setActiveFile(path);
            }}
            onContextMenu={(e) => handleContextMenu(e, path)}
            title={path}
            className={`group relative flex min-h-[34px] min-w-[120px] max-w-[200px] cursor-pointer items-center gap-1.5 rounded-t-xl border border-b-0 px-3 py-1.5 text-xs transition ${
              isActive
                ? "border-slate-200 bg-white font-medium text-slate-800 shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                : "border-transparent bg-transparent text-slate-500 hover:bg-white/70 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800/70 dark:hover:text-slate-200"
            }`}
          >
            <span className="text-sm">{icon}</span>
            <span className="flex-1 truncate text-left">{fileName}</span>
            {dirty && (
              <span
                className="h-2 w-2 shrink-0 rounded-full bg-amber-500"
                title="未保存"
              />
            )}
            <button
              onClick={(e) => handleClose(e, path)}
              className={`rounded p-0.5 transition hover:bg-slate-200 dark:hover:bg-slate-700 ${
                isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100"
              }`}
              title="关闭"
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
