import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Bold, Code2, Heading1, Heading2, Heading3, Italic, List, ListOrdered, Plus, Quote, Save, Table2, Trash2 } from "lucide-react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "@tiptap/markdown";
import { TableKit } from "@tiptap/extension-table";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Link, useParams } from "react-router-dom";
import { useMe } from "../../hooks/useMe";
import { useRequirement, useRequirementMutations, useRequirementRevisions } from "../../hooks/useRequirements";
import { ACCESS } from "../../lib/access";
import { errText } from "../Settings/ui";
import { useFeedback } from "../common/FeedbackProvider";

export function RequirementDocumentPage() {
  const { id } = useParams(); const requirement = useRequirement(id); const revisions = useRequirementRevisions(id); const me = useMe(); const { toast } = useFeedback();
  const [content, setContent] = useState(""); const [summary, setSummary] = useState(""); const [, setSelectionVersion] = useState(0);
  const data = requirement.data; const latest = revisions.data?.items[0];
  const editable = !!data && !!(data.ownerId === me.data?.id || me.data?.roles.includes("admin")) && !!me.data?.permissions.includes(ACCESS.requirementManage) && ["draft", "active"].includes(data.status);
  const mutations = useRequirementMutations(id, data?.updatedAt);
  const editor = useEditor({ extensions: [StarterKit, TableKit.configure({ table: { resizable: true, cellMinWidth: 80, lastColumnResizable: true } }), Placeholder.configure({ placeholder: "输入 # 后按空格创建一级标题…" }), Markdown], content: "", contentType: "markdown", editable, editorProps: { attributes: { class: "yuque-editor min-h-full px-10 py-8 outline-none" } }, onUpdate: ({ editor: e }) => setContent(e.getMarkdown()), onSelectionUpdate: () => setSelectionVersion(value => value + 1) });
  useEffect(() => { if (!editor || !data || editor.getMarkdown() === data.contentMarkdown) return; editor.commands.setContent(data.contentMarkdown || "", { contentType: "markdown" }); setContent(data.contentMarkdown || ""); }, [editor, data?.id, data?.contentMarkdown]);
  useEffect(() => editor?.setEditable(editable), [editor, editable]);
  const outline = useMemo(() => content.split("\n").flatMap(line => { const m = /^(#{1,6})\s+(.+)$/.exec(line); return m ? [{ level: m[1].length, title: m[2].replace(/[*_`]/g, "") }] : []; }), [content]);
  const save = async () => { if (!data) return; try { await mutations.saveDocument.mutateAsync({ baseVersion: data.documentVersion, contentMarkdown: content, changeSummary: summary.trim() || undefined }); setSummary(""); toast("文档已保存", { tone: "success" }); } catch (e) { toast(errText(e), { title: "保存失败", tone: "error" }); } };
  if (requirement.isLoading) return <div className="grid h-screen place-items-center text-sm text-muted">正在打开文档…</div>;
  if (!data) return <div className="grid h-screen place-items-center text-sm text-muted">文档不存在或无权访问</div>;
  const tools = [
    [Heading1,"H1",()=>editor?.chain().focus().toggleHeading({level:1}).run()],[Heading2,"H2",()=>editor?.chain().focus().toggleHeading({level:2}).run()],[Heading3,"H3",()=>editor?.chain().focus().toggleHeading({level:3}).run()],
    [Bold,"粗体",()=>editor?.chain().focus().toggleBold().run()],[Italic,"斜体",()=>editor?.chain().focus().toggleItalic().run()],[Quote,"引用",()=>editor?.chain().focus().toggleBlockquote().run()],
    [List,"无序列表",()=>editor?.chain().focus().toggleBulletList().run()],[ListOrdered,"有序列表",()=>editor?.chain().focus().toggleOrderedList().run()],[Table2,"表格",()=>editor?.chain().focus().insertTable({rows:3,cols:3,withHeaderRow:true}).run()],[Code2,"代码块",()=>editor?.chain().focus().toggleCodeBlock().run()],
  ] as const;
  return <main className="flex h-screen min-h-0 flex-col overflow-hidden bg-white dark:bg-slate-950">
    <header className="shrink-0 border-b border-slate-200 px-5 py-3 dark:border-slate-800"><div className="flex items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-3"><Link to={`/requirements/${data.id}`} className="icon-btn"><ArrowLeft size={17}/></Link><div><div className="font-mono text-[10px] text-indigo-600">{data.requirementNo} · 详细设计</div><h1 className="truncate text-lg font-bold">{data.title}</h1></div></div>{editable&&<button className="btn btn-primary" disabled={content===data.contentMarkdown||mutations.saveDocument.isPending} onClick={()=>void save()}><Save size={14}/>保存</button>}</div><div className="mt-3 flex flex-wrap gap-x-5 border-t border-slate-100 pt-3 text-[11px] text-muted dark:border-slate-800"><span>创建人：{user(data.createdBy)}</span><span>最后更新人：{user(latest?.createdBy||data.createdBy)}</span><span>创建时间：{time(data.createdAt)}</span><span>最后更新时间：{time(latest?.createdAt||data.updatedAt)}</span><span>版本：v{data.documentVersion}</span></div></header>
    <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-slate-200 bg-slate-50 px-4 py-2 dark:border-slate-800 dark:bg-slate-900/70">{tools.map(([Icon,label,action])=><button key={label} disabled={!editable} className="icon-btn" title={label} onClick={action}><Icon size={15}/></button>)}{editor?.isActive("table")&&<><span className="mx-2 h-5 w-px bg-slate-300 dark:bg-slate-700"/><button className="btn btn-ghost btn-sm" disabled={!editable} onClick={()=>editor.chain().focus().addRowAfter().run()}><Plus size={13}/>下方新增行</button><button className="btn btn-ghost btn-sm" disabled={!editable} onClick={()=>editor.chain().focus().addColumnAfter().run()}><Plus size={13}/>右侧新增列</button><button className="btn btn-ghost btn-sm text-red-500" disabled={!editable||!editor.can().deleteRow()} onClick={()=>editor.chain().focus().deleteRow().run()}><Trash2 size={13}/>删除行</button><button className="btn btn-ghost btn-sm text-red-500" disabled={!editable||!editor.can().deleteColumn()} onClick={()=>editor.chain().focus().deleteColumn().run()}><Trash2 size={13}/>删除列</button></>}<span className="ml-2 text-[10px] text-muted">输入 #、##、-、1.、&gt; 后按空格可即时转换</span></div>
    <PanelGroup direction="horizontal" className="min-h-0 flex-1"><Panel defaultSize={18} minSize={12} maxSize={35}><aside className="h-full overflow-y-auto bg-slate-50/60 p-4 dark:bg-slate-900/40"><div className="mb-3 text-xs font-semibold">文档大纲</div>{outline.map((item,i)=><button key={i} onClick={()=>{const h=editor?.view.dom.querySelectorAll("h1,h2,h3,h4,h5,h6")[i] as HTMLElement|undefined;h?.scrollIntoView({behavior:"smooth",block:"center"});}} className="block w-full truncate rounded py-1.5 text-left text-xs text-muted hover:text-indigo-600" style={{paddingLeft:(item.level-1)*12+8}}>{item.title}</button>)}</aside></Panel><PanelResizeHandle className="w-1 cursor-col-resize bg-slate-200 hover:bg-indigo-400 dark:bg-slate-800"/><Panel minSize={50}><section className="h-full overflow-y-auto"><EditorContent editor={editor} className="mx-auto min-h-full max-w-5xl"/></section></Panel></PanelGroup>
    {editable&&<div className="shrink-0 border-t p-3 dark:border-slate-800"><input className="input w-full" value={summary} maxLength={200} onChange={e=>setSummary(e.target.value)} placeholder="本次修改说明（可选）"/></div>}
  </main>;
}
const user=(u?:{username:string;displayName?:string|null}|null)=>u?.displayName||u?.username||"—";
const time=(v?:string|null)=>v?new Intl.DateTimeFormat("zh-CN",{dateStyle:"medium",timeStyle:"short"}).format(new Date(v)):"—";
