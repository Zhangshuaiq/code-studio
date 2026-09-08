import { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  GitCommitHorizontal,
  KeyRound,
  Link2,
  FolderDown,
  ShieldCheck,
  Upload,
  X,
} from 'lucide-react';
import {
  useGitSettings,
  useGitSettingsMutations,
  usePush,
  useRemote,
  useSaveRemote,
  useRemoteSyncOps,
} from '../../hooks/useGit';

// 项目仓库配置与个人 Git 身份分层展示；PAT 永远只属于当前登录用户。
export function GitRemoteModal({
  sessionId,
  onClose,
}: {
  sessionId?: string;
  onClose: () => void;
}) {
  const remote = useRemote(sessionId);
  const settings = useGitSettings();
  const saveRemote = useSaveRemote(sessionId);
  const { saveIdentity, saveCredential } = useGitSettingsMutations();
  const push = usePush(sessionId);
  const { importRemote } = useRemoteSyncOps(sessionId);

  const [remoteUrl, setRemoteUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [authorName, setAuthorName] = useState('');
  const [authorEmail, setAuthorEmail] = useState('');
  const [username, setUsername] = useState('');
  const [token, setToken] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    if (remote.data) {
      setRemoteUrl(remote.data.remoteUrl);
      setBranch(remote.data.branch || 'main');
    }
  }, [remote.data]);

  useEffect(() => {
    if (settings.data) {
      setAuthorName(settings.data.identity.authorName);
      setAuthorEmail(settings.data.identity.authorEmail);
    }
  }, [settings.data]);

  const host = useMemo(() => repositoryHost(remoteUrl), [remoteUrl]);
  const credential = settings.data?.credentials.find((item) => item.host === host);

  useEffect(() => {
    setUsername(credential?.username ?? '');
    setToken('');
  }, [credential?.id, credential?.username, host]);

  async function saveAll(requireCredential: boolean) {
    if (!remoteUrl.trim()) throw new Error('请填写仓库地址');
    if (!authorName.trim() || !authorEmail.trim()) {
      throw new Error('请填写当前用户的 Git 姓名和邮箱');
    }
    if (!host) throw new Error('仓库地址格式不正确，请使用 HTTPS 地址');
    if (requireCredential && !credential && !token.trim()) {
      throw new Error(`请填写当前用户在 ${host} 的 Access Token`);
    }

    const normalizedBranch = branch.trim() || 'main';
    const remoteChanged =
      !remote.data ||
      remote.data.remoteUrl !== remoteUrl.trim() ||
      remote.data.branch !== normalizedBranch;
    if (remoteChanged && remote.data && !remote.data.canManageRepository) {
      throw new Error('当前项目角色不能修改共享仓库地址或默认分支');
    }
    if (remoteChanged) {
      await saveRemote.mutateAsync({
        remoteUrl: remoteUrl.trim(),
        branch: normalizedBranch,
      });
    }
    await saveIdentity.mutateAsync({
      authorName: authorName.trim(),
      authorEmail: authorEmail.trim(),
    });
    if (token.trim() || credential) {
      await saveCredential.mutateAsync({
        host,
        username: username.trim() || undefined,
        token: token.trim() || undefined,
      });
      setToken('');
    }
  }

  async function doSave() {
    setErr('');
    setMsg('');
    try {
      await saveAll(false);
      setMsg('项目仓库和个人 Git 身份已保存');
    } catch (error) {
      setErr(errorText(error));
    }
  }

  async function doPush() {
    setErr('');
    setMsg('');
    try {
      await saveAll(true);
      const result = await push.mutateAsync();
      setMsg(`已使用 ${authorName.trim()} 的身份推送到 ${result.branch} 分支`);
    } catch (error) {
      setErr(errorText(error));
    }
  }

  async function doImport() {
    setErr('');
    setMsg('');
    try {
      await saveAll(true);
      const result = await importRemote.mutateAsync();
      setMsg(`已从远端 ${result.remoteBranch} 导入项目代码`);
    } catch (error) {
      setErr(errorText(error));
    }
  }

  const pending =
    saveRemote.isPending ||
    saveIdentity.isPending ||
    saveCredential.isPending ||
    push.isPending ||
    importRemote.isPending;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="card animate-fade-in max-h-[92vh] w-full max-w-2xl overflow-y-auto p-0"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200/80 bg-white/95 px-6 py-5 backdrop-blur dark:border-slate-800 dark:bg-slate-900/95">
          <div>
            <div className="eyebrow">Repository delivery</div>
            <h2 className="mt-1 flex items-center gap-2 text-lg font-bold">
              <Upload size={19} className="text-indigo-500" /> 连接并推送代码仓库
            </h2>
          </div>
          <button onClick={onClose} className="icon-btn" title="关闭">
            <X size={17} />
          </button>
        </div>

        <div className="space-y-5 p-6">
          <section className="rounded-2xl border border-slate-200/80 bg-slate-50/60 p-4 dark:border-slate-800 dark:bg-slate-950/30">
            <div className="mb-4 flex items-start gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-indigo-100 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300">
                <Link2 size={17} />
              </span>
              <div>
                <h3 className="text-sm font-bold">项目仓库</h3>
                <p className="mt-0.5 text-xs leading-5 text-muted">
                  仓库地址和默认分支属于当前项目，项目成员看到的是同一份配置。
                </p>
              </div>
            </div>
            <label className="label mb-1.5">仓库地址（HTTPS）</label>
            <input
              value={remoteUrl}
              onChange={(event) => setRemoteUrl(event.target.value)}
              placeholder="https://github.com/team/repository.git"
              className="input"
              disabled={!!remote.data && !remote.data.canManageRepository}
            />
            <div className="mt-3 w-full sm:w-1/2">
              <label className="label mb-1.5">默认分支</label>
              <input
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                placeholder="main"
                className="input"
                disabled={!!remote.data && !remote.data.canManageRepository}
              />
            </div>
          </section>

          <section className="rounded-2xl border border-indigo-200/70 bg-indigo-50/45 p-4 dark:border-indigo-500/20 dark:bg-indigo-500/5">
            <div className="mb-4 flex items-start gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white text-indigo-600 shadow-sm dark:bg-slate-900 dark:text-indigo-300">
                <GitCommitHorizontal size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-bold">我的提交身份</h3>
                  <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-semibold text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
                    仅当前账户
                  </span>
                </div>
                <p className="mt-0.5 text-xs leading-5 text-muted">
                  每次生成、在线编辑、回滚和推送前的提交都会写入下面这位当前用户，不会使用平台公共身份。
                </p>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label mb-1.5">Git 姓名</label>
                <input
                  value={authorName}
                  onChange={(event) => setAuthorName(event.target.value)}
                  placeholder="例如 Zhang San"
                  className="input"
                />
              </div>
              <div>
                <label className="label mb-1.5">Git 邮箱</label>
                <input
                  type="email"
                  value={authorEmail}
                  onChange={(event) => setAuthorEmail(event.target.value)}
                  placeholder="name@company.com"
                  className="input"
                />
              </div>
            </div>
          </section>

          <section className="rounded-2xl border border-slate-200/80 p-4 dark:border-slate-800">
            <div className="mb-4 flex items-start gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300">
                <KeyRound size={17} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-bold">我的推送凭据</h3>
                  {credential && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                      <CheckCircle2 size={12} /> {host} 已配置
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-xs leading-5 text-muted">
                  PAT 按 Git 主机保存并加密，仅你本人推送时使用，其他项目成员无法读取或复用。
                </p>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label mb-1.5">Git 主机</label>
                <div className="input flex items-center text-sm text-slate-500">
                  {host || '由仓库地址自动识别'}
                </div>
              </div>
              <div>
                <label className="label mb-1.5">用户名（部分平台需要）</label>
                <input
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder="可选"
                  className="input"
                />
              </div>
            </div>
            <label className="label mb-1.5 mt-3">Access Token（PAT）</label>
            <input
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder={credential ? '已加密保存；留空表示不修改' : '输入当前用户自己的 Token'}
              className="input"
              autoComplete="new-password"
            />
            <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted">
              <ShieldCheck size={13} className="text-emerald-500" /> Token 不会写入项目目录、Git remote 或接口响应。
            </p>
          </section>

          {err && (
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-xl bg-red-50 px-3 py-2.5 text-xs text-red-600 dark:bg-red-500/10 dark:text-red-400">
              {err}
            </pre>
          )}
          {msg && (
            <p className="rounded-xl bg-emerald-50 px-3 py-2.5 text-xs text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400">
              {msg}
            </p>
          )}
        </div>

        <div className="sticky bottom-0 flex justify-end gap-2 border-t border-slate-200/80 bg-white/95 px-6 py-4 backdrop-blur dark:border-slate-800 dark:bg-slate-900/95">
          {(!remote.data || remote.data.canImportRepository) && <button
            onClick={doImport}
            disabled={pending || !remoteUrl.trim()}
            className="btn btn-ghost mr-auto inline-flex items-center gap-1.5"
            title="仅空白项目可导入；已有代码请使用顶部的分支菜单同步"
          >
            <FolderDown size={15} />
            {importRemote.isPending ? '导入中…' : '导入远端代码'}
          </button>}
          <button onClick={doSave} disabled={pending} className="btn btn-ghost">
            {pending && !push.isPending ? '保存中…' : '保存配置'}
          </button>
          <button
            onClick={doPush}
            disabled={pending || !remoteUrl.trim()}
            className="btn btn-primary inline-flex items-center gap-1.5"
          >
            {push.isPending ? '推送中…' : <><Upload size={15} /> 保存并推送</>}
          </button>
        </div>
      </div>
    </div>
  );
}

function repositoryHost(value: string): string {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' ? url.host.toLowerCase() : '';
  } catch {
    return '';
  }
}

function errorText(error: unknown): string {
  const value = error as { response?: { data?: { message?: string | string[] } }; message?: string };
  const message = value.response?.data?.message ?? value.message ?? String(error);
  return Array.isArray(message) ? message.join('；') : message;
}
