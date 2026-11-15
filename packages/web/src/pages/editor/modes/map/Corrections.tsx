/**
 * The inspector's *Corrections* list (docs/course-editor.md §13 "Inspector"; docs/map-patches.md §1.4, §2.3): every
 * op of the event's patch in op-id order — a click locates its object, *Revert* removes it — and the
 * *Apply corrections* toggle (`mapPatch.setEnabled`).
 */

import { useTranslation } from "react-i18next";
import { refKey, sameRef, type CorrectionRow, type MapObjectRef } from "./model";

export function CorrectionsList({ rows, selected, enabled, canWrite, busy, onLocate, onRevert, onEnabled }: {
  rows: readonly CorrectionRow[];
  selected: MapObjectRef | null;
  enabled: boolean;
  /** `courses.edit`: revert and the toggle (they stay while the corrections are off). */
  canWrite: boolean;
  /** The toggle's write is in flight. */
  busy: boolean;
  onLocate: (row: CorrectionRow) => void;
  onRevert: (row: CorrectionRow) => void;
  onEnabled: (enabled: boolean) => void;
}) {
  const { t } = useTranslation("editor");
  return (
    <div className="px-2.5 py-2 flex flex-col gap-1.5 text-xs">
      <label className="flex items-center gap-1.5" title={t("correctionsApplyHint")}>
        <input type="checkbox" data-testid="editor-corrections-apply" checked={enabled} disabled={!canWrite || busy}
          onChange={(e) => onEnabled(e.target.checked)} className="cursor-pointer disabled:cursor-not-allowed" />
        <span>{t("correctionsApply")}</span>
        <span data-testid="editor-corrections-count" data-count={rows.length} className="ml-auto text-slate-400">{rows.length}</span>
      </label>
      {rows.length === 0 ? (
        <p data-testid="editor-corrections-none" className="text-[11px] text-slate-500">{t("correctionsNone")}</p>
      ) : (
        <ul className="flex flex-col">
          {rows.map((r) => (
            <li key={r.opId} data-testid="editor-correction-row" data-op-id={r.opId} data-op={r.op} data-ref={refKey(r.ref)} data-issue={r.issue ?? undefined}
              className={`flex items-center gap-1.5 rounded px-1 py-0.5 ${sameRef(r.ref, selected) ? "bg-purple-50" : "hover:bg-slate-50"}`}>
              <button type="button" data-testid="editor-correction-locate" onClick={() => onLocate(r)} disabled={r.label === null}
                className="flex-1 min-w-0 text-left truncate cursor-pointer disabled:cursor-default"
                title={r.issue ? t(`issue_${r.issue}`) : undefined}>
                <span className="text-slate-500">{t(`op_${r.op}`)}</span>{" "}
                <span className={r.label === null ? "text-slate-400 italic" : ""}>{r.label ?? t("correctionMissing")}</span>
                {r.issue && <span className="ml-1 text-amber-700">⚠</span>}
              </button>
              <button type="button" data-testid="editor-correction-revert" disabled={!canWrite} onClick={() => onRevert(r)}
                className="shrink-0 px-1.5 py-0.5 rounded text-[11px] text-slate-600 border border-slate-200 hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer">
                {t("correctionRevert")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
