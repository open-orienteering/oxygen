/**
 * The status bar (docs/course-editor.md §2): the selected course's control
 * count, length and climb, the armed tool's pending leg (§6.1), the map scale — or, when a sheet is
 * shown (Layout mode, Class view), the sheet key (docs/course-layout.md §5) — the check count (§8)
 * and the autosave state.
 */

import { useTranslation } from "react-i18next";

export type SaveState = "saved" | "saving" | "error" | "conflict";

export function StatusBar({ controls, lengthM, climbM = null, checks = null, scale, save, pendingLegM = null, snapping = false, sheetKey = null }: {
  controls: number | null; lengthM: number | null; scale: number | null; save: SaveState;
  /** The course's stored climb (entered on the Courses page), metres; shown when set. */
  climbM?: number | null;
  /** The number of advisory checks (docs/course-editor.md §8). */
  checks?: number | null;
  /** The armed tool's pending leg, metres (docs/course-editor.md §6.1). */
  pendingLegM?: number | null;
  snapping?: boolean;
  /** The shown sheet's print scale, paper and orientation (`1:10000 A4 portrait`), in place of the map scale. */
  sheetKey?: string | null;
}) {
  const { t } = useTranslation("editor");
  const saveText = { saved: t("statusSaved"), saving: t("statusSaving"), error: t("statusError"), conflict: t("statusConflict") }[save];
  const parts: string[] = [];
  if (controls !== null) parts.push(t("statusControls", { count: controls }));
  if (lengthM !== null) parts.push(t("statusLength", { km: (lengthM / 1000).toFixed(1) }));
  if (climbM) parts.push(t("statusClimb", { m: Math.round(climbM) }));
  if (!sheetKey && scale) parts.push(t("statusScale", { scale: scale.toLocaleString("sv-SE") }));
  if (snapping) parts.push(t("statusSnapping"));
  // One line no wider than the inspector above it (w-64): taller, it squeezes the inspector; wider, it covers the map.
  return (
    <div data-testid="editor-status" className="pointer-events-auto bg-white/95 backdrop-blur-sm border border-slate-200 rounded-lg shadow-sm px-2.5 py-1 text-[11px] text-slate-600 flex items-center gap-1.5 w-fit max-w-64 whitespace-nowrap">
      {parts.length > 0 && <span data-testid="editor-status-kpis" className="truncate min-w-0">{parts.join(" · ")}</span>}
      {sheetKey && <span data-testid="editor-status-sheet" data-key={sheetKey} className="shrink-0 text-purple-700">{sheetKey}</span>}
      {checks !== null && checks > 0 && (
        <span data-testid="editor-status-checks" data-count={checks} className="shrink-0 text-amber-700 font-medium">⚠ {t("statusChecks", { count: checks })}</span>
      )}
      {pendingLegM !== null && <span data-testid="editor-pending-leg-length" className="shrink-0 text-purple-700 font-medium">{t("statusPendingLeg", { m: Math.round(pendingLegM) })}</span>}
      {parts.length > 0 && <span className="text-slate-300">·</span>}
      <span data-testid="editor-save-state" data-state={save} className={"shrink-0 " + (save === "error" || save === "conflict" ? "text-red-600" : save === "saving" ? "text-slate-400" : "text-emerald-700")}>
        {saveText}
      </span>
    </div>
  );
}
