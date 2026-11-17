/**
 * The inspector's *Map object* section (docs/course-editor.md §13 "Inspector"): the selected document object's
 * symbol (number, name, swatch), *Hide* / *Restore*, *Change symbol* and an orientable point's *Rotation* (G9), and
 * the line and area operations (§13 "Line and area operations", G10): buttons shown when they apply, disabled with
 * the reason as their title.
 */

import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { swatchUrl } from "../../../../lib/editor/symbol-groups";
import { refKey, type MapObjectInfo } from "./model";
import type { ShapeReason } from "./shape-ops";
import { tenthsOf } from "./symbols";

/** One line or area operation's button (`editor-map-object-<id>`, `data-reason`; *Join* / *Cut hole* `aria-pressed`). */
export interface ShapeOpButton {
  id: "reverse" | "split" | "join" | "snap-ends" | "cut-hole" | "remove-hole";
  reason: ShapeReason | null;
  /** A one-shot armed state (*Join*, *Cut hole*): pressed while armed. */
  pressed?: boolean;
  onClick: () => void;
}

/** The rotation field's text for an angle in 0.1°. */
const degrees = (tenths: number): string => String(tenths / 10);


export function MapObjectSection({ info, hidden, documentHash, nameId, canWrite, onHide, onRestore, canChangeSymbol, changing, onChangeSymbol, picker, orientable, onRotate, ops = [] }: {
  info: MapObjectInfo | null;
  hidden: boolean;
  documentHash: string;
  nameId: string;
  /** Hide / Restore are writable now (corrections on, `courses.edit`). */
  canWrite: boolean;
  onHide: () => void;
  onRestore: () => void;
  /** A point, line or area: *Change symbol* is offered (§13 "Symbol picker"). */
  canChangeSymbol: boolean;
  changing: boolean;
  onChangeSymbol: () => void;
  /** The picker, shown under *Change symbol* while it is open. */
  picker: ReactNode;
  /** The effective symbol turns with the angle: *Rotation* is offered. */
  orientable: boolean;
  onRotate: (tenths: number) => void;
  /** The line and area operations that apply to the object (G10). */
  ops?: readonly ShapeOpButton[];
}) {
  const { t } = useTranslation("editor");
  if (!info) return <p data-testid="editor-map-object-none" className="px-2.5 py-2 text-[11px] text-slate-500">{t("mapObjectNone")}</p>;
  const src = swatchUrl(info.swatch, documentHash, nameId);
  return (
    <div data-testid="editor-map-object" data-ref={refKey(info.ref)} data-hidden={hidden ? "true" : "false"} data-symbol={info.symbolIdx}
      className="px-2.5 py-2 flex flex-col gap-2 text-xs">
      <div className="flex items-center gap-2 min-w-0">
        {src
          ? <img data-testid="editor-map-object-swatch" src={src} alt="" className="w-6 h-6 shrink-0 rounded border border-slate-200 bg-white object-contain" />
          : <span data-testid="editor-map-object-swatch" className="w-6 h-6 shrink-0 rounded border border-dashed border-slate-300" />}
        <span data-testid="editor-map-object-symbol" className="truncate" title={`${info.code} ${info.name}`}>
          <span className="font-mono text-slate-500">{info.code}</span> {info.name}
        </span>
        {hidden && <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-amber-700">{t("mapObjectHidden")}</span>}
      </div>
      {hidden ? (
        <button type="button" data-testid="editor-map-object-restore" disabled={!canWrite} onClick={onRestore}
          className="w-fit px-2 py-1 rounded-md border border-slate-200 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer">
          {t("mapRestore")}
        </button>
      ) : (
        <>
          <button type="button" data-testid="editor-map-object-hide" disabled={!canWrite} onClick={onHide}
            className="w-fit px-2 py-1 rounded-md border border-slate-200 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer">
            {t("mapHide")}
          </button>
          {canWrite && <p className="text-[11px] text-slate-500">{t("mapObjectHint")}</p>}
          {canChangeSymbol && (
            <button type="button" data-testid="editor-map-object-change-symbol" aria-expanded={changing} disabled={!canWrite} onClick={onChangeSymbol}
              className={`w-fit px-2 py-1 rounded-md border disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer ${changing ? "border-purple-300 bg-purple-50 text-purple-800" : "border-slate-200 hover:bg-slate-50"}`}>
              {t("mapChangeSymbol")}
            </button>
          )}
          {changing && picker}
          {/* Keyed by the object and its angle: a new selection or a written angle starts the field afresh. */}
          {orientable && <RotationField key={`${refKey(info.ref)}:${info.angle}`} angle={info.angle} disabled={!canWrite} onRotate={onRotate} />}
          {ops.length > 0 && (
            <div data-testid="editor-map-object-ops" className="flex flex-wrap gap-1">
              {ops.map((op) => (
                <button key={op.id} type="button" data-testid={`editor-map-object-${op.id}`} data-reason={op.reason ?? undefined}
                  aria-pressed={op.pressed === undefined ? undefined : op.pressed}
                  title={op.reason ? t(`mapOpReason_${op.reason}`) : undefined}
                  disabled={!canWrite || !!op.reason} onClick={op.onClick}
                  className={`w-fit px-2 py-1 rounded-md border disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer ${op.pressed ? "border-purple-300 bg-purple-50 text-purple-800" : "border-slate-200 hover:bg-slate-50"}`}>
                  {t(`mapOp_${op.id}`)}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** *Rotation* (§13 "Inspector"): degrees; Enter or leaving writes, Escape restores, the current value writes nothing. */
function RotationField({ angle, disabled, onRotate }: { angle: number; disabled: boolean; onRotate: (tenths: number) => void }) {
  const { t } = useTranslation("editor");
  const [text, setText] = useState(degrees(angle));
  const write = () => {
    const v = tenthsOf(text);
    if (v === null || v === angle) { setText(degrees(angle)); return; }
    onRotate(v);
  };
  return (
    <label className="flex items-center gap-2 text-[11px] text-slate-600">
      {t("mapRotation")}
      <input data-testid="editor-map-object-rotation" type="number" step="1" min="0" max="359.9" value={text} disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={write}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); write(); }
          else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setText(degrees(angle)); }
        }}
        className="w-20 px-1.5 py-0.5 border border-slate-200 rounded-md bg-white text-xs disabled:opacity-40" />
    </label>
  );
}
