/**
 * The inspector's *Corrections* list (docs/course-editor.md §13 "Inspector"; docs/map-patches.md §1.4, §2.3): every
 * op of the event's patch in op-id order — a click locates its object, *Revert* removes it — and the
 * *Apply corrections* toggle (`mapPatch.setEnabled`).
 *
 * Under it, the corrections the pin move could not carry over (§13 "Unresolved"; map-patches §4, rows G11, G12b): the
 * patch's `unresolved` entries — a click centres the view on the entry's old place, *Attach* puts it onto the selected
 * object or, for a `symbol` entry, opens the palette for a symbol, *Drop* removes it. Presentational: the writes, their
 * undo entries and the interlock are Map mode's (`modes/MapMode.tsx`).
 */

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { refKey, sameRef, type CorrectionRow, type MapObjectRef } from "./model";
import type { UnresolvedRow } from "./unresolved";

export interface UnresolvedProps {
  rows: readonly UnresolvedRow[];
  /** The selected document object's `sourceIndex` (an object entry's *Attach* needs one). */
  source: number | null;
  /** `courses.edit`, *Apply corrections* on, no promote running (attach is a hide-like gesture). */
  canAttach: boolean;
  /** `courses.edit`, no promote running (drop stays while the corrections are off, as *Revert*). */
  canDrop: boolean;
  /** The entry whose palette is open (a `symbol` entry's *Attach*), and the palette shown under it. */
  attaching: string | null;
  picker: ReactNode;
  onLocate: (row: UnresolvedRow) => void;
  onAttach: (row: UnresolvedRow) => void;
  onDrop: (row: UnresolvedRow) => void;
}

export function CorrectionsList({ rows, selected, enabled, canWrite, busy, onLocate, onRevert, onEnabled, unresolved }: {
  rows: readonly CorrectionRow[];
  selected: MapObjectRef | null;
  enabled: boolean;
  /** `courses.edit` and no promote running: revert and the toggle (they stay while the corrections are off). */
  canWrite: boolean;
  /** The toggle's write is in flight. */
  busy: boolean;
  onLocate: (row: CorrectionRow) => void;
  onRevert: (row: CorrectionRow) => void;
  onEnabled: (enabled: boolean) => void;
  unresolved: UnresolvedProps;
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
                className={BUTTON}>
                {t("correctionRevert")}
              </button>
            </li>
          ))}
        </ul>
      )}
      <UnresolvedCorrections {...unresolved} />
    </div>
  );
}

const BUTTON = "shrink-0 px-1.5 py-0.5 rounded text-[11px] text-slate-600 border border-slate-200 hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer";

/** *Corrections* → *Not carried over* (§13 "Unresolved"): absent while the patch has none. */
function UnresolvedCorrections({ rows, source, canAttach, canDrop, attaching, picker, onLocate, onAttach, onDrop }: UnresolvedProps) {
  const { t } = useTranslation("editor");
  if (rows.length === 0) return null;
  return (
    <div data-testid="editor-corrections-unresolved" data-count={rows.length} className="mt-1 pt-1.5 border-t border-slate-100 flex flex-col gap-1">
      <div className="flex items-center gap-1.5" title={t("correctionsUnresolvedHint")}>
        <span className="font-medium text-amber-800">{t("correctionsUnresolved")}</span>
        <span className="ml-auto text-slate-400">{rows.length}</span>
      </div>
      <ul className="flex flex-col">
        {rows.map((r) => {
          const { key, entry: e } = r;
          const bySymbol = r.attach === "symbol";
          const attachTitle = bySymbol ? t("correctionAttachSymbol") : source === null ? t("correctionAttachNeedsSelection") : t("correctionAttachHint");
          const open = attaching === key;
          return (
            <li key={key} data-testid="editor-correction-unresolved" data-key={key} data-op={e.op.op} data-reason={e.reason}
              className={`flex flex-col rounded px-1 py-0.5 ${open ? "bg-purple-50" : "hover:bg-slate-50"}`}>
              <div className="flex items-center gap-1.5">
                <button type="button" data-testid="editor-correction-unresolved-locate" onClick={() => onLocate(r)} disabled={r.centre === null}
                  className="flex-1 min-w-0 text-left truncate cursor-pointer disabled:cursor-default" title={t("correctionsUnresolvedHint")}>
                  <span className="text-slate-500">{t(`op_${e.op.op}`)}</span>{" "}
                  <span>{r.label}</span>{" "}
                  <span className="text-amber-700">· {t(`unresolved_${e.reason}`)}</span>
                </button>
                <button type="button" data-testid="editor-correction-attach" title={attachTitle} aria-expanded={bySymbol ? open : undefined}
                  disabled={!canAttach || (!bySymbol && source === null)}
                  onClick={() => onAttach(r)}
                  className={BUTTON}>
                  {t("correctionAttach")}
                </button>
                <button type="button" data-testid="editor-correction-drop" disabled={!canDrop} onClick={() => onDrop(r)}
                  className={BUTTON}>
                  {t("correctionDrop")}
                </button>
              </div>
              {open && picker}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
