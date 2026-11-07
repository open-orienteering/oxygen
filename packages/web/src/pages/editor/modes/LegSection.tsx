/**
 * The inspector's *Leg* section (docs/course-editor.md §6.7; 08 §5.2
 * "leg: style, gaps, corridor, crossing"): the selected leg's style, its
 * bends and its corridor. Every change is one patch of the item's
 * `LegProps` (`setLegProps`), one `setStructure`, one undo entry; the page
 * writes. Invalid numbers are not written. On a phone the section is
 * read-only and says so (08 §5.5 "desktop-only by design").
 */

import { useTranslation } from "react-i18next";
import type { course } from "@oxygen/shared";
import type { LegPatch } from "../../../lib/editor/structure-edit";

type LegProps = course.LegProps;
type Corridor = NonNullable<LegProps["corridor"]>;

/** *Add corridor* and the `A` menu's *Corridor on selected leg*: a band visible at once (decision log, F3). */
export const DEFAULT_CORRIDOR: Corridor = { widthM: 50, edge: true, whiteMm: 5, whiteOpacity: 1 };

const FIELD = "mt-0.5 w-full px-1.5 py-1 rounded-md border border-slate-200 bg-white text-xs disabled:bg-slate-50 disabled:text-slate-400";
const BUTTON = "px-2 py-0.5 rounded-md border text-xs cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed";

export interface LegSectionProps {
  /** "31 → 32": the leg's ends by code. */
  title: string;
  leg: LegProps;
  focusedBend: number | null;
  /** A phone: everything shown, nothing editable. */
  readOnly: boolean;
  onPatch: (patch: LegPatch) => void;
  onFocusBend: (index: number | null) => void;
}

/** A number field committed on blur (or Enter) when `valid`; otherwise the stored value comes back. */
function NumberField(p: { testId: string; label: string; value: number; step: number; min?: number; max?: number; disabled: boolean; valid: (v: number) => boolean; onCommit: (v: number) => void }) {
  return (
    <label className="block text-[11px] text-slate-500">{p.label}
      <input data-testid={p.testId} type="number" step={p.step} min={p.min} max={p.max} className={FIELD} disabled={p.disabled}
        defaultValue={p.value} key={p.value}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        onBlur={(e) => {
          const v = Number(e.target.value);
          if (e.target.value.trim() !== "" && Number.isFinite(v) && p.valid(v)) { if (v !== p.value) p.onCommit(v); }
          else e.target.value = String(p.value);
        }} />
    </label>
  );
}

export function LegSection(p: LegSectionProps) {
  const { t } = useTranslation("editor");
  const { leg, readOnly } = p;
  const bends = leg.bends ?? [];
  const corridor = leg.corridor;
  const setCorridor = (next: Partial<Corridor>) => { if (corridor) p.onPatch({ corridor: { ...corridor, ...next } }); };
  return (
    <div data-testid="editor-leg" data-readonly={readOnly ? "true" : "false"} className="px-2.5 py-1.5 space-y-2">
      <div className="font-medium text-slate-700">{t("legTitle", { leg: p.title })}</div>
      {readOnly && <p data-testid="editor-leg-readonly" className="text-[11px] text-amber-700">{t("legReadOnly")}</p>}

      <label className="block text-[11px] text-slate-500">{t("legStyle")}
        <select data-testid="editor-leg-style" className={FIELD} disabled={readOnly} value={leg.style ?? "line"}
          onChange={(e) => p.onPatch({ style: e.target.value as NonNullable<LegProps["style"]> })}>
          <option value="line">{t("legStyleLine")}</option>
          <option value="marked_route">{t("legStyleMarkedRoute")}</option>
          <option value="none">{t("legStyleNone")}</option>
        </select>
      </label>

      <div>
        <div className="text-[11px] text-slate-500">{t("legBends")}</div>
        {bends.length === 0 ? (
          <p data-testid="editor-leg-bends-empty" className="text-[11px] text-slate-400">{t("legBendsNone")}</p>
        ) : (
          <ul className="space-y-0.5">
            {bends.map((b, i) => (
              <li key={i} data-testid="editor-leg-bend" data-index={i} data-x={b.x} data-y={b.y} data-focused={p.focusedBend === i ? "true" : "false"}
                className={`flex items-center gap-1.5 rounded px-1 ${p.focusedBend === i ? "bg-purple-50" : ""}`}>
                <button type="button" className="flex-1 text-left font-mono text-[11px] text-slate-600 cursor-pointer" onClick={() => p.onFocusBend(i)}>
                  {i + 1}. {b.x.toFixed(1)}, {b.y.toFixed(1)} mm
                </button>
                <button type="button" data-testid="editor-leg-bend-remove" aria-label={t("legBendRemove")} title={t("legBendRemove")} disabled={readOnly}
                  onClick={() => p.onPatch({ bends: bends.filter((_, k) => k !== i) })}
                  className="px-1 text-slate-400 hover:text-red-600 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">✕</button>
              </li>
            ))}
          </ul>
        )}
        {!readOnly && <p className="text-[10px] text-slate-400">{t("legBendsHint")}</p>}
      </div>

      <div data-testid="editor-leg-corridor" className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-slate-500">{t("legCorridor")}</span>
          {corridor ? (
            <button type="button" data-testid="editor-leg-corridor-remove" disabled={readOnly} onClick={() => p.onPatch({ corridor: undefined })}
              className={`${BUTTON} ml-auto border-red-200 text-red-600 hover:bg-red-50`}>{t("legCorridorRemove")}</button>
          ) : (
            <button type="button" data-testid="editor-leg-corridor-add" disabled={readOnly} onClick={() => p.onPatch({ corridor: DEFAULT_CORRIDOR })}
              className={`${BUTTON} ml-auto border-purple-200 text-purple-700 hover:bg-purple-50`}>{t("legCorridorAdd")}</button>
          )}
        </div>
        {corridor && (
          <div className="grid grid-cols-2 gap-x-2 gap-y-1">
            <NumberField testId="editor-leg-corridor-width" label={t("legCorridorWidth")} value={corridor.widthM} step={5} min={0} disabled={readOnly}
              valid={(v) => v > 0} onCommit={(widthM) => setCorridor({ widthM })} />
            <NumberField testId="editor-leg-corridor-white" label={t("legCorridorWhite")} value={corridor.whiteMm} step={0.5} min={0} disabled={readOnly}
              valid={(v) => v >= 0} onCommit={(whiteMm) => setCorridor({ whiteMm })} />
            <NumberField testId="editor-leg-corridor-opacity" label={t("legCorridorOpacity")} value={corridor.whiteOpacity} step={0.1} min={0} max={1} disabled={readOnly}
              valid={(v) => v >= 0 && v <= 1} onCommit={(whiteOpacity) => setCorridor({ whiteOpacity })} />
            <label className="flex items-end gap-1.5 pb-1 text-[11px] text-slate-500">
              <input data-testid="editor-leg-corridor-edge" type="checkbox" checked={corridor.edge} disabled={readOnly}
                onChange={(e) => setCorridor({ edge: e.target.checked })} />
              {t("legCorridorEdge")}
            </label>
            <p className="col-span-2 text-[10px] text-slate-400">{t("legCorridorOpacityHint")}</p>
          </div>
        )}
      </div>
    </div>
  );
}
