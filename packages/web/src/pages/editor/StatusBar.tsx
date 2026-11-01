/**
 * The status bar (docs/course-editor.md §2): the selected course's control
 * count and length, the armed tool's pending leg (§6.1), the map scale (the sheet key arrives with D8, climb
 * and checks with D6) and the autosave state.
 */

import { useTranslation } from "react-i18next";

export type SaveState = "saved" | "saving" | "error" | "conflict";

export function StatusBar({ controls, lengthM, scale, save, pendingLegM = null, snapping = false }: {
  controls: number | null; lengthM: number | null; scale: number | null; save: SaveState;
  /** The armed tool's pending leg, metres (docs/course-editor.md §6.1). */
  pendingLegM?: number | null;
  snapping?: boolean;
}) {
  const { t } = useTranslation("editor");
  const saveText = { saved: t("statusSaved"), saving: t("statusSaving"), error: t("statusError"), conflict: t("statusConflict") }[save];
  const parts: string[] = [];
  if (controls !== null) parts.push(t("statusControls", { count: controls }));
  if (lengthM !== null) parts.push(t("statusLength", { km: (lengthM / 1000).toFixed(1) }));
  if (scale) parts.push(t("statusScale", { scale: scale.toLocaleString("sv-SE") }));
  if (snapping) parts.push(t("statusSnapping"));
  return (
    <div data-testid="editor-status" className="pointer-events-auto bg-white/95 backdrop-blur-sm border border-slate-200 rounded-lg shadow-sm px-2.5 py-1 text-[11px] text-slate-600 flex items-center gap-1.5 w-fit max-w-full">
      {parts.length > 0 && <span data-testid="editor-status-kpis" className="truncate">{parts.join(" · ")}</span>}
      {pendingLegM !== null && <span data-testid="editor-pending-leg-length" className="text-purple-700 font-medium">{t("statusPendingLeg", { m: Math.round(pendingLegM) })}</span>}
      {parts.length > 0 && <span className="text-slate-300">·</span>}
      <span data-testid="editor-save-state" data-state={save} className={save === "error" || save === "conflict" ? "text-red-600" : save === "saving" ? "text-slate-400" : "text-emerald-700"}>
        {saveText}
      </span>
    </div>
  );
}
