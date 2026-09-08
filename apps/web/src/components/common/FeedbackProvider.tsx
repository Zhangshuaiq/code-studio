import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CircleCheck, CircleHelp, Info, TriangleAlert, X } from "lucide-react";

type ToastTone = "success" | "error" | "warning" | "info";

type ToastOptions = {
  title?: string;
  tone?: ToastTone;
  duration?: number;
};

type ConfirmOptions = {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  tone?: "primary" | "danger";
};

type PromptOptions = {
  title?: string;
  message?: string;
  initialValue?: string;
  placeholder?: string;
  confirmText?: string;
  cancelText?: string;
  inputType?: "text" | "number";
  validate?: (value: string) => string | undefined;
};

type ToastItem = Required<Pick<ToastOptions, "tone">> & {
  id: number;
  title?: string;
  message: string;
};

type DialogState =
  | ({ kind: "confirm"; resolve: (value: boolean) => void } & ConfirmOptions)
  | ({
      kind: "prompt";
      resolve: (value: string | null) => void;
    } & PromptOptions);

type FeedbackContextValue = {
  toast: (message: string, options?: ToastOptions) => void;
  confirm: (options: ConfirmOptions | string) => Promise<boolean>;
  prompt: (options: PromptOptions) => Promise<string | null>;
};

const FeedbackContext = createContext<FeedbackContextValue | null>(null);

const toastStyles: Record<ToastTone, string> = {
  success:
    "border-emerald-200 bg-emerald-50/95 text-emerald-800 dark:border-emerald-500/25 dark:bg-emerald-950/95 dark:text-emerald-200",
  error:
    "border-red-200 bg-red-50/95 text-red-800 dark:border-red-500/25 dark:bg-red-950/95 dark:text-red-200",
  warning:
    "border-amber-200 bg-amber-50/95 text-amber-800 dark:border-amber-500/25 dark:bg-amber-950/95 dark:text-amber-200",
  info: "border-indigo-200 bg-indigo-50/95 text-indigo-800 dark:border-indigo-500/25 dark:bg-indigo-950/95 dark:text-indigo-200",
};

const toastIcons: Record<ToastTone, typeof Info> = {
  success: CircleCheck,
  error: TriangleAlert,
  warning: TriangleAlert,
  info: Info,
};

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [promptValue, setPromptValue] = useState("");
  const [promptError, setPromptError] = useState("");
  const nextToastId = useRef(0);
  const toastTimers = useRef(new Map<number, number>());

  const dismissToast = useCallback((id: number) => {
    setToasts((items) => items.filter((item) => item.id !== id));
    const timer = toastTimers.current.get(id);
    if (timer) window.clearTimeout(timer);
    toastTimers.current.delete(id);
  }, []);

  const toast = useCallback(
    (message: string, options: ToastOptions = {}) => {
      const id = ++nextToastId.current;
      setToasts((items) => [
        ...items,
        {
          id,
          message,
          title: options.title,
          tone: options.tone ?? "info",
        },
      ]);
      const timer = window.setTimeout(
        () => dismissToast(id),
        options.duration ?? 4200,
      );
      toastTimers.current.set(id, timer);
    },
    [dismissToast],
  );

  const confirm = useCallback((options: ConfirmOptions | string) => {
    const normalized =
      typeof options === "string" ? { message: options } : options;
    return new Promise<boolean>((resolve) => {
      setDialog({ kind: "confirm", tone: "primary", ...normalized, resolve });
    });
  }, []);

  const prompt = useCallback((options: PromptOptions) => {
    return new Promise<string | null>((resolve) => {
      setPromptValue(options.initialValue ?? "");
      setPromptError("");
      setDialog({ kind: "prompt", ...options, resolve });
    });
  }, []);

  const cancelDialog = useCallback(() => {
    if (!dialog) return;
    if (dialog.kind === "confirm") dialog.resolve(false);
    else dialog.resolve(null);
    setDialog(null);
    setPromptError("");
  }, [dialog]);

  const submitDialog = useCallback(() => {
    if (!dialog) return;
    if (dialog.kind === "confirm") {
      dialog.resolve(true);
      setDialog(null);
      return;
    }

    const error = dialog.validate?.(promptValue);
    if (error) {
      setPromptError(error);
      return;
    }
    dialog.resolve(promptValue);
    setDialog(null);
    setPromptError("");
  }, [dialog, promptValue]);

  useEffect(() => {
    if (!dialog) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancelDialog();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [cancelDialog, dialog]);

  useEffect(() => {
    const timers = toastTimers.current;
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, []);

  const value = useMemo(
    () => ({ toast, confirm, prompt }),
    [confirm, prompt, toast],
  );

  return (
    <FeedbackContext.Provider value={value}>
      {children}

      <div className="pointer-events-none fixed right-4 top-4 z-[120] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2">
        {toasts.map((item) => {
          const Icon = toastIcons[item.tone];
          return (
            <div
              key={item.id}
              role={item.tone === "error" ? "alert" : "status"}
              className={`pointer-events-auto flex animate-fade-in items-start gap-3 rounded-2xl border p-3.5 shadow-xl backdrop-blur-xl ${toastStyles[item.tone]}`}
            >
              <Icon size={18} className="mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1">
                {item.title && (
                  <p className="text-sm font-semibold">{item.title}</p>
                )}
                <p
                  className={`${item.title ? "mt-0.5" : ""} break-words text-xs leading-5`}
                >
                  {item.message}
                </p>
              </div>
              <button
                onClick={() => dismissToast(item.id)}
                className="grid h-6 w-6 shrink-0 place-items-center rounded-lg opacity-60 transition hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
                aria-label="关闭通知"
              >
                <X size={13} />
              </button>
            </div>
          );
        })}
      </div>

      {dialog && (
        <div
          className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-sm"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) cancelDialog();
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="feedback-dialog-title"
            className="card animate-fade-in w-full max-w-md overflow-hidden"
          >
            <div className="flex items-start gap-3 px-5 pb-3 pt-5">
              <span
                className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${
                  dialog.kind === "confirm" && dialog.tone === "danger"
                    ? "bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-300"
                    : "bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300"
                }`}
              >
                {dialog.kind === "confirm" && dialog.tone === "danger" ? (
                  <TriangleAlert size={19} />
                ) : (
                  <CircleHelp size={19} />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <h2
                  id="feedback-dialog-title"
                  className="text-base font-semibold text-slate-900 dark:text-white"
                >
                  {dialog.title ??
                    (dialog.kind === "confirm" ? "请确认操作" : "请输入内容")}
                </h2>
                {dialog.message && (
                  <p className="mt-1 whitespace-pre-line text-sm leading-6 text-muted">
                    {dialog.message}
                  </p>
                )}
              </div>
              <button
                onClick={cancelDialog}
                className="icon-btn -mr-1 -mt-1"
                aria-label="关闭弹窗"
              >
                <X size={16} />
              </button>
            </div>

            {dialog.kind === "prompt" && (
              <div className="px-5 pb-5">
                <input
                  autoFocus
                  type={dialog.inputType ?? "text"}
                  value={promptValue}
                  onChange={(event) => {
                    setPromptValue(event.target.value);
                    setPromptError("");
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") submitDialog();
                  }}
                  placeholder={dialog.placeholder}
                  className="input"
                />
                {promptError && (
                  <p className="mt-2 text-xs text-red-500">{promptError}</p>
                )}
              </div>
            )}

            <div className="flex justify-end gap-2 border-t border-slate-200/80 bg-slate-50/70 px-5 py-4 dark:border-slate-800 dark:bg-slate-950/35">
              <button onClick={cancelDialog} className="btn btn-ghost btn-sm">
                {dialog.cancelText ?? "取消"}
              </button>
              <button
                onClick={submitDialog}
                className={`btn btn-sm ${
                  dialog.kind === "confirm" && dialog.tone === "danger"
                    ? "border border-red-500/20 bg-red-600 text-white shadow-sm hover:bg-red-700"
                    : "btn-primary"
                }`}
              >
                {dialog.confirmText ?? "确认"}
              </button>
            </div>
          </div>
        </div>
      )}
    </FeedbackContext.Provider>
  );
}

export function useFeedback() {
  const context = useContext(FeedbackContext);
  if (!context) {
    throw new Error("useFeedback must be used within FeedbackProvider");
  }
  return context;
}
