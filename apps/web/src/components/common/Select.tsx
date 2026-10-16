import {
  type CSSProperties,
  type KeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

export type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
  description?: string;
};

export function Select({
  value,
  options,
  onChange,
  placeholder = "请选择",
  disabled = false,
  size = "md",
  className = "",
  buttonClassName = "",
  title,
  ariaLabel,
  menuMinWidth = 160,
  searchable = false,
  searchPlaceholder = '搜索…',
}: {
  value?: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  size?: "sm" | "md";
  className?: string;
  buttonClassName?: string;
  title?: string;
  ariaLabel?: string;
  menuMinWidth?: number;
  searchable?: boolean;
  searchPlaceholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const visibleOptions = searchable && search.trim() ? options.filter(option => `${option.label} ${option.value} ${option.description || ''}`.toLowerCase().includes(search.trim().toLowerCase())) : options;

  const getEnabledIndex = (start: number, direction: 1 | -1) => {
    if (visibleOptions.length === 0) return -1;
    for (let step = 0; step < visibleOptions.length; step += 1) {
      const index =
        (start + direction * step + visibleOptions.length) % visibleOptions.length;
      if (!visibleOptions[index]?.disabled) return index;
    }
    return -1;
  };

  const openMenu = () => {
    if (disabled || options.length === 0 || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const estimatedHeight = Math.min(280, options.length * 40 + 12);
    const spaceBelow = window.innerHeight - rect.bottom;
    const openAbove =
      spaceBelow < estimatedHeight + 16 && rect.top > spaceBelow;
    const width = Math.min(Math.max(rect.width, menuMinWidth), window.innerWidth - 16);
    const left = Math.min(
      Math.max(8, rect.left),
      Math.max(8, window.innerWidth - width - 8),
    );

    setMenuStyle({
      left,
      width,
      ...(openAbove
        ? { bottom: window.innerHeight - rect.top + 6 }
        : { top: rect.bottom + 6 }),
    });
    setActiveIndex(selectedIndex >= 0 && !options[selectedIndex]?.disabled ? selectedIndex : options.findIndex(option => !option.disabled));
    setOpen(true);
    setSearch('');
  };

  const closeMenu = () => setOpen(false);

  const choose = (option: SelectOption) => {
    if (option.disabled) return;
    onChange(option.value);
    closeMenu();
    buttonRef.current?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        openMenu();
        return;
      }
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const start = activeIndex < 0 ? 0 : activeIndex + direction;
      setActiveIndex(getEnabledIndex(start, direction));
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!open) openMenu();
      else if (activeIndex >= 0 && visibleOptions[activeIndex]) choose(visibleOptions[activeIndex]);
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
    }
  };

  useEffect(() => { if (open && searchable) searchRef.current?.focus(); }, [open, searchable]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !buttonRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        closeMenu();
      }
    };
    const handleViewportChange = (event: Event) => {
      if (
        event.target instanceof Node &&
        menuRef.current?.contains(event.target)
      )
        return;
      closeMenu();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [open]);

  return (
    <div className={`relative ${className}`}>
      <button
        ref={buttonRef}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-label={ariaLabel}
        title={title}
        disabled={disabled}
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={handleKeyDown}
        className={`input flex items-center justify-between gap-2 text-left ${
          size === "sm" ? "min-h-8 rounded-lg px-2.5 py-1.5 text-xs" : "pr-3.5"
        } ${buttonClassName}`}
      >
        <span
          className={`min-w-0 flex-1 truncate ${
            selected ? "" : "text-slate-400 dark:text-slate-500"
          }`}
        >
          {selected?.label ?? placeholder}
        </span>
        <ChevronDown
          size={14}
          className={`shrink-0 text-slate-400 transition-transform duration-200 ${
            open ? "rotate-180 text-indigo-500" : ""
          }`}
        />
      </button>

      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={listboxId}
            role="listbox"
            style={menuStyle}
            onKeyDown={event => {
              if (event.key === "Escape") {
                event.preventDefault(); event.stopPropagation(); closeMenu(); buttonRef.current?.focus();
              }
            }}
            className="fixed z-[140] max-h-72 overflow-y-auto rounded-2xl border border-slate-200/90 bg-white/95 p-1.5 shadow-[0_20px_55px_-18px_rgba(15,23,42,0.45)] backdrop-blur-xl dark:border-slate-700/90 dark:bg-slate-900/95 dark:shadow-[0_24px_65px_-20px_rgba(0,0,0,0.85)]"
          >
            {searchable && <div className="sticky top-0 z-10 bg-white p-1 dark:bg-slate-900"><input ref={searchRef} type="search" aria-label={searchPlaceholder} placeholder={searchPlaceholder} value={search} className="input w-full text-xs" onChange={event => { setSearch(event.target.value); setActiveIndex(0); }} onKeyDown={event => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const direction = event.key === 'ArrowDown' ? 1 : -1; setActiveIndex(getEnabledIndex(activeIndex + direction, direction)); }
              else if (event.key === 'Enter') { event.preventDefault(); const option = visibleOptions[activeIndex]; if (option) choose(option); }
            }} /></div>}
            {!visibleOptions.length && <p className="p-3 text-xs text-muted" role="status">没有匹配项</p>}
            {visibleOptions.map((option, index) => {
              const isSelected = option.value === value;
              const isActive = index === activeIndex;
              return (
                <button
                  key={`${option.value}-${index}`}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  title={option.description || option.label}
                  disabled={option.disabled}
                  onMouseEnter={() => !option.disabled && setActiveIndex(index)}
                  onClick={() => choose(option)}
                  className={`flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                    isSelected
                      ? "bg-indigo-50 font-semibold text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
                      : isActive
                        ? "bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-white"
                        : "text-slate-600 dark:text-slate-300"
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className={option.description ? "block whitespace-normal break-words" : "block truncate"}>{option.label}</span>
                    {option.description && <span className="mt-1 block whitespace-normal break-all font-mono text-[11px] font-normal text-slate-400">{option.description}</span>}
                  </span>
                  {isSelected && (
                    <Check size={14} className="shrink-0 text-indigo-500" />
                  )}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
