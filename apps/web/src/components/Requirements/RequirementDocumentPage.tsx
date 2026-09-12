import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Bold, Code2, Eye, Heading1, Heading2, Heading3, Italic, Link2, List, ListChecks, ListOrdered, PanelLeft, Quote, Save, Table2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link, useParams } from "react-router-dom";
import { useMe } from "../../hooks/useMe";
import { useRequirement, useRequirementMutations, useRequirementRevisions } from "../../hooks/useRequirements";
import { ACCESS } from "../../lib/access";
import { errText } from "../Settings/ui";
import { useFeedback } from "../common/FeedbackProvider";

type ViewMode = "edit" | "split" | "preview";

export function RequirementDocumentPage() {
  const { id } = useParams();
  const requirement = useRequirement(id);
  const revisions = useRequirementRevisions(id);
  const me = useMe();
  const { toast } = useFeedback();
  const [content, setContent] = useState("");
  const [changeSummary, setChangeSummary] = useState("");
  const [mode, setMode] = useState<ViewMode>("split");
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => setContent(requirement.data?.contentMarkdown || ""), [requirement.data?.id, requirement.data?.contentMarkdown]);
  const data = requirement.data;
  const isOwner = !!data && (data.ownerId === me.data?.id || me.data?.roles.includes("admin"));
  const editable = !!data && isOwner && !!me.data?.permissions.includes(ACCESS.requirementManage) && ["draft", "active"].includes(data.status);
  const mutations = useRequirementMutations(id, data?.updatedAt);
  const latestRevision = revisions.data?.items[0];
  const outline = useMemo(() => content.split("\n").flatMap((line, index) => {
    const match = /^(#{1,6})\s+(.+)$/.exec(line);
    return match ? [{ level: match[1].length, title: match[2].replace(/[*_`]/g, ""), line: index }] : [];
  }), [content]);

  const insert = (prefix: string, suffix = "", placeholder = "文字") => {
    const node = textarea.current;
    if (!node || !editable) return;
    const start = node.selectionStart; const end = node.selectionEnd;
    const selected = content.slice(start, end) || placeholder;
    const next = `${content.slice(0, start)}${prefix}${selected}${suffix}${content.slice(end)}`;
    setContent(next);
    requestAnimationFrame(() => { node.focus(); node.setSelectionRange(start + prefix.length, start + prefix.length + selected.length); });
  };
  const save = async () => {
    if (!data) return;
    try {
      await mutations.saveDocument.mutateAsync({ baseVersion: data.documentVersion, contentMarkdown: content, changeSummary: changeSummary.trim() || undefined });
      setChangeSummary(""); toast("详细需求文档已保存", { tone: "success" });
    } catch (error) { toast(errText(error), { title: "保存失败", tone: "error" }); }
  };

  if (requirement.isLoading) return <div className="grid h-full place-items-center text-sm text-muted">正在打开文档…</div>;
  if (!data) return <div className="grid h-full place-items-center text-sm text-muted">文档不存在或无权访问</div>;
  return <main className="flex h-full min-h-0 flex-col overflow-hidden bg-white dark:bg-slate-950">
    <header className="shrink-0 border-b border-slate-200 px-5 py-3 dark:border-slate-800">
      <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-3"><Link to={`/requirements/${data.id}`} className="icon-btn" aria-label="返回需求详情"><ArrowLeft size={17}/></Link><div className="min-w-0"><div className="font-mono text-[10px] text-indigo-600">{data.requirementNo} · 详细设计</div><h1 className="truncate text-lg font-bold">{data.title}</h1></div></div><div className="flex items-center gap-2"><div className="flex rounded-lg bg-slate-100 p-1 dark:bg-slate-900">{([{ key: "edit", label: "编辑", icon: PanelLeft }, { key: "split", label: "分屏", icon: Code2 }, { key: "preview", label: "阅读", icon: Eye }] as const).map(({ key, label, icon: Icon }) => <button key={key} onClick={() => setMode(key)} className={`flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs ${mode === key ? "bg-white font-medium text-indigo-600 shadow-sm dark:bg-slate-800" : "text-muted"}`}><Icon size={13}/>{label}</button>)}</div>{editable && <button className="btn btn-primary" disabled={content === data.contentMarkdown || mutations.saveDocument.isPending} onClick={() => void save()}><Save size={14}/>{mutations.saveDocument.isPending ? "保存中" : "保存"}</button>}</div></div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t border-slate-100 pt-3 text-[11px] text-muted dark:border-slate-800"><span>创建人：{displayUser(data.createdBy)}</span><span>最后更新人：{displayUser(latestRevision?.createdBy || data.createdBy)}</span><span>创建时间：{formatTime(data.createdAt)}</span><span>最后更新时间：{formatTime(latestRevision?.createdAt || data.updatedAt)}</span><span>版本：v{data.documentVersion}</span></div>
    </header>
    {mode !== "preview" && <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-slate-200 bg-slate-50 px-4 py-2 dark:border-slate-800 dark:bg-slate-900/70">{[
      [Heading1, "一级标题", () => insert("# ", "", "一级标题")], [Heading2, "二级标题", () => insert("## ", "", "二级标题")], [Heading3, "三级标题", () => insert("### ", "", "三级标题")], [Bold, "粗体", () => insert("**", "**")], [Italic, "斜体", () => insert("*", "*")], [Quote, "引用", () => insert("> ")], [List, "无序列表", () => insert("- ", "", "列表项")], [ListOrdered, "有序列表", () => insert("1. ", "", "列表项")], [ListChecks, "任务清单", () => insert("- [ ] ", "", "待办事项")], [Table2, "表格", () => insert("| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n| 内容 | 内容 | 内容 |\n", "", "")], [Link2, "链接", () => insert("[", "](https://)", "链接文字")], [Code2, "代码块", () => insert("```\n", "\n```", "代码")],
    ].map(([Icon, label, action]) => { const ToolIcon = Icon as typeof Bold; return <button key={label as string} className="icon-btn" title={label as string} aria-label={label as string} onClick={action as () => void}><ToolIcon size={15}/></button>; })}<span className="ml-2 text-[10px] text-muted">支持表格、任务清单、删除线、链接与代码块</span></div>}
    <div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)]">
      <aside className="min-h-0 overflow-y-auto border-r border-slate-200 bg-slate-50/60 p-4 dark:border-slate-800 dark:bg-slate-900/40"><div className="mb-3 text-xs font-semibold">文档大纲</div>{outline.map((item) => <button key={`${item.line}-${item.title}`} onClick={() => { const node = textarea.current; if (!node) return; const position = content.split("\n").slice(0, item.line).reduce((sum, line) => sum + line.length + 1, 0); node.focus(); node.setSelectionRange(position, position); }} className="block w-full truncate rounded-md py-1.5 pr-2 text-left text-xs text-muted hover:bg-white hover:text-indigo-600 dark:hover:bg-slate-800" style={{ paddingLeft: `${Math.max(0, item.level - 1) * 12 + 8}px` }} title={item.title}>{item.title}</button>)}{!outline.length && <p className="text-[11px] leading-5 text-muted">添加 Markdown 标题后自动生成大纲。</p>}</aside>
      <div className={`grid min-h-0 ${mode === "split" ? "lg:grid-cols-2" : "grid-cols-1"}`}>
        {mode !== "preview" && <section className="flex min-h-0 flex-col border-r border-slate-200 dark:border-slate-800"><textarea ref={textarea} value={content} readOnly={!editable} onChange={(event) => setContent(event.target.value)} spellCheck={false} placeholder="# 需求背景\n\n在这里编写详细需求文档…" className="min-h-0 flex-1 resize-none bg-white p-6 font-mono text-sm leading-7 outline-none dark:bg-slate-950"/>{editable && <div className="shrink-0 border-t border-slate-200 p-3 dark:border-slate-800"><input className="input w-full" maxLength={200} value={changeSummary} onChange={(event) => setChangeSummary(event.target.value)} placeholder="本次修改说明（可选）"/></div>}</section>}
        {mode !== "edit" && <section className="min-h-0 overflow-y-auto bg-white dark:bg-slate-950"><MarkdownArticle source={content}/></section>}
      </div>
    </div>
  </main>;
}

function MarkdownArticle({ source }: { source: string }) {
  return <article className="mx-auto max-w-4xl px-8 py-10 text-[15px] leading-7 text-slate-700 dark:text-slate-200"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    h1: ({ children }) => <h1 className="mb-6 mt-2 border-b border-slate-200 pb-4 text-4xl font-bold tracking-tight text-slate-950 dark:border-slate-800 dark:text-white">{children}</h1>,
    h2: ({ children }) => <h2 className="mb-4 mt-10 border-b border-slate-100 pb-2 text-2xl font-bold text-slate-900 dark:border-slate-800 dark:text-white">{children}</h2>,
    h3: ({ children }) => <h3 className="mb-3 mt-8 text-xl font-semibold text-slate-900 dark:text-white">{children}</h3>,
    h4: ({ children }) => <h4 className="mb-2 mt-6 text-base font-semibold text-slate-900 dark:text-white">{children}</h4>,
    p: ({ children }) => <p className="my-4">{children}</p>, ul: ({ children }) => <ul className="my-4 list-disc space-y-1 pl-6">{children}</ul>, ol: ({ children }) => <ol className="my-4 list-decimal space-y-1 pl-6">{children}</ol>,
    blockquote: ({ children }) => <blockquote className="my-5 border-l-4 border-indigo-300 bg-indigo-50/60 px-4 py-1 text-slate-600 dark:bg-indigo-500/10 dark:text-slate-300">{children}</blockquote>,
    code: ({ className, children }) => className ? <code className={`${className} text-sm`}>{children}</code> : <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[13px] text-rose-600 dark:bg-slate-800 dark:text-rose-300">{children}</code>,
    pre: ({ children }) => <pre className="my-5 overflow-x-auto rounded-xl bg-slate-950 p-5 text-slate-100">{children}</pre>,
    a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer" className="text-indigo-600 underline decoration-indigo-300 underline-offset-2">{children}</a>,
    table: ({ children }) => <div className="my-5 overflow-x-auto"><table className="w-full border-collapse text-sm">{children}</table></div>, th: ({ children }) => <th className="border border-slate-200 bg-slate-50 px-3 py-2 text-left dark:border-slate-700 dark:bg-slate-900">{children}</th>, td: ({ children }) => <td className="border border-slate-200 px-3 py-2 dark:border-slate-700">{children}</td>,
  }}>{source || "暂无文档内容"}</ReactMarkdown></article>;
}

function displayUser(user?: { username: string; displayName?: string | null } | null) { return user?.displayName || user?.username || "—"; }
function formatTime(value?: string | null) { return value ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—"; }
