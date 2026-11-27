/**
 * The editor's status in the top bar (docs/course-editor.md §2, §3, §8; P2):
 * the save indicator (`editor-save-state`) and the course-info button
 * (`editor-stats`) whose popover lists the course's control count, length,
 * climb, the shown sheet's key, snapping and the check count (the map scale
 * is the map-info dialog's since P6, `MapInfoDialog.tsx`). The check count is
 * also the button's badge. A failed or
 * conflicting save shows its words at every width: it never hides behind
 * a closed popover or a tooltip. `lib/editor/status.ts` is the model.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconStats } from "../../components/map-icons";
import { useCapabilities } from "../../context/CapabilitiesContext";
import { openMapInfoAtInterval } from "./ContourInterval";
import { formatClock } from "../../lib/editor/leg-alternatives";
import { checksBadge, courseInfoRows, saveIndicator, type SaveState, type StatusInput } from "../../lib/editor/status";

const DOT = { ok: "bg-emerald-500", busy: "bg-slate-300 animate-pulse", alert: "bg-red-500", wait: "bg-amber-500" } as const;
const TEXT = { ok: "text-emerald-700", busy: "text-slate-400", alert: "text-red-600 font-medium", wait: "text-amber-700 font-medium" } as const;

export function SaveIndicator({ save }: { save: SaveState }) {
  const { t } = useTranslation("editor");
  const s = saveIndicator(save);
  const text = t(s.key);
  return (
    <span data-testid="editor-save-state" data-state={save} role="status" aria-live="polite" title={text}
      className="flex items-center gap-1 shrink-0 text-[11px] whitespace-nowrap px-0.5">
      <span aria-hidden className={`inline-block w-2 h-2 rounded-full ${DOT[s.tone]}`} />
      {/* Saved / saving are the dot alone (the words are its title and for screen readers): the top bar's row must not
          wrap on a laptop screen. An error, a conflict or a queue (D9c) always shows its words. */}
      <span data-testid="editor-save-state-text" className={`${TEXT[s.tone]} ${s.alwaysText ? "" : "sr-only"}`}>{text}</span>
    </span>
  );
}

export interface ProfileToggle { open: boolean; onToggle: () => void }

/** The course's expected winner pace (docs/course-elevation.md §7.8): a setting of the course, typed here. */
export interface PaceSetting {
  /** `m:ss` per km: the typed pace, or the default while none is typed. */
  text: string;
  isDefault: boolean;
  readOnly: boolean;
  onPace: (text: string) => boolean;
  /** The course along the routes its legs are read along; null: not known. */
  totals: { routeM: number; timeS: number | null; routed: number } | null;
}

export function StatsButton({ status, onRetryElevation, profile, pace }: { status: Omit<StatusInput, "scale">; onRetryElevation?: () => void; profile?: ProfileToggle | null; pace?: PaceSetting | null }) {
  const { t } = useTranslation("editor");
  const canEdit = useCapabilities().has("courses.edit");
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    // Escape closes the popover and nothing else: the editor's Escape cascade (§3: a tool, the selection, the
    // course, fullscreen) listens on window, after this document listener.
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onEsc); };
  }, [open]);

  const rows = courseInfoRows(status, t);
  // The notes are the computed climb's: not under a typed one.
  const line = status.climbManual ? null : status.line ?? null;
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
          {/* §0.43: on the contours with an interval nobody confirmed the number is an estimate, and not stored. */}
          {line?.state === "ready" && line.basis === "contours" && !line.intervalConfirmed && (
            <div data-testid="editor-stats-interval-note" className="mt-1 border-t border-slate-100 pt-1 text-[10px] text-amber-700 max-w-[16rem]">
              <p>{t("intervalEstimateNote", { m: line.assumedIntervalM ?? 5 })}</p>
              {canEdit && (
                <button type="button" data-testid="editor-stats-interval-confirm" onClick={() => { setOpen(false); openMapInfoAtInterval(); }}
                  className="mt-1 rounded-md border border-amber-300 bg-white px-2 py-0.5 text-[11px] text-amber-800 hover:bg-amber-50 cursor-pointer">{t("intervalConfirm")}</button>
              )}
            </div>
          )}
          {/* docs/course-elevation.md §4.4: what the line climb rests on, whose heights they are, and asking again. */}
          {line?.state === "ready" && (line.basis === "contours" || line.partial || line.attribution) && (
            <div className="mt-1 border-t border-slate-100 pt-1 text-[10px] text-slate-400 max-w-[16rem]">
              {line.basis === "contours" && <p data-testid="editor-stats-elevation-note">{t("elevationContoursNote")}</p>}
              {line.partial && <p data-testid="editor-stats-elevation-partial">{t("elevationPartial")}</p>}
              {line.attribution && <p data-testid="editor-stats-elevation-attribution">{line.attribution}</p>}
            </div>
          )}
          {line?.state === "unavailable" && onRetryElevation && rows.some((r) => r.id === "climb" && r.data.state === "unavailable") && (
            <button type="button" data-testid="editor-stats-elevation-retry" onClick={onRetryElevation}
              className="mt-1 rounded-md border border-slate-200 px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50 cursor-pointer">{t("elevationRetry")}</button>
          )}
          {/* docs/course-elevation.md §7.8: the winner pace is the course's, and the times of every leg rest on it. */}
          {pace && (
            <div data-testid="editor-stats-pace" data-default={pace.isDefault ? "true" : "false"} className="mt-1 border-t border-slate-100 pt-1">
              <label className="flex items-center gap-1.5 whitespace-nowrap">{t("winnerPace")}
                <input data-testid="editor-stats-pace-input" disabled={pace.readOnly} defaultValue={pace.text} key={pace.text} inputMode="numeric"
                  className="w-12 px-1 py-0.5 rounded border border-slate-200 bg-white text-[11px] font-mono disabled:bg-slate-50"
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                  onBlur={(e) => { if (!pace.onPace(e.target.value)) e.target.value = pace.text; }} />
                <span className="text-slate-400">{t(pace.isDefault ? "winnerPaceUnitDefault" : "winnerPaceUnit")}</span>
              </label>
              {pace.totals && (
                <p data-testid="editor-course-route-totals" data-m={pace.totals.routeM} data-time={pace.totals.timeS ?? ""} data-routed={pace.totals.routed} className="text-[10px] text-slate-500 max-w-[16rem]">
                  {t(pace.totals.timeS !== null ? "legRouteTotalsTime" : "legRouteTotals", { m: pace.totals.routeM, time: pace.totals.timeS !== null ? formatClock(pace.totals.timeS) : "", pace: pace.text, count: pace.totals.routed })}
                </p>
              )}
            </div>
          )}
          {/* docs/course-elevation.md §5: the profile panel under the map. */}
          {profile && (
            <button type="button" data-testid="editor-stats-profile-toggle" aria-pressed={profile.open} onClick={() => { profile.onToggle(); setOpen(false); }}
              className="mt-1.5 block w-full rounded-md border border-slate-200 px-2 py-0.5 text-left text-[11px] text-slate-600 hover:bg-slate-50 cursor-pointer">
              {t(profile.open ? "profileHide" : "profileShow")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
