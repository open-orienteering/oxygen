import { useState, useEffect, useRef, type ReactNode } from "react";

export interface SelectOption {
  value: number | string;
  label: string;
  /** Optional leading element (e.g. logo image) */
  icon?: ReactNode;
  /** Optional secondary text shown after the label */
  suffix?: string;
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
}: {
  value: number | string;
  onChange: (value: number | string) => void;
  options: SelectOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  className?: string;
  /** data-testid for E2E tests */
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = options.find((o) => o.value === value);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch("");
      }
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

      {open && (
        <div className="absolute z-50 mt-1 w-full min-w-[200px] bg-white border border-slate-200 rounded-lg shadow-lg max-h-60 overflow-hidden flex flex-col">
          {options.length > 6 && (
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
                onClick={() => { onChange(o.value); setOpen(false); setSearch(""); }}
                className={`w-full px-2.5 py-1.5 text-sm text-left hover:bg-blue-50 cursor-pointer flex items-center gap-1.5 ${
                  o.value === value ? "bg-blue-50 font-medium" : ""
                }`}
              >
                {o.icon}
                <span className="truncate">{o.label}</span>
                {o.suffix && (
                  <span className="text-slate-400 text-xs ml-auto flex-shrink-0">{o.suffix}</span>
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
