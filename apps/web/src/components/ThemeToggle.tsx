import { useRef, type MouseEvent } from "react";
import { flushSync } from "react-dom";
import { Sun, Moon } from "lucide-react";
import { useTheme } from "../store/theme";

type ThemeEffect = "sweep" | "fade";

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => {
    finished: Promise<void>;
  };
};

const THEME_EFFECTS: ThemeEffect[] = ["sweep", "fade"];

export function ThemeToggle() {
  const theme = useTheme((s) => s.theme);
  const toggle = useTheme((s) => s.toggle);
  const transitioning = useRef(false);

  const handleToggle = (event: MouseEvent<HTMLButtonElement>) => {
    if (transitioning.current) return;

    const root = document.documentElement;
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const transitionDocument = document as ViewTransitionDocument;

    if (reduceMotion || !transitionDocument.startViewTransition) {
      transitioning.current = true;
      root.classList.add("theme-fallback-transition");
      flushSync(() => toggle());
      window.setTimeout(
        () => {
          root.classList.remove("theme-fallback-transition");
          transitioning.current = false;
        },
        reduceMotion ? 20 : 650,
      );
      return;
    }

    transitioning.current = true;
    const effect =
      THEME_EFFECTS[Math.floor(Math.random() * THEME_EFFECTS.length)];
    const x = event.clientX;
    const y = event.clientY;

    root.dataset.themeTransition = effect;
    root.style.setProperty("--theme-transition-x", `${x}px`);
    root.style.setProperty("--theme-transition-y", `${y}px`);

    const transition = transitionDocument.startViewTransition(() => {
      flushSync(() => toggle());
    });

    transition.finished.finally(() => {
      // 等 View Transition 伪元素完全退出合成层后再清理，避免末帧闪回。
      window.setTimeout(() => {
        delete root.dataset.themeTransition;
        root.style.removeProperty("--theme-transition-x");
        root.style.removeProperty("--theme-transition-y");
        transitioning.current = false;
      }, 80);
    });
  };

  return (
    <button
      type="button"
      onClick={handleToggle}
      title={theme === "dark" ? "切换到白天模式" : "切换到黑夜模式"}
      aria-label={theme === "dark" ? "切换到白天模式" : "切换到黑夜模式"}
      className="icon-btn h-8 w-8 rounded-lg [&>svg]:transition-transform [&>svg]:duration-500 hover:[&>svg]:rotate-12 hover:[&>svg]:scale-110"
    >
      {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}
