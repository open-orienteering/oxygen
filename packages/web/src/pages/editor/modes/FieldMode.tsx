/**
 * Field mode and the phone chrome (docs/course-editor.md §9, §10; 08 §5.5):
 *
 * - the GPS watch is `useFieldFix` (the viewer draws the fix and its
 *   accuracy ring);
 * - `FieldSection` — the selected course's controls in course order with
 *   distance and bearing from the fix and a check-off toggle;
 * - `FieldSelection` — the selected control's distance / bearing, check-off
 *   and the nudge pad (±0.1 mm, ±1 m, numeric x / y);
 * - `FieldTopBar`, `AddMenu` — the phone's compact top bar and the floating
 *   `+` that opens the creation tools;
 * - `OfflineNotice` — offline, Field mode views only (§9 "Offline").
 */

import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { NUDGE_FINE_MM, metreStepMm, nudge, type FieldRow, type NudgeDir } from "../../../lib/editor/field";
import type { EditorMode, EditorView } from "../../../lib/editor/state";
import { AREA_CHOICES, type AreaChoice } from "../tools/rail";

type Pt = { x: number; y: number };

/** The fix's state as one line: accuracy, waiting, or why there is none. */
export function FixStatus({ accuracyM, error, watching }: { accuracyM: number | null; error: string | null; watching: boolean }) {
  const { t } = useTranslation("editor");
  const text = accuracyM !== null
    ? t("fieldFixAccuracy", { m: Math.round(accuracyM) })
    : error === "denied" ? t("fieldFixDenied")
      : error ? t("fieldFixUnavailable")
        : watching ? t("fieldFixWaiting") : t("fieldFixOff");
  const state = accuracyM !== null ? "fix" : error === "denied" ? "denied" : error ? "unavailable" : watching ? "waiting" : "off";
  return <span data-testid="editor-field-fix" data-state={state} className="text-slate-500">{text}</span>;
}

const ROW = "min-h-11 w-full flex items-center gap-2 px-2.5 text-left";

/** The control list (§9): course order, distance and bearing from the fix, check-off. */
export function FieldSection({ rows, selectedControlId, onSelectRow, onCheck, canCheck, hasCourse }: {
  rows: FieldRow[];
  selectedControlId: number | null;
  onSelectRow: (id: number) => void;
  onCheck: ((id: number, checked: boolean) => void) | null;
  canCheck: boolean;
  hasCourse: boolean;
}) {
  const { t } = useTranslation("editor");
  if (!hasCourse) return <p className="px-2.5 py-2 text-slate-400" data-testid="editor-field-no-course">{t("fieldNoCourse")}</p>;
  return (
    <ul data-testid="editor-field-list" className="divide-y divide-slate-100">
      {rows.map((r, i) => (
        <li key={`${r.id}-${i}`} data-testid="editor-field-row" data-control-id={r.id} data-kind={r.kind}
          data-distance-m={r.distanceM ?? ""} data-bearing-deg={r.bearingDeg ?? ""} data-checked={r.checked ? "true" : "false"}
          className={`flex items-center ${r.id === selectedControlId ? "bg-purple-50" : ""}`}>
          <button type="button" className={`${ROW} flex-1 min-w-0 cursor-pointer`} onClick={() => onSelectRow(r.id)}>
            <span className="w-10 font-medium text-slate-700 truncate">{r.kind === "control" ? r.code : t(r.kind === "start" ? "kindStart" : "kindFinish")}</span>
            <span className="flex-1 text-slate-600 tabular-nums">{r.distanceM !== null ? t("fieldDistance", { m: r.distanceM }) : "—"}</span>
            <span className="w-12 text-right text-slate-500 tabular-nums">{r.bearingDeg !== null ? `${r.bearingDeg}°` : ""}</span>
          </button>
          {r.kind === "control" && (
            <CheckToggle checked={r.checked} disabled={!onCheck || !canCheck} onChange={(v) => onCheck?.(r.id, v)} testId="editor-field-check" />
          )}
        </li>
      ))}
    </ul>
  );
}

function CheckToggle({ checked, disabled, onChange, testId, label }: { checked: boolean; disabled: boolean; onChange: (v: boolean) => void; testId: string; label?: string }) {
  const { t } = useTranslation("editor");
  return (
    <button type="button" data-testid={testId} aria-pressed={checked} disabled={disabled} title={t("fieldCheck")}
      onClick={() => onChange(!checked)}
      className={`min-h-11 min-w-11 px-2 flex items-center justify-center gap-1.5 rounded-md cursor-pointer disabled:opacity-40 disabled:cursor-default ${checked ? "text-emerald-700" : "text-slate-400"}`}>
      <span aria-hidden className={`w-5 h-5 rounded border flex items-center justify-center text-xs ${checked ? "bg-emerald-600 border-emerald-600 text-white" : "border-slate-300"}`}>{checked ? "✓" : ""}</span>
      {label && <span className="text-xs">{label}</span>}
    </button>
  );
}

/** The selected control in Field mode: distance / bearing from the fix, check-off, the nudge pad (§9). */
export function FieldSelection({ row, pt, mapScale, onNudge, onCheck, canCheck, canMove }: {
  row: FieldRow | null;
  pt: Pt | null;
  mapScale: number | null;
  onNudge: (pt: Pt) => void;
  onCheck: ((checked: boolean) => void) | null;
  canCheck: boolean;
  canMove: boolean;
}) {
  const { t } = useTranslation("editor");
  return (
    <div data-testid="editor-field-selection" className="px-2.5 py-1.5 flex flex-col gap-1.5">
      {row && (
        <div className="flex items-center gap-2">
          <span data-testid="editor-field-selection-distance" data-distance-m={row.distanceM ?? ""} data-bearing-deg={row.bearingDeg ?? ""} className="flex-1 text-slate-600 tabular-nums">
            {row.distanceM !== null ? t("fieldDistanceBearing", { m: row.distanceM, deg: row.bearingDeg }) : t("fieldNoDistance")}
          </span>
          {row.kind === "control" && (
            <CheckToggle checked={row.checked} disabled={!onCheck || !canCheck} onChange={(v) => onCheck?.(v)} testId="editor-field-selection-check" label={t("fieldCheck")} />
          )}
        </div>
      )}
      {pt && <NudgePad pt={pt} mapScale={mapScale} onNudge={onNudge} disabled={!canMove} />}
    </div>
  );
}

const PAD = "min-h-11 min-w-11 rounded-md border border-slate-200 bg-white text-slate-700 flex items-center justify-center cursor-pointer disabled:opacity-40 disabled:cursor-default";
const ARROWS: Record<NudgeDir, string> = { up: "↑", down: "↓", left: "←", right: "→" };

/** ±0.1 mm and ±1 m steps and numeric fields (08 §5.5 "Precision"): each press or commit is one move. */
export function NudgePad({ pt, mapScale, onNudge, disabled }: { pt: Pt; mapScale: number | null; onNudge: (pt: Pt) => void; disabled: boolean }) {
  const { t } = useTranslation("editor");
  const [unit, setUnit] = useState<"mm" | "m">("mm");
  const step = unit === "m" && mapScale ? metreStepMm(mapScale) : NUDGE_FINE_MM;
  // Grid cells of the 3 × 3 pad: up, left, unit, right, down.
  const CELL: Record<NudgeDir, string> = { up: "col-start-2 row-start-1", left: "col-start-1 row-start-2", right: "col-start-3 row-start-2", down: "col-start-2 row-start-3" };
  const arrow = (dir: NudgeDir) => (
    <button type="button" data-testid={`editor-nudge-${dir}-${unit}`} aria-label={t(`nudge_${dir}`, { step: unit === "m" ? "1 m" : "0.1 mm" })}
      disabled={disabled} className={`${PAD} ${CELL[dir]}`} onClick={() => onNudge(nudge(pt, dir, step))}>
      {ARROWS[dir]}
    </button>
  );
  const field = (axis: "x" | "y") => (
    <label className="flex items-center gap-1 text-xs text-slate-500">
      {axis}
      <input data-testid={`editor-nudge-${axis}`} key={`${axis}:${pt[axis]}`} type="number" inputMode="decimal" step={0.1} defaultValue={pt[axis].toFixed(2)} disabled={disabled}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        onBlur={(e) => {
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v) && Math.abs(v - pt[axis]) > 1e-6) onNudge({ ...pt, [axis]: v });
        }}
        className="w-20 min-h-9 px-1.5 border border-slate-200 rounded bg-white text-sm tabular-nums" />
    </label>
  );
  return (
    <div data-testid="editor-nudge-pad" className="flex items-center gap-3">
      <div className="grid grid-cols-[repeat(3,2.75rem)] gap-1">
        {arrow("up")}
        {arrow("left")}
        <button type="button" data-testid="editor-nudge-unit" data-unit={unit} disabled={!mapScale} title={t("nudgeUnit")}
          className={`${PAD} col-start-2 row-start-2 text-xs`} onClick={() => setUnit((u) => (u === "mm" ? "m" : "mm"))}>
          {unit === "m" ? "1 m" : "0.1"}
        </button>
        {arrow("right")}
        {arrow("down")}
      </div>
      <div className="flex flex-col gap-1">{field("x")}{field("y")}</div>
    </div>
  );
}

/** Offline: Field mode views only — no outbox covers its writes (§9 "Offline"). */
export function OfflineNotice() {
  const { t } = useTranslation("editor");
  return (
    <p data-testid="editor-field-offline" role="status" className="pointer-events-auto rounded-md border border-amber-300 bg-amber-50 text-amber-900 text-xs px-2 py-1.5">
      {t("fieldOffline")}
    </p>
  );
}

/** The phone's compact top bar (§10): back, course picker, mode switch, overflow. */
export function FieldTopBar({ backTo, courses, selectedCourseId, onSelectCourse, mode, onMode, overflow }: {
  backTo: string;
  courses: { id: number; name: string }[];
  selectedCourseId: number | null;
  onSelectCourse: (id: number | null) => void;
  mode: EditorMode;
  onMode: (mode: EditorMode) => void;
  overflow: ReactNode;
}) {
  const { t } = useTranslation("editor");
  const segment = (active: boolean) => `min-h-9 px-2.5 text-xs cursor-pointer ${active ? "bg-purple-100 text-purple-700 font-medium" : "text-slate-600"}`;
  return (
    <div className="flex items-center gap-1.5 min-w-0" data-testid="editor-field-top-bar">
      <Link to={backTo} data-testid="editor-back" aria-label={t("back")} className="min-h-9 min-w-9 flex items-center justify-center rounded-md text-slate-600 hover:bg-slate-100">←</Link>
      <select data-testid="editor-course-picker" aria-label={t("course")} value={selectedCourseId ?? ""}
        onChange={(e) => onSelectCourse(e.target.value === "" ? null : Number(e.target.value))}
        className="min-w-0 max-w-[8rem] min-h-9 text-xs border border-slate-200 rounded-md px-1.5 bg-white">
        <option value="">{t("noCourse")}</option>
        {courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <div className="flex rounded-md border border-slate-200 overflow-hidden shrink-0" role="group" aria-label={t("mode")}>
        {(["course", "field"] as const).map((m) => (
          <button key={m} type="button" data-testid={`editor-mode-${m}`} aria-pressed={mode === m} className={segment(mode === m)} onClick={() => onMode(m)}>
            {t(m === "course" ? "modeCourse" : "modeField")}
          </button>
        ))}
      </div>
      {overflow}
    </div>
  );
}

/** The overflow menu's body: what the desktop top bar holds beside the mode switch. */
export function OverflowMenu({ view, onView, canUndo, canRedo, onUndo, onRedo, hideOthers, canHideOthers, onToggleHideOthers, cutsEnabled, cutsBusy, onToggleCuts }: {
  view: EditorView; onView: (v: EditorView) => void;
  canUndo: boolean; canRedo: boolean; onUndo: () => void; onRedo: () => void;
  hideOthers: boolean; canHideOthers: boolean; onToggleHideOthers: () => void;
  cutsEnabled: boolean; cutsBusy: boolean; onToggleCuts: () => void;
}) {
  const { t } = useTranslation("editor");
  const { t: tc } = useTranslation("courses");
  const [open, setOpen] = useState(false);
  const item = (testId: string, label: string, onClick: () => void, opts: { disabled?: boolean; pressed?: boolean; keepOpen?: boolean } = {}) => (
    <button type="button" data-testid={testId} disabled={opts.disabled} aria-pressed={opts.pressed}
      onClick={() => { onClick(); if (!opts.keepOpen) setOpen(false); }}
      className="min-h-11 w-full px-3 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-40 cursor-pointer flex items-center justify-between gap-3">
      <span>{label}</span>
      {opts.pressed !== undefined && <span className={opts.pressed ? "text-purple-700" : "text-slate-300"}>{opts.pressed ? "●" : "○"}</span>}
    </button>
  );
  return (
    <div className="relative ml-auto shrink-0">
      <button type="button" data-testid="editor-overflow" aria-expanded={open} aria-label={t("more")} onClick={() => setOpen((v) => !v)}
        className="min-h-9 min-w-9 rounded-md text-slate-600 hover:bg-slate-100 cursor-pointer text-lg leading-none">⋯</button>
      {open && (
        <div data-testid="editor-overflow-menu" className="absolute right-0 top-full mt-1 z-40 w-56 bg-white rounded-lg border border-slate-200 shadow-lg py-1">
          {item("editor-undo", tc("editor.undo"), onUndo, { disabled: !canUndo })}
          {item("editor-redo", tc("editor.redo"), onRedo, { disabled: !canRedo })}
          {item("editor-view-course", t("viewCourse"), () => onView("course"), { pressed: view === "course" })}
          {item("editor-view-all", t("viewAll"), () => onView("all"), { pressed: view === "all" })}
          {item("editor-hide-others", tc("editor.hideOtherControls"), onToggleHideOthers, { disabled: !canHideOthers, pressed: hideOthers })}
          {item("editor-toggle-cuts", tc("editor.toggleCuts"), onToggleCuts, { disabled: cutsBusy, pressed: cutsEnabled })}
        </div>
      )}
    </div>
  );
}

export type AddChoice = { kind: "place"; tool: "start" | "control" | "finish" } | { kind: "area"; area: AreaChoice } | { kind: "text" };

/** The floating `+` (§10): the creation tools, armed in the pin-drop flow. */
export function AddMenu({ bottomPx, onPick, disabled, canTonerSaver }: { bottomPx: number; onPick: (c: AddChoice) => void; disabled: boolean; canTonerSaver: boolean }) {
  const { t } = useTranslation("editor");
  const [open, setOpen] = useState(false);
  const pick = (c: AddChoice) => { setOpen(false); onPick(c); };
  const item = (testId: string, label: string, c: AddChoice, off = false) => (
    <button key={testId} type="button" data-testid={testId} disabled={off} onClick={() => pick(c)}
      className="min-h-11 w-full px-3 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-40 cursor-pointer">{label}</button>
  );
  return (
    // Left of the viewer's corner buttons (zoom, locate…), which stand above the sheet too.
    <div className="pointer-events-auto absolute right-14 z-30 flex flex-col items-end gap-2" style={{ bottom: bottomPx + 12 }}>
      {open && (
        <div data-testid="editor-add-menu" className="w-60 max-h-[50vh] overflow-y-auto bg-white rounded-lg border border-slate-200 shadow-lg py-1">
          {item("editor-add-K", t("toolControl"), { kind: "place", tool: "control" })}
          {item("editor-add-S", t("toolStart"), { kind: "place", tool: "start" })}
          {item("editor-add-M", t("toolFinish"), { kind: "place", tool: "finish" })}
          {item("editor-add-T", t("toolText"), { kind: "text" })}
          <div className="h-px bg-slate-100 my-1" />
          {AREA_CHOICES.map((a) => item(`editor-area-${a}`, t(`kind_${a}`), { kind: "area", area: a }, a === "toner_saver" && !canTonerSaver))}
        </div>
      )}
      <button type="button" data-testid="editor-field-add" aria-expanded={open} aria-label={t("add")} disabled={disabled} onClick={() => setOpen((v) => !v)}
        className="w-14 h-14 rounded-full bg-purple-600 text-white text-3xl leading-none shadow-lg flex items-center justify-center cursor-pointer disabled:opacity-40">+</button>
    </div>
  );
}
