import { ReactNode } from "react";

/** 设置页统一页头：标题 + 说明 + 右侧动作 */
export function PageHeader({
  title,
  desc,
  action,
}: {
  title: string;
  desc?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-7 flex items-start justify-between gap-4 border-b border-slate-200/70 pb-5 dark:border-slate-800/70">
      <div>
        <div className="eyebrow">Code Studio</div>
        <h1 className="mt-1.5 text-2xl font-bold tracking-tight text-slate-950 dark:text-white">
          {title}
        </h1>
        {desc && (
          <p className="mt-1.5 max-w-2xl text-sm leading-6 text-muted">
            {desc}
          </p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/** 空状态占位 */
export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="surface-soft border-dashed px-5 py-14 text-center text-sm text-muted">
      <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-gradient-to-r from-indigo-500 to-violet-500" />
      <div className="leading-6">{children}</div>
    </div>
  );
}

/** 卡片容器（用于新建表单等） */
export function Card({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className="card p-5 sm:p-6">
      {title && (
        <h3 className="mb-5 border-b border-slate-200/70 pb-3 text-sm font-bold text-slate-900 dark:border-slate-800 dark:text-white">
          {title}
        </h3>
      )}
      {children}
    </div>
  );
}

export function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value?: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <div>
      <label className="label mb-1.5">{label}</label>
      <input
        type={type}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="input"
      />
    </div>
  );
}

export function errText(err: unknown): string {
  const e = err as {
    response?: { data?: { message?: string } };
    message?: string;
  };
  return e?.response?.data?.message ?? e?.message ?? "未知错误";
}
