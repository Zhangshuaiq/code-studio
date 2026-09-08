import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  GitCommitHorizontal,
  KeyRound,
  LogOut,
  Plus,
  Save,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { useAuth } from '../../store/auth';
import {
  GitCredentialSummary,
  useGitSettings,
  useGitSettingsMutations,
} from '../../hooks/useGit';
import { useFeedback } from '../common/FeedbackProvider';
import { Card, PageHeader, errText } from './ui';

export function AccountPage() {
  const username = useAuth((state) => state.username);
  const logout = useAuth((state) => state.logout);
  const settings = useGitSettings();
  const { saveIdentity, saveCredential, removeCredential } =
    useGitSettingsMutations();
  const { toast, confirm: askConfirm } = useFeedback();
  const [authorName, setAuthorName] = useState('');
  const [authorEmail, setAuthorEmail] = useState('');
  const [editing, setEditing] = useState<GitCredentialSummary | null>(null);
  const [showCredentialForm, setShowCredentialForm] = useState(false);
  const [host, setHost] = useState('');
  const [gitUsername, setGitUsername] = useState('');
  const [token, setToken] = useState('');

  useEffect(() => {
    if (!settings.data) return;
    setAuthorName(settings.data.identity.authorName);
    setAuthorEmail(settings.data.identity.authorEmail);
  }, [settings.data]);

  function openCredential(item?: GitCredentialSummary) {
    setEditing(item ?? null);
    setHost(item?.host ?? '');
    setGitUsername(item?.username ?? '');
    setToken('');
    setShowCredentialForm(true);
  }

  async function submitIdentity() {
    try {
      await saveIdentity.mutateAsync({ authorName, authorEmail });
      toast('之后的 Git 提交会使用这份个人身份。', {
        title: 'Git 身份已保存',
        tone: 'success',
      });
    } catch (error) {
      toast(errText(error), { title: '保存失败', tone: 'error' });
    }
  }

  async function submitCredential() {
    try {
      await saveCredential.mutateAsync({
        host: host.trim(),
        username: gitUsername.trim() || undefined,
        token: token.trim() || undefined,
      });
      setShowCredentialForm(false);
      toast('凭据已加密保存，仅当前账户推送时使用。', {
        title: `${host.trim()} 已配置`,
        tone: 'success',
      });
    } catch (error) {
      toast(errText(error), { title: '保存失败', tone: 'error' });
    }
  }

  return (
    <div>
      <PageHeader
        title="账户与 Git"
        desc="管理登录状态、个人提交身份，以及你在各 Git 服务上的独立推送凭据。"
      />

      <div className="space-y-5">
        <Card>
          <div className="flex items-center gap-4">
            <span className="grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-lg font-semibold text-white shadow-lg shadow-indigo-500/20">
              {(username ?? '?').slice(0, 1).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-bold">{username ?? '未知用户'}</div>
              <div className="mt-0.5 inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 size={12} /> 当前已登录
              </div>
            </div>
            <button
              onClick={logout}
              className="btn btn-ghost btn-sm inline-flex items-center gap-1.5 text-red-500"
            >
              <LogOut size={15} /> 退出登录
            </button>
          </div>
        </Card>

        <Card>
          <div className="mb-5 flex items-start gap-3 border-b border-slate-200/70 pb-4 dark:border-slate-800">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-indigo-100 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300">
              <GitCommitHorizontal size={19} />
            </span>
            <div>
              <h2 className="text-sm font-bold">个人 Git 提交身份</h2>
              <p className="mt-1 text-xs leading-5 text-muted">
                平台在每次提交时显式写入这份 author/committer，不使用服务器公共 Git 用户。若尚未设置，系统会使用你的平台用户名和独立占位邮箱。
              </p>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
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
          <div className="mt-4 flex items-center justify-between gap-3">
            <p className="text-[11px] text-muted">
              建议使用 GitHub/GitLab 账户已验证邮箱，提交才能正确关联头像和贡献记录。
            </p>
            <button
              onClick={submitIdentity}
              disabled={saveIdentity.isPending || !authorName.trim() || !authorEmail.trim()}
              className="btn btn-primary btn-sm shrink-0"
            >
              <Save size={14} /> {saveIdentity.isPending ? '保存中…' : '保存身份'}
            </button>
          </div>
        </Card>

        <Card>
          <div className="mb-5 flex items-start justify-between gap-4 border-b border-slate-200/70 pb-4 dark:border-slate-800">
            <div className="flex items-start gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300">
                <KeyRound size={18} />
              </span>
              <div>
                <h2 className="text-sm font-bold">个人推送凭据</h2>
                <p className="mt-1 text-xs leading-5 text-muted">
                  每个 Git 主机保存一份 PAT。项目只引用仓库地址，其他成员无法读取或使用你的 Token。
                </p>
              </div>
            </div>
            <button onClick={() => openCredential()} className="btn btn-primary btn-sm shrink-0">
              <Plus size={14} /> 添加凭据
            </button>
          </div>

          {settings.isLoading ? (
            <div className="surface-soft h-20 animate-pulse" />
          ) : !settings.data?.credentials.length ? (
            <button
              onClick={() => openCredential()}
              className="surface-soft w-full border-dashed px-4 py-9 text-center text-sm text-muted transition hover:border-indigo-300 hover:text-indigo-600 dark:hover:border-indigo-500/40"
            >
              尚未配置推送凭据，点击添加 GitHub、GitLab、Gitee 或企业 Git 服务
            </button>
          ) : (
            <div className="space-y-2.5">
              {settings.data.credentials.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center gap-3 rounded-2xl border border-slate-200/80 bg-slate-50/60 p-4 dark:border-slate-800 dark:bg-slate-950/30"
                >
                  <span className="grid h-9 w-9 place-items-center rounded-xl bg-white text-slate-600 shadow-sm dark:bg-slate-900 dark:text-slate-300">
                    <ShieldCheck size={17} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-bold">{item.host}</div>
                    <div className="mt-0.5 text-[11px] text-muted">
                      {item.username ? `用户 ${item.username} · ` : ''}Token 已加密保存
                    </div>
                  </div>
                  <button onClick={() => openCredential(item)} className="btn btn-ghost btn-sm">
                    修改
                  </button>
                  <button
                    onClick={async () => {
                      if (
                        await askConfirm({
                          title: '删除 Git 凭据',
                          message: `删除后，你将无法向 ${item.host} 的项目仓库推送，确定继续？`,
                          confirmText: '删除凭据',
                          tone: 'danger',
                        })
                      ) {
                        removeCredential.mutate(item.id);
                      }
                    }}
                    className="icon-btn text-red-500"
                    title="删除凭据"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {showCredentialForm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
          onClick={() => setShowCredentialForm(false)}
        >
          <div className="card w-full max-w-lg p-6" onClick={(event) => event.stopPropagation()}>
            <div className="mb-5">
              <div className="eyebrow">Personal credential</div>
              <h2 className="mt-1 text-lg font-bold">{editing ? '修改' : '添加'} Git 推送凭据</h2>
            </div>
            <div className="space-y-4">
              <div>
                <label className="label mb-1.5">Git 服务主机</label>
                <input
                  value={host}
                  onChange={(event) => setHost(event.target.value)}
                  placeholder="github.com 或 git.company.com"
                  disabled={!!editing}
                  className="input"
                />
              </div>
              <div>
                <label className="label mb-1.5">用户名（可选）</label>
                <input
                  value={gitUsername}
                  onChange={(event) => setGitUsername(event.target.value)}
                  placeholder="部分 Git 服务要求填写"
                  className="input"
                />
              </div>
              <div>
                <label className="label mb-1.5">Access Token（PAT）</label>
                <input
                  type="password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  placeholder={editing ? '已保存；留空表示不修改' : '输入当前用户自己的 Token'}
                  autoComplete="new-password"
                  className="input"
                />
              </div>
              <p className="flex items-center gap-1.5 text-[11px] leading-5 text-muted">
                <ShieldCheck size={13} className="text-emerald-500" /> 凭据使用 AES-256-GCM 加密，接口不会回显明文。
              </p>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button onClick={() => setShowCredentialForm(false)} className="btn btn-ghost">
                取消
              </button>
              <button
                onClick={submitCredential}
                disabled={saveCredential.isPending || !host.trim() || (!editing && !token.trim())}
                className="btn btn-primary"
              >
                {saveCredential.isPending ? '保存中…' : '保存凭据'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
