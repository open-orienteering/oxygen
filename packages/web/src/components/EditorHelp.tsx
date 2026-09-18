import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Compact "i" popover used by course and map layout editors for
 * keyboard / tool hints that would otherwise clutter the toolbar.
 */
export function EditorHelp({
  hint,
  label,
  testId = "editor-help",
}: {
  hint: ReactNode;
  label: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div className="relative inline-flex items-center shrink-0" ref={ref}>
      <button
        type="button"
        data-testid={testId}
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-blue-600"
      >
        <svg
          width={16}
          height={16}
          viewBox="0 0 20 20"
          fill="currentColor"
          className="shrink-0"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z"
            clipRule="evenodd"
          />
        </svg>
      </button>
      {open && (
        <div
          data-testid={testId === "editor-help" ? "editor-hint" : `${testId}-hint`}
          role="note"
          className="absolute left-0 top-full z-50 mt-1.5 w-80 whitespace-pre-line rounded-lg border border-slate-200 bg-white p-3 text-xs text-slate-700 shadow-lg"
        >
          {hint}
        </div>
      )}
    </div>
  );
}
