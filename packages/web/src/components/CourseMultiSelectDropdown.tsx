import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";

interface CourseMultiSelectDropdownProps {
  selectedIds: number[];
  onChange: (ids: number[]) => void;
}

/**
 * Multi-select course picker rendered as a single dropdown button.
 *
 * Replaces the previous stacked-checkbox list — which grew taller with
 * every course in the competition — with a compact trigger summary and
 * a popover containing checkbox rows that preserve the original info
 * (name, control count, length).
 */
export function CourseMultiSelectDropdown({
  selectedIds,
  onChange,
}: CourseMultiSelectDropdownProps) {
  const { t } = useTranslation("classes");
  const courses = trpc.course.list.useQuery();
  const available = courses.data ?? [];

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      searchRef.current?.focus();
    } else {
      setQuery("");
    }
  }, [open]);

  const filtered = useMemo(() => {
    if (!query.trim()) return available;
    const q = query.toLowerCase();
    return available.filter((c) => c.name.toLowerCase().includes(q));
  }, [available, query]);

  const selectedNames = useMemo(() => {
    const byId = new Map(available.map((c) => [c.id, c.name]));
    return selectedIds.map((id) => byId.get(id)).filter((n): n is string => !!n);
  }, [available, selectedIds]);

  const toggleCourse = (id: number) => {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((x) => x !== id));
    } else {
      onChange([...selectedIds, id]);
    }
  };

  const triggerLabel =
    selectedNames.length === 0
      ? t("selectCoursesPlaceholder")
      : selectedNames.length === 1
        ? selectedNames[0]
        : t("coursesSelected", { count: selectedNames.length });

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`w-full flex items-center justify-between gap-2 px-3 py-1.5 border rounded-lg text-sm bg-white cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500 ${
          open ? "border-blue-400" : "border-slate-200"
        }`}
      >
        <span
          className={`truncate ${
            selectedNames.length === 0 ? "text-slate-400" : "text-slate-700"
          }`}
        >
          {triggerLabel}
        </span>
        <svg
          className={`w-4 h-4 text-slate-400 shrink-0 transition-transform ${
            open ? "rotate-180" : ""
          }`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      {open && (
        <div
          className="absolute left-0 right-0 top-full mt-1 z-50 bg-white border border-slate-200 rounded-lg shadow-lg"
          role="listbox"
        >
          {available.length > 6 && (
            <div className="p-2 border-b border-slate-100">
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("searchCourse")}
                className="w-full px-2 py-1 border border-slate-200 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          )}

          <div className="max-h-60 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <p className="px-3 py-2 text-xs text-slate-400">
                {available.length === 0
                  ? t("noCoursesAvailable")
                  : t("noCoursesMatch", { defaultValue: "No matching courses" })}
              </p>
            ) : (
              filtered.map((c) => {
                const checked = selectedIds.includes(c.id);
                return (
                  <label
                    key={c.id}
                    className={`flex items-center gap-2 cursor-pointer px-3 py-1.5 text-sm ${
                      checked ? "bg-blue-50/60" : "hover:bg-slate-50"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleCourse(c.id)}
                      className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                    />
                    <span className="text-slate-700 truncate">{c.name}</span>
                    <span className="text-xs text-slate-400 ml-auto whitespace-nowrap">
                      {t("controlsCount", { count: c.controlCount })}
                      {c.length > 0 && ` · ${(c.length / 1000).toFixed(1)} km`}
                    </span>
                  </label>
                );
              })
            )}
          </div>

          {selectedIds.length > 1 && (
            <div className="border-t border-slate-100 px-3 py-1.5 text-xs text-purple-600 font-medium bg-purple-50/40">
              {t("forkedDescription")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
