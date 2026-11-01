/**
 * The status bar (docs/course-editor.md §2): the selected course's control
 * count and length, the map scale (the sheet key arrives with D8, climb
 * and checks with D6) and the autosave state.
 */

import { useTranslation } from "react-i18next";

export type SaveState = "saved" | "saving" | "error" | "conflict";

export function StatusBar({ controls, lengthM, scale, save }: { controls: number | null; lengthM: number | null; scale: number | null; save: SaveState }) {
  const { t } = useTranslation("editor");
  const saveText = { saved: t("statusSaved"), saving: t("statusSaving"), error: t("statusError"), conflict: t("statusConflict") }[save];
  const parts: string[] = [];
  if (controls !== null) parts.push(t("statusControls", { count: controls }));
  if (lengthM !== null) parts.push(t("statusLength", { km: (lengthM / 1000).toFixed(1) }));
  if (scale) parts.push(t("statusScale", { scale: scale.toLocaleString("sv-SE") }));
  return (
    <div data-testid="editor-status" className="pointer-events-auto bg-white/95 backdrop-blur-sm border border-slate-200 rounded-lg shadow-sm px-2.5 py-1 text-[11px] text-slate-600 flex items-center gap-1.5 w-fit max-w-full">
      {parts.length > 0 && <span data-testid="editor-status-kpis" className="truncate">{parts.join(" · ")}</span>}
      {parts.length > 0 && <span className="text-slate-300">·</span>}
      <span data-testid="editor-save-state" data-state={save} className={save === "error" || save === "conflict" ? "text-red-600" : save === "saving" ? "text-slate-400" : "text-emerald-700"}>
        {saveText}
      </span>
    </div>
  );
}
