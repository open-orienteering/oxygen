/**
 * The editor's status in the top bar (docs/course-editor.md §2, §3, §8; P2):
 * the save indicator (`editor-save-state`) and the course-info button
 * (`editor-stats`) whose popover lists the course's control count, length,
 * climb, the map scale or the shown sheet's key, snapping and the check
 * count. The check count is also the button's badge. A failed or
 * conflicting save shows its words at every width: it never hides behind
 * a closed popover or a tooltip. `lib/editor/status.ts` is the model.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconStats } from "../../components/map-icons";
import { checksBadge, saveIndicator, statusRows, type SaveState, type StatusInput } from "../../lib/editor/status";

const DOT = { ok: "bg-emerald-500", busy: "bg-slate-300 animate-pulse", alert: "bg-red-500" } as const;
const TEXT = { ok: "text-emerald-700", busy: "text-slate-400", alert: "text-red-600 font-medium" } as const;

export function SaveIndicator({ save }: { save: SaveState }) {
  const { t } = useTranslation("editor");
  const s = saveIndicator(save);
  const text = t(s.key);
  return (
    <span data-testid="editor-save-state" data-state={save} role="status" aria-live="polite" title={text}
      className="flex items-center gap-1 shrink-0 text-[11px] whitespace-nowrap px-0.5">
      <span aria-hidden className={`inline-block w-2 h-2 rounded-full ${DOT[s.tone]}`} />
      {/* Saved / saving collapse to the dot on a narrow bar (the title keeps the words); an error never does. */}
      <span data-testid="editor-save-state-text" className={`${TEXT[s.tone]} ${s.alwaysText ? "" : "hidden md:inline"}`}>{text}</span>
    </span>
  );
}

export function StatsButton({ status }: { status: StatusInput }) {
  const { t } = useTranslation("editor");
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onEsc); };
  }, [open]);

  const rows = statusRows(status, t);
  const badge = checksBadge(status.checks);
  const label = t("stats");
  return (
    <div ref={box} className="relative shrink-0">
      <button type="button" data-testid="editor-stats" aria-haspopup="dialog" aria-expanded={open} aria-label={label} title={label}
        onClick={() => setOpen((v) => !v)}
        className={`relative flex items-center rounded-md p-1 cursor-pointer ${open ? "bg-purple-100 text-purple-700" : "text-slate-500 hover:bg-slate-100"}`}>
        <IconStats className="w-4 h-4" />
        {badge !== null && (
          <span data-testid="editor-stats-badge" data-count={badge}
            className="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-0.5 rounded-full bg-amber-500 text-white text-[9px] leading-[14px] text-center font-medium">
            {badge}
          </span>
        )}
      </button>
      {open && (
        <div data-testid="editor-stats-popover" role="dialog" aria-label={label}
          className="absolute right-0 top-full z-50 mt-1 min-w-[11rem] rounded-lg border border-slate-200 bg-white py-1.5 px-2.5 shadow-lg text-xs text-slate-700">
          {rows.length === 0 ? (
            <p className="text-slate-400">{t("noCourse")}</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {rows.map((r) => (
                <li key={r.id} data-testid={`editor-stats-${r.id}`} {...Object.fromEntries(Object.entries(r.data).map(([k, v]) => [`data-${k}`, v]))}
                  className={`whitespace-nowrap ${r.id === "checks" ? "text-amber-700 font-medium" : r.id === "sheet" ? "text-purple-700" : ""}`}>
                  {r.id === "checks" ? `⚠ ${r.text}` : r.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
