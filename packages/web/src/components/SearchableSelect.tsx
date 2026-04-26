import { useState, useEffect, useRef, type ReactNode } from "react";

export interface SelectOption {
  value: number | string;
  label: string;
  /** Optional leading element (e.g. logo image) */
  icon?: ReactNode;
  /** Optional secondary text shown after the label */
  suffix?: string;
  /** Disable this option (shown but not selectable) */
  disabled?: boolean;
}

/**
 * A searchable dropdown select that supports:
 * - Type-to-search filtering
 * - Custom icons per option (e.g. club logos)
 * - Click-outside to close
 * - Keyboard escape to close
 *
 * Use for lists with many items (clubs, classes).
 * For short enums (sex, status), a native <select> is fine.
 */
export function SearchableSelect({
  value,
  onChange,
  options,
  placeholder = "Select...",
  searchPlaceholder = "Search...",
  className = "",
  testId,
  alwaysShowSearch = false,
}: {
  value: number | string;
  onChange: (value: number | string) => void;
  options: SelectOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  className?: string;
  /** data-testid for E2E tests */
  testId?: string;
  /** Always show the search input, even with few options */
  alwaysShowSearch?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Popup position is computed from the trigger's bounding rect and applied
  // via `position: fixed`, so it escapes any ancestor `overflow:auto` (e.g.
  // the import dialog's scroll container) instead of being clipped.
  const [popupStyle, setPopupStyle] = useState<React.CSSProperties | null>(null);

  const selected = options.find((o) => o.value === value);

  // Close on outside click. The popup may live outside `containerRef` visually
  // (via fixed positioning), but it's still a DOM child of `containerRef`, so
  // the contains() check works regardless. We also accept clicks on `popupRef`
  // explicitly as a defensive fallback.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        (containerRef.current && containerRef.current.contains(target)) ||
        (popupRef.current && popupRef.current.contains(target))
      ) {
        return;
      }
      setOpen(false);
      setSearch("");
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setSearch("");
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  // Compute popup placement (above/below) based on viewport space, and keep
  // it in sync while the page (or any ancestor scroll container) scrolls or
  // the window resizes.
  useEffect(() => {
    if (!open) {
      setPopupStyle(null);
      return;
    }
    const update = () => {
      const btn = buttonRef.current;
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      const desired = 240; // matches Tailwind max-h-60
      const margin = 4;
      const spaceBelow = window.innerHeight - rect.bottom - margin;
      const spaceAbove = rect.top - margin;
      const openUp =
        spaceBelow < Math.min(desired, 160) && spaceAbove > spaceBelow;
      const maxHeight = Math.min(desired, openUp ? spaceAbove : spaceBelow);
      setPopupStyle({
        position: "fixed",
        left: rect.left,
        width: rect.width,
        maxHeight: Math.max(maxHeight, 80),
        ...(openUp
          ? { bottom: window.innerHeight - rect.top + margin }
          : { top: rect.bottom + margin }),
      });
    };
    update();
    // capture: true so we also catch scrolls inside ancestor scroll containers
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open]);

  // Auto-focus search input when opened
  useEffect(() => {
    if (open) {
      // Small delay so the DOM has rendered
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const filtered = options.filter(
    (o) => !search || o.label.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div ref={containerRef} className={`relative ${className}`} data-testid={testId}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => { setOpen(!open); setSearch(""); }}
        className="w-full px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-400 cursor-pointer text-left flex items-center gap-1.5 hover:border-slate-300 transition-colors"
      >
        {selected ? (
          <>
            {selected.icon}
            <span className="truncate">{selected.label}</span>
            {selected.suffix && (
              <span className="text-slate-400 text-xs ml-auto flex-shrink-0">{selected.suffix}</span>
            )}
          </>
        ) : (
          <span className="text-slate-400">{placeholder}</span>
        )}
        <svg className="w-3.5 h-3.5 text-slate-400 ml-auto flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && popupStyle && (
        <div
          ref={popupRef}
          style={popupStyle}
          className="z-50 min-w-[200px] bg-white border border-slate-200 rounded-lg shadow-lg overflow-hidden flex flex-col"
        >
          {(alwaysShowSearch || options.length > 6) && (
            <div className="p-1.5 border-b border-slate-100">
              <input
                ref={inputRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={searchPlaceholder}
                className="w-full px-2 py-1 text-sm border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-blue-400"
              />
            </div>
          )}
          <div className="overflow-y-auto">
            {filtered.map((o) => (
              <button
                key={o.value}
                type="button"
                disabled={o.disabled}
                onClick={() => { if (!o.disabled) { onChange(o.value); setOpen(false); setSearch(""); } }}
                className={`w-full px-2.5 py-1.5 text-sm text-left flex items-center gap-1.5 ${
                  o.disabled
                    ? "opacity-50 cursor-not-allowed"
                    : `hover:bg-blue-50 cursor-pointer ${o.value === value ? "bg-blue-50 font-medium" : ""}`
                }`}
              >
                {o.icon}
                <span className="truncate">{o.label}</span>
                {o.suffix && (
                  <span className={`text-xs ml-auto flex-shrink-0 ${o.disabled ? "text-red-400" : "text-slate-400"}`}>{o.suffix}</span>
                )}
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="px-2 py-3 text-xs text-slate-400 text-center">No matches</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
