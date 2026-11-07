/**
 * The phone's status line in the bottom sheet's peek row (docs/course-editor.md
 * §10): the selected course's control count, length and climb, the map scale,
 * "snapping" when on, the check count (§8) and the autosave state. The desktop
 * has no status bar since P2: the save indicator and the course-info popover
 * sit in the top bar (`EditorStatus.tsx`). `lib/editor/status.ts` is the model.
 */

import { useTranslation } from "react-i18next";
import { saveIndicator, statusRows, type SaveState, type StatusInput } from "../../lib/editor/status";

export type { SaveState } from "../../lib/editor/status";

export function StatusBar({ status, save }: { status: Omit<StatusInput, "sheetKey">; save: SaveState }) {
  const { t } = useTranslation("editor");
  const s = saveIndicator(save);
  const rows = statusRows({ ...status, sheetKey: null }, t);
  const kpis = rows.filter((r) => r.id !== "checks").map((r) => r.text);
  return (
    <div data-testid="editor-status" className="pointer-events-auto bg-white/95 backdrop-blur-sm border border-slate-200 rounded-lg shadow-sm px-2.5 py-1 text-[11px] text-slate-600 flex items-center gap-1.5 w-fit max-w-64 whitespace-nowrap">
      {kpis.length > 0 && <span data-testid="editor-status-kpis" className="truncate min-w-0">{kpis.join(" · ")}</span>}
      {status.checks !== null && status.checks > 0 && (
        <span data-testid="editor-status-checks" data-count={status.checks} className="shrink-0 text-amber-700 font-medium">⚠ {t("statusChecks", { count: status.checks })}</span>
      )}
      {kpis.length > 0 && <span className="text-slate-300">·</span>}
      <span data-testid="editor-save-state" data-state={save} className={"shrink-0 " + (s.tone === "alert" ? "text-red-600" : s.tone === "busy" ? "text-slate-400" : "text-emerald-700")}>
        {t(s.key)}
      </span>
    </div>
  );
}
