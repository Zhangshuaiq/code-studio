import { useState, FormEvent, useEffect } from "react";
import {
  ArrowRight,
  Boxes,
  Code2,
  GitBranch,
  Rocket,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../store/auth";
import { ThemeToggle } from "../ThemeToggle";

export function LoginForm() {
  const setAuth = useAuth((s) => s.setAuth);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [registration, setRegistration] = useState({
    enabled: true,
    setupRequired: false,
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get("/auth/registration-status")
      .then(({ data }) => {
        setRegistration(data);
        if (!data.enabled) setMode("login");
      })
      .catch(() => setRegistration({ enabled: false, setupRequired: false }));
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const { data } = await api.post(`/auth/${mode}`, {
        username,
        password,
        ...(mode === "register" && setupToken ? { setupToken } : {}),
      });
      setAuth(data.accessToken, data.user.username);
    } catch (err: any) {
      setError(err.response?.data?.message ?? "请求失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative grid h-full overflow-hidden lg:grid-cols-[1.08fr_0.92fr]">
      <div className="pointer-events-none absolute -left-32 -top-32 h-[520px] w-[520px] rounded-full bg-indigo-500/15 blur-[110px]" />
      <div className="pointer-events-none absolute -bottom-40 right-1/4 h-[460px] w-[460px] rounded-full bg-violet-500/10 blur-[110px]" />
      <div className="absolute right-5 top-5 z-20">
        <ThemeToggle />
      </div>

      <section className="relative hidden overflow-hidden p-10 lg:flex lg:flex-col lg:justify-between xl:p-14">
        <div className="absolute inset-3 overflow-hidden rounded-[32px] bg-gradient-to-br from-slate-950 via-indigo-950 to-violet-950 shadow-2xl">
          <div className="absolute -right-24 -top-24 h-80 w-80 rounded-full bg-indigo-500/25 blur-3xl" />
          <div className="absolute -bottom-36 -left-20 h-96 w-96 rounded-full bg-violet-500/20 blur-3xl" />
          <div
            className="absolute inset-0 opacity-[0.08]"
            style={{
              backgroundImage:
                "linear-gradient(rgba(255,255,255,.35) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.35) 1px, transparent 1px)",
              backgroundSize: "34px 34px",
            }}
          />
        </div>

        <div className="relative z-10 flex items-center gap-3 text-white">
          <span className="grid h-11 w-11 place-items-center rounded-2xl bg-white/10 ring-1 ring-white/20 backdrop-blur">
            <Code2 size={21} />
          </span>
          <div>
            <div className="text-sm font-bold tracking-wide">Code Studio</div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-indigo-200/70">
              AI Development Workspace
            </div>
          </div>
        </div>

        <div className="relative z-10 max-w-xl text-white">
          <span className="mb-5 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] font-semibold text-indigo-100 backdrop-blur">
            <Sparkles size={13} /> 从想法到部署，一站完成
          </span>
          <h1 className="text-4xl font-bold leading-[1.15] tracking-tight xl:text-5xl">
            用对话构建应用，
            <span className="bg-gradient-to-r from-indigo-300 via-sky-300 to-violet-300 bg-clip-text text-transparent">
              把创意交付得更快。
            </span>
          </h1>
          <p className="mt-5 max-w-lg text-sm leading-7 text-slate-300/80">
            AI 生成、在线编辑、实时预览、Git
            版本与多环境部署，集中在一个流畅的开发工作台中。
          </p>
          <div className="mt-8 grid grid-cols-2 gap-3">
            {[
              [Boxes, "沙箱运行", "隔离生成与实时预览"],
              [GitBranch, "版本可追溯", "每次生成自动提交"],
              [Rocket, "快速交付", "Docker 与 K8s 部署"],
              [ShieldCheck, "企业治理", "角色、团队与审计"],
            ].map(([Icon, title, desc]) => {
              const FeatureIcon = Icon as typeof Boxes;
              return (
                <div
                  key={title as string}
                  className="rounded-2xl border border-white/10 bg-white/[0.06] p-3.5 backdrop-blur-sm"
                >
                  <FeatureIcon size={16} className="mb-2 text-indigo-300" />
                  <div className="text-xs font-semibold">{title as string}</div>
                  <div className="mt-1 text-[10px] text-slate-400">
                    {desc as string}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <p className="relative z-10 text-[10px] uppercase tracking-[0.16em] text-slate-500">
          Build · Preview · Version · Deploy
        </p>
      </section>

      <section className="relative z-10 flex items-center justify-center px-5 py-16 sm:px-10">
        <form
          onSubmit={submit}
          className="animate-fade-in w-full max-w-[420px]"
        >
          <div className="mb-8 lg:hidden">
            <span className="mb-5 grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-700 text-white shadow-lg">
              <Code2 size={22} />
            </span>
            <h1 className="text-xl font-bold">AI 代码生成平台</h1>
          </div>

          <div className="eyebrow">Welcome to Code Studio</div>
          <h2 className="mt-2 text-3xl font-bold tracking-tight text-slate-950 dark:text-white">
            {mode === "login" ? "欢迎回来" : "创建你的账号"}
          </h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            {mode === "login"
              ? "登录后继续你的项目与生成任务。"
              : "注册后即可创建项目并配置自己的模型。"}
          </p>

          <div className="mt-7 flex rounded-xl bg-slate-100 p-1 dark:bg-slate-900">
            {(["login", ...(registration.enabled ? ["register"] as const : [])] as const).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => {
                  setMode(item);
                  setError("");
                }}
                className={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition ${
                  mode === item
                    ? "bg-white text-slate-900 shadow-sm dark:bg-slate-800 dark:text-white"
                    : "text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
                }`}
              >
                {item === "login" ? "登录" : "注册"}
              </button>
            ))}
          </div>

          <div className="mt-6 space-y-4">
            <div>
              <label className="label mb-1.5">用户名或邮箱</label>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="input"
                placeholder="输入你的账号"
                autoFocus
              />
            </div>
            {mode === "register" && registration.setupRequired && (
              <div>
                <label className="label mb-1.5">管理员初始化令牌</label>
                <input
                  type="password"
                  value={setupToken}
                  onChange={(e) => setSetupToken(e.target.value)}
                  className="input"
                  placeholder="由部署人员提供的一次性令牌"
                  autoComplete="off"
                />
              </div>
            )}
            <div>
              <label className="label mb-1.5">密码</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input"
                placeholder={mode === "register" ? "至少 8 位字符" : "输入登录密码"}
              />
            </div>
          </div>

          {error && (
            <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs text-red-600 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={
              busy ||
              !username ||
              password.length < (mode === "register" ? 8 : 6) ||
              (mode === "register" && registration.setupRequired && setupToken.length < 32)
            }
            className="btn btn-primary mt-6 w-full"
          >
            {busy ? "处理中…" : mode === "login" ? "进入工作台" : "创建账号"}
            {!busy && <ArrowRight size={16} />}
          </button>

          <p className="mt-5 text-center text-[11px] leading-5 text-slate-400">
            登录即表示你已了解平台会在隔离沙箱中运行生成代码。
          </p>
        </form>
      </section>
    </div>
  );
}
