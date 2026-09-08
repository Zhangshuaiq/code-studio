import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Database, Play, Table, ArrowLeft, Loader2, ChevronDown, Archive, ArrowRightLeft, X, Upload, Download } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useDatasources } from '../../hooks/useDatasources';
import {
  useExecuteQuery,
  useListDatabases,
  useListTables,
  useDescribeTable,
} from "../../hooks/useDbQuery";
import { useDatasource } from "../../hooks/useDatasources";
import { SqlEditor } from "./SqlEditor";
import { RedisEditor } from "./RedisEditor";

export function DbQueryPage() {
  const { datasourceId } = useParams<{ datasourceId: string }>();
  const navigate = useNavigate();
  const { data: datasource } = useDatasource(datasourceId!);
  const [selectedDatabase, setSelectedDatabase] = useState<string>();
  const [selectedTable, setSelectedTable] = useState<string>();
  const [query, setQuery] = useState("");
  const [structureOpen, setStructureOpen] = useState(false);
  const [transferKind, setTransferKind] = useState<'backup' | 'migration' | null>(null);
  const [dataDialog, setDataDialog] = useState<'import' | 'export' | null>(null);
  const [restoreTask, setRestoreTask] = useState<any>(null);
  const [result, setResult] = useState<any>(null);
  const [tableStructures, setTableStructures] = useState<Record<string, any[]>>(
    {},
  );

  const isRelational = datasource?.category === "relational";
  const isRedis = datasource?.type === "redis";
  const isMongo = datasource?.type === "mongodb";
  const hasSchemaBrowser = isRelational || isMongo;

  const { data: databases = [] } = useListDatabases(
    datasourceId,
    !!datasource && hasSchemaBrowser,
  );
  const { data: tables = [] } = useListTables(
    datasourceId,
    selectedDatabase,
    !!selectedDatabase && hasSchemaBrowser,
  );
  const { data: tableStructure } = useDescribeTable(
    datasourceId,
    selectedTable,
    selectedDatabase,
    !!selectedTable && isRelational && structureOpen,
  );
  const executeMut = useExecuteQuery();
  const queryClient = useQueryClient();
  const transfers = useQuery<any[]>({ queryKey: ['database-transfers'], queryFn: async () => (await api.get('/db-query/transfers/mine', { params: { pageSize: 200 } })).data.items, refetchInterval: 3000 });
  const transferAction = useMutation({ mutationFn: ({ id, action, conflictStrategy }: { id: string; action: 'cancel' | 'retry'; conflictStrategy?: string }) => api.post(`/db-query/transfers/${id}/${action}`, { conflictStrategy }), onSuccess: () => queryClient.invalidateQueries({ queryKey: ['database-transfers'] }) });
  const downloadBackup = async (id: string) => { const response = await api.get(`/db-query/transfers/${id}/download`, { responseType: 'blob' }); const disposition = response.headers['content-disposition'] || ''; const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] || 'database-backup'; const url = URL.createObjectURL(response.data); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url); };

  // 缓存表结构用于自动补全
  useEffect(() => {
    if (selectedTable && tableStructure && Array.isArray(tableStructure)) {
      setTableStructures((prev) => ({
        ...prev,
        [selectedTable]: tableStructure,
      }));
    }
  }, [selectedTable, tableStructure]);

  const handleExecute = async () => {
    if (!query.trim()) return;

    // 如果是关系型数据库，必须先选择数据库
    if (isRelational && !selectedDatabase) {
      setResult({ error: "请先选择数据库" });
      return;
    }

    try {
      let payload: any;

      if (isRelational) {
        payload = {
          sql: query,
          database: selectedDatabase, // 传递当前选择的数据库
        };
      } else if (isRedis) {
        // Redis 命令格式: GET key
        const command = query.trim().split(/\s+/);
        payload = { command };
      } else if (isMongo) {
        // MongoDB 查询格式示例: db.collection.find({})
        // 这里简化为 JSON 格式
        payload = JSON.parse(query);
      }

      const data = await executeMut.mutateAsync({
        datasourceId: datasourceId!,
        payload,
      });
      setResult(data);
    } catch (err: any) {
      setResult({
        error: err?.response?.data?.message || err?.message || String(err),
      });
    }
  };

  const handleTableClick = (tableName: string) => {
    setSelectedTable(tableName);
    setStructureOpen(false);
    if (isRelational) {
      // MySQL 使用反引号，PostgreSQL 使用双引号
      const quote = datasource?.type === "mysql" ? "`" : '"';
      setQuery(`SELECT * FROM ${quote}${tableName}${quote} LIMIT 10;`);
    }
  };

  return (
    <div className="h-full min-h-0 p-2 sm:p-4">
      <div className="workspace-frame flex h-full min-h-0 flex-col">
        <header className="panel flex items-center justify-between border-b px-4 py-3 dark:border-slate-800 sm:px-5">
          <div className="flex min-w-0 items-center gap-3">
            <button
              onClick={() =>
                navigate(
                  isRelational
                    ? "/admin/datasources/relational"
                    : "/admin/datasources/nosql",
                )
              }
              className="icon-btn"
              aria-label="返回数据源列表"
            >
              <ArrowLeft size={17} />
            </button>
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg shadow-indigo-500/20">
              <Database size={19} />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="truncate font-semibold text-slate-900 dark:text-white">
                  {datasource?.name || "数据查询"}
                </h1>
                {datasource?.type && (
                  <span className="status-pill hidden sm:inline-flex">
                    {datasource.type.toUpperCase()}
                  </span>
                )}
              </div>
              <p className="truncate text-xs text-muted">
                {isRedis
                  ? "Redis 命令工作台"
                  : isMongo
                    ? "MongoDB 查询工作台"
                    : "SQL 查询工作台"}
                {selectedDatabase && ` · ${selectedDatabase}`}
              </p>
            </div>
          </div>
          {isRelational && <div className="flex flex-wrap items-center justify-end gap-2"><button className="btn btn-secondary btn-sm" disabled={!selectedDatabase || !selectedTable} onClick={() => setDataDialog('import')}><Upload size={14} />导入</button><button className="btn btn-secondary btn-sm" disabled={!selectedDatabase || (!selectedTable && !result)} onClick={() => setDataDialog('export')}><Download size={14} />导出</button><button className="btn btn-secondary btn-sm" disabled={!selectedDatabase || !tables.length} onClick={() => setTransferKind('backup')}><Archive size={14} />备份</button><button className="btn btn-primary btn-sm" disabled={!selectedDatabase || !tables.length} onClick={() => setTransferKind('migration')}><ArrowRightLeft size={14} />迁移</button></div>}
        </header>

        <div className="flex min-h-0 flex-1 overflow-hidden">
          {hasSchemaBrowser && (
            <aside className="panel hidden w-60 shrink-0 overflow-y-auto border-r dark:border-slate-800 md:block">
              <div className="p-3">
                <div className="mb-2 flex items-center justify-between px-1">
                  <h3 className="eyebrow">数据库</h3>
                  <span className="text-[10px] text-muted">
                    {databases.length}
                  </span>
                </div>
                <div className="space-y-1">
                  {databases.map((db) => (
                    <button
                      key={db}
                      onClick={() => {
                        setSelectedDatabase(db);
                        setSelectedTable(undefined);
                      }}
                      className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-xs font-medium transition-all ${
                        selectedDatabase === db
                          ? "bg-indigo-50 text-indigo-700 shadow-sm ring-1 ring-indigo-100 dark:bg-indigo-500/10 dark:text-indigo-300 dark:ring-indigo-500/20"
                          : "text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
                      }`}
                    >
                      <Database size={14} className="shrink-0" />
                      <span className="truncate">{db}</span>
                    </button>
                  ))}
                  {databases.length === 0 && (
                    <p className="px-2 py-4 text-center text-xs text-muted">
                      暂无数据库
                    </p>
                  )}
                </div>
              </div>

              {selectedDatabase && (
                <div className="border-t p-3 dark:border-slate-800">
                  <div className="mb-2 flex items-center justify-between px-1">
                    <h3 className="eyebrow">{isMongo ? "集合" : "数据表"}</h3>
                    <span className="text-[10px] text-muted">
                      {tables.length}
                    </span>
                  </div>
                  <div className="space-y-1">
                    {tables.map((table) => (
                      <button
                        key={table}
                        onClick={() => handleTableClick(table)}
                        className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-xs transition-all ${
                          selectedTable === table
                            ? "bg-violet-50 font-medium text-violet-700 ring-1 ring-violet-100 dark:bg-violet-500/10 dark:text-violet-300 dark:ring-violet-500/20"
                            : "text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
                        }`}
                      >
                        <Table size={14} className="shrink-0" />
                        <span className="truncate">{table}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </aside>
          )}

          <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-slate-50/60 dark:bg-slate-950/30">
            <section className="panel shrink-0 border-b p-4 dark:border-slate-800 sm:p-5">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <label className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                    {isRelational
                      ? "SQL 查询"
                      : isRedis
                        ? "Redis 命令"
                        : "MongoDB 查询"}
                  </label>
                  <p className="mt-0.5 text-[11px] text-muted">
                    {isRedis
                      ? "仅支持只读命令，例如 GET session:user:1"
                      : isMongo
                        ? "使用 JSON 描述只读操作：find、findOne 或 countDocuments"
                        : selectedDatabase
                          ? `当前连接到 ${selectedDatabase}`
                          : "请先从左侧选择数据库"}
                  </p>
                </div>
                <button
                  onClick={handleExecute}
                  disabled={!query.trim() || executeMut.isPending}
                  className="btn btn-primary btn-sm"
                >
                  {executeMut.isPending ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Play size={14} />
                  )}
                  执行查询
                </button>
              </div>
              {isRelational ? (
                <SqlEditor
                  value={query}
                  onChange={setQuery}
                  tables={tables}
                  tableStructures={tableStructures}
                  dialect={datasource?.type as "mysql" | "postgresql"}
                  placeholder="SELECT * FROM table_name LIMIT 10;"
                />
              ) : isRedis ? (
                <RedisEditor
                  value={query}
                  onChange={setQuery}
                  placeholder="GET mykey"
                />
              ) : (
                <textarea
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder='{"database": "test", "collection": "users", "operation": "find", "query": {"filter": {}, "limit": 10}}'
                  className="input min-h-[132px] resize-y font-mono text-sm"
                />
              )}
            </section>

            <section className="min-h-0 flex-1 overflow-auto p-4 sm:p-5">
              {isRelational && selectedTable && (
                <div className="card mb-4 overflow-hidden">
                  <button type="button" onClick={() => setStructureOpen((value) => !value)} className={`flex w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-slate-50 dark:hover:bg-slate-900/50 ${structureOpen ? 'border-b dark:border-slate-800' : ''}`}>
                    <Table size={15} className="text-indigo-500" />
                    <h3 className="text-sm font-semibold">{selectedTable}</h3>
                    <span className="text-xs text-muted">表结构 · 点击{structureOpen ? '收起' : '展开'}</span>
                    <ChevronDown size={15} className={`ml-auto text-slate-400 transition-transform ${structureOpen ? 'rotate-180' : ''}`} />
                  </button>
                  {structureOpen && <div className="overflow-x-auto p-4">
                    {!tableStructure ? <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted"><Loader2 size={14} className="animate-spin" />正在读取表结构…</div> :
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-xs text-muted dark:border-slate-800">
                          <th className="pb-2 text-left font-medium">字段</th>
                          <th className="pb-2 text-left font-medium">类型</th>
                          <th className="pb-2 text-left font-medium">可空</th>
                          <th className="pb-2 text-left font-medium">默认值</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Array.isArray(tableStructure) ? (
                          tableStructure.map((col: any, i: number) => (
                            <tr
                              key={i}
                              className="border-b last:border-0 dark:border-slate-800"
                            >
                              <td className="py-2.5 font-mono text-xs">
                                {col.Field || col.column_name}
                              </td>
                              <td className="py-2.5">
                                {col.Type || col.data_type}
                              </td>
                              <td className="py-2.5">
                                {col.Null || col.is_nullable}
                              </td>
                              <td className="py-2.5 text-muted">
                                {col.Default || col.column_default || "-"}
                              </td>
                            </tr>
                          ))
                        ) : (
                          <tr>
                            <td colSpan={4} className="py-2">
                              <pre className="text-xs">
                                {JSON.stringify(tableStructure, null, 2)}
                              </pre>
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>}
                  </div>}
                </div>
              )}

              {result && (
                <div className="card overflow-hidden">
                  <div className="border-b px-4 py-3 dark:border-slate-800">
                    <h3
                      className={`text-sm font-semibold ${
                        result.error ? "text-red-600 dark:text-red-400" : ""
                      }`}
                    >
                      {result.error ? "查询失败" : "查询结果"}
                    </h3>
                  </div>
                  <div className="p-4">
                    {result.error ? (
                      <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-200">
                        {result.error}
                      </div>
                    ) : isRelational && result.approvalRequired ? (
                      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200"><b>写操作已提交审批</b><p className="mt-1 text-xs">审批单 {result.approvalId}。需要由另一位数据库管理员批准后才会执行。</p></div>
                    ) : isRelational ? (
                      <RelationalResultTable result={result} />
                    ) : Array.isArray(result) && result.length > 0 ? (
                      <pre className="whitespace-pre-wrap break-all rounded-xl bg-slate-950 p-4 text-xs leading-6 text-slate-100">{JSON.stringify(result, null, 2)}</pre>
                    ) : (
                      <pre className="whitespace-pre-wrap break-all rounded-xl bg-slate-950 p-4 text-xs leading-6 text-slate-100">
                        {JSON.stringify(result, null, 2)}
                      </pre>
                    )}
                    {!result.error && !isRelational && (
                      <p className="mt-3 text-xs text-muted">
                        {Array.isArray(result)
                          ? `${result.length} 行`
                          : "非表格结果"}
                      </p>
                    )}
                  </div>
                </div>
              )}

              {!!transfers.data?.length && <div className="card mt-4 overflow-hidden"><div className="border-b px-4 py-3 text-sm font-semibold dark:border-slate-800">备份与迁移任务</div><div className="divide-y dark:divide-slate-800">{transfers.data.slice(0, 10).map((item) => <div key={item.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-xs"><span className="font-semibold">{item.kind === 'backup' ? 'JSONL 逻辑备份' : item.kind === 'native_backup' ? '原生备份' : item.kind === 'native_restore' ? '原生恢复' : '迁移'}</span><span>{item.sourceDatabase}{item.targetDatabase ? ` → ${item.targetDatabase}` : ''}</span><span className="rounded-full bg-slate-100 px-2 py-0.5 dark:bg-slate-800">{transferStatus(item.status)}</span><span className="text-muted">表 {item.completedTables}/{item.totalTables}</span>{!['native_backup', 'native_restore'].includes(item.kind) && <span className="text-muted">行 {item.migratedRows}</span>}{item.currentTable && <span className="font-mono text-muted">{item.currentTable}</span>}{item.kind === 'migration' && <span className="text-muted">策略 {item.conflictStrategy}</span>}<span className="ml-auto flex gap-2">{item.kind === 'native_backup' && item.status === 'succeeded' && <><button className="text-emerald-600" onClick={() => void downloadBackup(item.id)}>下载</button><button className="text-amber-600" onClick={() => setRestoreTask(item)}>恢复</button></>}{['pending_approval', 'queued', 'running'].includes(item.status) && <button className="text-red-500" onClick={() => transferAction.mutate({ id: item.id, action: 'cancel' })}>取消</button>}{['failed', 'cancelled'].includes(item.status) && <button className="text-indigo-500" onClick={() => transferAction.mutate({ id: item.id, action: 'retry', conflictStrategy: item.kind === 'migration' && item.migratedRows > 0 ? 'replace' : item.conflictStrategy })}>重试</button>}</span>{item.error && <span className="w-full text-red-500">{item.error}</span>}</div>)}</div></div>}

              {!result && !(isRelational && selectedTable) && (
                <div className="flex min-h-[220px] items-center justify-center text-muted">
                  <div className="text-center">
                    <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-indigo-50 text-indigo-500 dark:bg-indigo-500/10 dark:text-indigo-300">
                      <Database size={25} />
                    </div>
                    <p className="text-sm font-medium text-slate-600 dark:text-slate-300">
                      {isRedis
                        ? "输入 Redis 命令开始查询"
                        : "输入查询或选择数据表开始"}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      {isRedis
                        ? "结果会直接显示在这里，无需选择数据库表结构"
                        : "执行结果会显示在这里"}
                    </p>
                  </div>
                </div>
              )}
            </section>
          </main>
        </div>
      </div>
      {transferKind && datasource && selectedDatabase && <TransferDialog kind={transferKind} sourceDatasourceId={datasource.id} sourceDatabase={selectedDatabase} availableTables={tables} onClose={() => setTransferKind(null)} />}
      {dataDialog && datasourceId && selectedDatabase && <DataFileDialog mode={dataDialog} datasourceId={datasourceId} database={selectedDatabase} table={selectedTable} sql={query} hasQueryResult={!!result && !result.error && !result.approvalRequired} onClose={() => setDataDialog(null)} />}
      {restoreTask && <RestoreDialog task={restoreTask} onClose={() => setRestoreTask(null)} />}
    </div>
  );
}

function RestoreDialog({ task, onClose }: { task: any; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: datasources = [] } = useDatasources('relational');
  const [targetDatasourceId, setTargetDatasourceId] = useState('');
  const [targetDatabase, setTargetDatabase] = useState('');
  const { data: databases = [] } = useListDatabases(targetDatasourceId, !!targetDatasourceId);
  const restore = useMutation({ mutationFn: async () => (await api.post(`/db-query/transfers/${task.id}/restore`, { targetDatasourceId, targetDatabase })).data, onSuccess: () => { qc.invalidateQueries({ queryKey: ['database-transfers'] }); onClose(); } });
  return <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/55 p-4 backdrop-blur-sm"><div className="card w-full max-w-lg p-5"><div className="flex items-start justify-between"><div><div className="eyebrow">Native Restore</div><h2 className="mt-1 text-lg font-bold">从原生备份恢复</h2><p className="mt-1 text-xs text-muted">备份来源：{task.sourceDatabase}</p></div><button className="icon-btn" onClick={onClose}><X size={16} /></button></div><div className="mt-5 grid gap-4 sm:grid-cols-2"><label className="text-xs font-semibold">目标数据源<select className="input mt-1 w-full" value={targetDatasourceId} onChange={(event) => { setTargetDatasourceId(event.target.value); setTargetDatabase(''); }}><option value="">请选择同类型数据源</option>{datasources.filter((item) => item.type === task.sourceDatasource.type).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="text-xs font-semibold">目标空数据库<select className="input mt-1 w-full" value={targetDatabase} onChange={(event) => setTargetDatabase(event.target.value)}><option value="">请选择</option>{databases.map((database) => <option key={database} value={database}>{database}</option>)}</select></label></div><div className="mt-5 rounded-xl bg-red-50 p-3 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">恢复前会重新验证 SHA-256，并再次确认目标数据库为空。任务必须由另一位管理员审批；审批后若目标库出现表，执行会自动终止。</div>{restore.error && <p className="mt-3 text-xs text-red-500">{(restore.error as any)?.response?.data?.message || (restore.error as Error).message}</p>}<div className="mt-5 flex justify-end gap-2"><button className="btn btn-secondary" onClick={onClose}>取消</button><button className="btn btn-primary" disabled={!targetDatasourceId || !targetDatabase || restore.isPending} onClick={() => restore.mutate()}>{restore.isPending && <Loader2 size={14} className="animate-spin" />}提交恢复审批</button></div></div></div>;
}

function DataFileDialog({ mode, datasourceId, database, table, sql, hasQueryResult, onClose }: { mode: 'import' | 'export'; datasourceId: string; database: string; table?: string; sql: string; hasQueryResult: boolean; onClose: () => void }) {
  const [file, setFile] = useState<File>();
  const [format, setFormat] = useState<'csv' | 'xlsx'>('xlsx');
  const [scope, setScope] = useState<'table' | 'query'>(hasQueryResult ? 'query' : 'table');
  const [message, setMessage] = useState('');
  const action = useMutation({ mutationFn: async () => {
    if (mode === 'import') {
      if (!file || !table) throw new Error('请选择文件和目标表');
      const form = new FormData(); form.append('database', database); form.append('table', table); form.append('file', file);
      return (await api.post(`/db-query/${datasourceId}/import`, form)).data;
    }
    const response = await api.post(`/db-query/${datasourceId}/export`, { database, table, sql, scope, format }, { responseType: 'blob' });
    const disposition = response.headers['content-disposition'] || '';
    const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] || `database-export.${format}`;
    const url = URL.createObjectURL(response.data); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url);
    return { downloaded: true };
  }, onSuccess: (data) => { if (mode === 'import') setMessage(`已提交审批：${data.rows} 行，审批单 ${data.approvalId}`); else onClose(); } });
  return <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/55 p-4 backdrop-blur-sm"><div className="card w-full max-w-lg p-5"><div className="flex items-start justify-between"><div><div className="eyebrow">Data Exchange</div><h2 className="mt-1 text-lg font-bold">{mode === 'import' ? '导入 CSV / Excel' : '导出数据文件'}</h2><p className="mt-1 text-xs text-muted">{database}{table ? ` · ${table}` : ''}</p></div><button className="icon-btn" onClick={onClose}><X size={16} /></button></div>
    {mode === 'import' ? <div className="mt-5"><label className="text-xs font-semibold">上传文件<input className="input mt-2 block w-full" type="file" accept=".csv,.xlsx" onChange={(event) => setFile(event.target.files?.[0])} /></label><p className="mt-2 text-xs text-muted">支持 CSV 和 Excel (.xlsx)，首行为字段名，最多 10MB / 5000 行。导入属于 INSERT 写操作，提交后由另一位管理员审批。</p></div> : <div className="mt-5 space-y-4"><label className="block text-xs font-semibold">导出范围<select className="input mt-1 w-full" value={scope} onChange={(event) => setScope(event.target.value as any)}><option value="table" disabled={!table}>当前表全部数据</option><option value="query" disabled={!hasQueryResult}>当前只读查询数据</option></select></label><label className="block text-xs font-semibold">文件格式<select className="input mt-1 w-full" value={format} onChange={(event) => setFormat(event.target.value as any)}><option value="xlsx">Excel (.xlsx)</option><option value="csv">CSV (.csv)</option></select></label><p className="text-xs text-muted">整表导出最多 100000 行；更大数据量请添加查询条件后分批导出。</p></div>}
    {message && <div className="mt-4 rounded-xl bg-emerald-50 p-3 text-xs text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">{message}</div>}{action.error && <div className="mt-4 text-xs text-red-500">{(action.error as any)?.response?.data?.message || (action.error as Error).message}</div>}<div className="mt-5 flex justify-end gap-2"><button className="btn btn-secondary" onClick={onClose}>关闭</button><button className="btn btn-primary" disabled={action.isPending || (mode === 'import' && (!file || !table))} onClick={() => action.mutate()}>{action.isPending && <Loader2 size={14} className="animate-spin" />}{mode === 'import' ? '提交导入审批' : '下载文件'}</button></div>
  </div></div>;
}

function TransferDialog({ kind, sourceDatasourceId, sourceDatabase, availableTables, onClose }: { kind: 'backup' | 'migration'; sourceDatasourceId: string; sourceDatabase: string; availableTables: string[]; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: datasources = [] } = useDatasources('relational');
  const [targetDatasourceId, setTargetDatasourceId] = useState('');
  const [targetDatabase, setTargetDatabase] = useState('');
  const [selected, setSelected] = useState<string[]>(availableTables);
  const [conflictStrategy, setConflictStrategy] = useState<'fail' | 'append' | 'replace'>('fail');
  const [backupFormat, setBackupFormat] = useState<'native_backup' | 'backup'>('native_backup');
  const { data: targetDatabases = [] } = useListDatabases(targetDatasourceId, kind === 'migration' && !!targetDatasourceId);
  const create = useMutation({ mutationFn: async () => (await api.post('/db-query/transfers', { kind: kind === 'backup' ? backupFormat : kind, sourceDatasourceId, sourceDatabase, targetDatasourceId: kind === 'migration' ? targetDatasourceId : undefined, targetDatabase: kind === 'migration' ? targetDatabase : undefined, tables: selected, conflictStrategy })).data, onSuccess: () => { qc.invalidateQueries({ queryKey: ['database-transfers'] }); onClose(); } });
  return <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/55 p-4 backdrop-blur-sm"><div className="card max-h-[85vh] w-full max-w-2xl overflow-auto p-5"><div className="flex items-start justify-between"><div><div className="eyebrow">Database Transfer</div><h2 className="mt-1 text-lg font-bold">{kind === 'backup' ? '创建数据库备份' : '迁移到其他数据源'}</h2><p className="mt-1 text-xs text-muted">来源：{sourceDatabase}</p></div><button className="icon-btn" onClick={onClose}><X size={16} /></button></div>
    {kind === 'migration' && <div className="mt-5 grid gap-4 sm:grid-cols-3"><label className="text-xs font-semibold">目标数据源<select className="input mt-1 w-full" value={targetDatasourceId} onChange={(event) => { setTargetDatasourceId(event.target.value); setTargetDatabase(''); }}><option value="">请选择</option>{datasources.filter((item) => item.id !== sourceDatasourceId).map((item) => <option key={item.id} value={item.id}>{item.name} ({item.type})</option>)}</select></label><label className="text-xs font-semibold">目标数据库<select className="input mt-1 w-full" value={targetDatabase} onChange={(event) => setTargetDatabase(event.target.value)}><option value="">请选择</option>{targetDatabases.map((database) => <option key={database} value={database}>{database}</option>)}</select></label><label className="text-xs font-semibold">目标表冲突<select className="input mt-1 w-full" value={conflictStrategy} onChange={(event) => setConflictStrategy(event.target.value as any)}><option value="fail">存在则失败</option><option value="append">追加数据</option><option value="replace">删除并重建</option></select></label></div>}
    {kind === 'backup' && <label className="mt-5 block text-xs font-semibold">备份格式<select className="input mt-1 w-full" value={backupFormat} onChange={(event) => setBackupFormat(event.target.value as any)}><option value="native_backup">原生格式（推荐，可用于恢复）</option><option value="backup">JSONL 逻辑格式（跨库交换）</option></select></label>}
    <div className="mt-5"><div className="mb-2 flex items-center justify-between"><b className="text-sm">选择表</b><button className="text-xs text-indigo-500" onClick={() => setSelected(selected.length === availableTables.length ? [] : availableTables)}>{selected.length === availableTables.length ? '取消全选' : '全选'}</button></div><div className="grid max-h-64 gap-2 overflow-auto rounded-xl border p-3 dark:border-slate-800 sm:grid-cols-2">{availableTables.map((table) => <label key={table} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-slate-50 dark:hover:bg-slate-900"><input type="checkbox" checked={selected.includes(table)} onChange={() => setSelected((value) => value.includes(table) ? value.filter((item) => item !== table) : [...value, table])} /><span className="font-mono">{table}</span></label>)}</div></div>
    <div className="mt-5 rounded-xl bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">{kind === 'migration' ? '迁移会在目标库创建表并写入数据，提交后必须由另一位管理员审批。MySQL 与 PostgreSQL 可互相迁移。' : backupFormat === 'native_backup' ? 'PostgreSQL 生成 pg_dump custom 文件；MySQL 生成包含结构和数据的原生 SQL dump，并附带 SHA-256 manifest。' : 'JSONL 是平台逻辑备份，适合选表归档和跨类型数据交换，不能直接使用数据库原生工具恢复。'}</div>
    {create.error && <p className="mt-3 text-xs text-red-500">{(create.error as any)?.response?.data?.message || (create.error as Error).message}</p>}<div className="mt-5 flex justify-end gap-2"><button className="btn btn-secondary" onClick={onClose}>取消</button><button className="btn btn-primary" disabled={!selected.length || (kind === 'migration' && (!targetDatasourceId || !targetDatabase)) || create.isPending} onClick={() => create.mutate()}>{create.isPending && <Loader2 size={14} className="animate-spin" />}提交{kind === 'migration' ? '迁移审批' : '备份任务'}</button></div>
  </div></div>;
}

function transferStatus(status: string) { return ({ pending_approval: '待审批', queued: '排队中', running: '执行中', succeeded: '已完成', failed: '失败', rejected: '已拒绝', cancelled: '已取消' } as Record<string, string>)[status] || status; }

function RelationalResultTable({ result }: { result: unknown }) {
  const rows = normalizeRelationalRows(result);
  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));

  if (!rows.length) {
    return <div className="grid min-h-32 place-items-center rounded-xl border border-dashed border-slate-200 bg-slate-50/70 text-center dark:border-slate-800 dark:bg-slate-900/30"><div><Table size={22} className="mx-auto mb-2 text-slate-400" /><p className="text-sm font-medium">查询成功，没有返回数据行</p><p className="mt-1 text-xs text-muted">0 行</p></div></div>;
  }

  return <div>
    <div className="max-h-[440px] overflow-auto rounded-xl border border-slate-200 dark:border-slate-800">
      <table className="min-w-full border-separate border-spacing-0 text-left text-xs">
        <thead className="sticky top-0 z-10 bg-slate-100/95 text-slate-600 backdrop-blur dark:bg-slate-900/95 dark:text-slate-300">
          <tr>
            <th className="sticky left-0 z-20 w-12 border-b border-r border-slate-200 bg-slate-100/95 px-3 py-2.5 text-center font-semibold dark:border-slate-800 dark:bg-slate-900/95">#</th>
            {columns.map((column) => <th key={column} className="whitespace-nowrap border-b border-r border-slate-200 px-3 py-2.5 font-semibold last:border-r-0 dark:border-slate-800"><span className="font-mono">{column}</span></th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => <tr key={rowIndex} className="bg-white transition-colors hover:bg-indigo-50/50 dark:bg-slate-950/40 dark:hover:bg-indigo-500/5">
            <td className="sticky left-0 border-b border-r border-slate-100 bg-slate-50 px-3 py-2.5 text-center tabular-nums text-slate-400 dark:border-slate-800 dark:bg-slate-900">{rowIndex + 1}</td>
            {columns.map((column) => <td key={column} className="max-w-[360px] border-b border-r border-slate-100 px-3 py-2.5 align-top last:border-r-0 dark:border-slate-800"><DatabaseCell value={row[column]} /></td>)}
          </tr>)}
        </tbody>
      </table>
    </div>
    <div className="mt-3 flex items-center justify-between text-xs text-muted"><span>{rows.length} 行</span><span>{columns.length} 列</span></div>
  </div>;
}

function DatabaseCell({ value }: { value: unknown }) {
  if (value === null) return <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] italic text-slate-400 dark:bg-slate-800">NULL</span>;
  if (value === undefined) return <span className="text-slate-300">—</span>;
  if (typeof value === 'boolean') return <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${value ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' : 'bg-slate-100 text-slate-500 dark:bg-slate-800'}`}>{String(value)}</span>;
  if (typeof value === 'object') return <span className="block max-w-[340px] overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[11px]" title={JSON.stringify(value, null, 2)}>{JSON.stringify(value)}</span>;
  const text = String(value);
  return <span className="block max-w-[340px] overflow-hidden text-ellipsis whitespace-nowrap" title={text}>{text}</span>;
}

function normalizeRelationalRows(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result.map((row) => isRecord(row) ? row : { value: row });
  if (isRecord(result)) return [result];
  return result == null ? [] : [{ value: result }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
