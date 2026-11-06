/**
 * Course mode's inspector sections (docs/course-editor.md §4): the course
 * (create, clone, visit order, description-sheet instructions) with its sequence — per-leg metres, ↑ / ↓,
 * drag-reorder, remove, inline code edit — and the selection's properties.
 * Presentational: every write is the page's handler.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { iofSymbolName } from "@oxygen/shared";
import type { DisplayRow } from "../../../lib/editor/sequence";
import { FINISH_OPTIONS, SPECIAL_OPTIONS } from "../../../lib/control-description-options";
import {
  addSpecial,
  DEFAULT_FINISH_KIND,
  parseLengthM,
  removeSpecial,
  setFinish,
  updateSpecial,
  type Instructions,
} from "../../../lib/editor/instructions";

export interface CourseSectionProps {
  course: { id: number; name: string; orderMode: "ordered" | "free_order" } | null;
  rows: DisplayRow[];
  legMeters: Array<number | null>;
  totalMeters: number;
  /** Create a course (name suggestions: classes without a course). */
  suggestions: string[];
  onCreate: (name: string) => void;
  onClone: (name: string) => void;
  onOrderMode: (mode: "ordered" | "free_order") => void;
  onMove: (from: number, to: number) => void;
  onRemove: (seqIndex: number) => void;
  onEditCode: (id: number, current: string, next: string) => void;
  onSelectRow: (id: number) => void;
  selectedControlId: number | null;
  radioIds: ReadonlySet<number>;
  /** The course's description instructions as the sheet prints them (specials anchored off the course left out). */
  instructions: Instructions;
  /** One gesture's next value: one `course.update { descriptionInstructions }`, one undo entry (§4). */
  onInstructions: (next: Instructions) => void;
}

export function CourseSection(p: CourseSectionProps) {
  const { t } = useTranslation("courses");
  const { t: te } = useTranslation("editor");
  const [newName, setNewName] = useState("");
  const [cloneName, setCloneName] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ index: number; value: string } | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const ordered = p.course?.orderMode !== "free_order";
  const controls = p.rows.filter((r) => r.kind === "control").length;

  const create = () => {
    const name = newName.trim();
    if (!name) return;
    p.onCreate(name);
    setNewName("");
  };

  return (
    <div className="flex flex-col min-h-0" data-testid="editor-course-section">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5">
        <input
          data-testid="editor-new-course-name"
          value={newName}
          list="editor-new-course-suggestions"
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") create(); }}
          placeholder={t("editor.newCoursePlaceholder")}
          className="flex-1 min-w-0 px-2 py-1 border border-slate-200 rounded-md bg-white text-xs focus:outline-none focus:ring-2 focus:ring-purple-400"
        />
        <datalist id="editor-new-course-suggestions" data-testid="editor-new-course-suggestions">
          {p.suggestions.map((s) => <option key={s} value={s} />)}
        </datalist>
        <button
          type="button"
          data-testid="editor-create-course"
          onClick={create}
          disabled={!newName.trim()}
          className="px-2 py-1 rounded-md bg-purple-600 text-white text-xs disabled:opacity-40 cursor-pointer"
        >
          {t("editor.createCourse")}
        </button>
      </div>
      {!p.course ? (
        <p className="px-2.5 py-2 text-slate-400 border-t border-slate-100">{t("editor.noCourseSelected")}</p>
      ) : (
        <>
          <ol data-testid="editor-sequence" className="min-h-0 overflow-y-auto border-t border-slate-100 py-1">
            {p.rows.map((row, i) => {
              const legM = p.legMeters[i];
              const isControl = row.kind === "control";
              const selected = row.id === p.selectedControlId;
              return (
                <li
                  key={`${row.kind}-${row.id}-${i}`}
                  data-testid="editor-seq-row"
                  data-kind={row.kind}
                  data-control-id={row.id}
                  draggable={isControl && ordered}
                  title={isControl && ordered ? te("dragToReorder") : undefined}
                  onDragStart={() => setDragFrom(row.seqIndex)}
                  onDragOver={(e) => { if (isControl && dragFrom !== null) e.preventDefault(); }}
                  onDrop={() => {
                    if (dragFrom !== null && isControl && dragFrom !== row.seqIndex) p.onMove(dragFrom, row.seqIndex);
                    setDragFrom(null);
                  }}
                  onDragEnd={() => setDragFrom(null)}
                  className={`group flex items-center gap-1.5 px-2.5 py-0.5 ${selected ? "bg-purple-50" : "hover:bg-slate-50"}`}
                >
                  <button type="button" data-testid="editor-seq-select" onClick={() => p.onSelectRow(row.id)}
                    className="w-5 text-right text-slate-400 tabular-nums cursor-pointer hover:text-purple-700">
                    {row.kind === "start" ? "▷" : row.kind === "finish" ? "◎" : ordered ? row.seqIndex + 1 : "·"}
                  </button>
                  {isControl && editing?.index === i ? (
                    <input
                      autoFocus
                      data-testid="editor-seq-code-input"
                      value={editing.value}
                      onChange={(e) => setEditing({ index: i, value: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { p.onEditCode(row.id, row.code, editing.value); setEditing(null); }
                        if (e.key === "Escape") setEditing(null);
                      }}
                      onBlur={() => { p.onEditCode(row.id, row.code, editing.value); setEditing(null); }}
                      className="w-16 px-1 py-0 border border-purple-300 rounded text-xs"
                    />
                  ) : (
                    <button
                      type="button"
                      data-testid={isControl ? "editor-seq-code" : undefined}
                      title={isControl ? t("editor.editCode") : undefined}
                      onClick={() => (isControl ? setEditing({ index: i, value: row.code }) : p.onSelectRow(row.id))}
                      className="font-medium text-slate-700 hover:text-purple-700 cursor-pointer"
                    >
                      {row.code}
                    </button>
                  )}
                  {p.radioIds.has(row.id) && (
                    <span data-testid="editor-radio-badge" className="px-1 rounded-full text-[9px] bg-sky-100 text-sky-800">{t("editor.radioBadge")}</span>
                  )}
                  {ordered && legM != null && <span className="ml-auto text-slate-400 tabular-nums" data-testid="editor-leg-meters">{legM} m</span>}
                  {isControl && (
                    <span className={`flex gap-0.5 ${ordered && legM != null ? "" : "ml-auto"} opacity-60 group-hover:opacity-100`}>
                      {ordered && (
                        <>
                          <button type="button" data-testid="editor-seq-up" title={t("editor.moveUp")} disabled={row.seqIndex === 0}
                            onClick={() => p.onMove(row.seqIndex, row.seqIndex - 1)} className="px-0.5 disabled:opacity-30 cursor-pointer">↑</button>
                          <button type="button" data-testid="editor-seq-down" title={t("editor.moveDown")} disabled={row.seqIndex === controls - 1}
                            onClick={() => p.onMove(row.seqIndex, row.seqIndex + 1)} className="px-0.5 disabled:opacity-30 cursor-pointer">↓</button>
                        </>
                      )}
                      <button type="button" data-testid="editor-seq-remove" title={t("editor.removeFromCourse")}
                        onClick={() => p.onRemove(row.seqIndex)} className="px-0.5 text-red-500 cursor-pointer">✕</button>
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
          <div className="px-2.5 py-1 border-t border-slate-100 text-slate-500 flex gap-2" data-testid="editor-course-total">
            <span>{t("controlCount", { count: controls })}</span>
            {ordered && <span>{(p.totalMeters / 1000).toFixed(1)} km</span>}
          </div>
          <label className="px-2.5 py-1 border-t border-slate-100 text-[11px] text-slate-500 flex items-center gap-2" data-testid="editor-order-mode-row">
            <span>{t("editor.orderMode")}</span>
            <select
              data-testid="editor-order-mode"
              value={p.course.orderMode}
              onChange={(e) => p.onOrderMode(e.target.value as "ordered" | "free_order")}
              className="flex-1 text-xs border border-slate-200 rounded px-1 py-0.5"
            >
              <option value="ordered">{t("orderModeOrdered")}</option>
              <option value="free_order">{t("orderModeFreeOrder")}</option>
            </select>
          </label>
          {!ordered && <p className="px-2.5 text-[10px] text-slate-400 leading-snug" data-testid="editor-free-order-hint">{t("editor.freeOrderHint")}</p>}
          <InstructionsBlock rows={p.rows} ordered={ordered} instructions={p.instructions} onChange={p.onInstructions} />
          <div className="px-2.5 py-1.5 border-t border-slate-100 flex gap-1.5 items-center">
            {cloneName !== null ? (
              <>
                <input
                  data-testid="editor-clone-name"
                  value={cloneName}
                  onChange={(e) => setCloneName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && cloneName.trim()) { p.onClone(cloneName.trim()); setCloneName(null); }
                    if (e.key === "Escape") setCloneName(null);
                  }}
                  placeholder={t("editor.clonePlaceholder")}
                  className="flex-1 min-w-0 px-2 py-1 border border-purple-200 rounded-md bg-white text-xs"
                />
                <button type="button" data-testid="editor-clone-confirm" disabled={!cloneName.trim()}
                  onClick={() => { p.onClone(cloneName.trim()); setCloneName(null); }}
                  className="px-2 py-1 rounded-md bg-purple-600 text-white text-xs disabled:opacity-40 cursor-pointer">
                  {t("editor.cloneConfirm")}
                </button>
              </>
            ) : (
              <button type="button" data-testid="editor-clone-course" onClick={() => setCloneName(`${p.course!.name} (copy)`)}
                className="w-full px-2 py-1 rounded-md border border-purple-200 text-purple-700 hover:bg-purple-50 text-xs cursor-pointer">
                {t("editor.clone")}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * A metres field that writes on blur / Enter when its value changed; blank = unset. Keyed on the stored
 * value by the caller, so a reload (undo, another client) shows the new one.
 */
function LengthInput({ value, onCommit, testId, label, placeholder }: {
  value: number | undefined; onCommit: (m: number | null) => void; testId: string; label: string; placeholder?: string;
}) {
  const commit = (text: string) => {
    const next = parseLengthM(text);
    if (next !== (value ?? null)) onCommit(next);
  };
  return (
    <input
      type="text"
      inputMode="numeric"
      data-testid={testId}
      aria-label={label}
      title={label}
      placeholder={placeholder}
      defaultValue={value ?? ""}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      className="w-14 px-1 py-0.5 border border-slate-200 rounded bg-white text-xs tabular-nums"
    />
  );
}

/**
 * The course's description-sheet instructions (§4): the finish row's variant (14.1–14.3) and length, and
 * the special-instruction rows (13.x) after the start or after a control. Each change is the page's one write.
 */
function InstructionsBlock({ rows, ordered, instructions, onChange }: {
  rows: DisplayRow[]; ordered: boolean; instructions: Instructions; onChange: (next: Instructions) => void;
}) {
  const { t, i18n } = useTranslation("editor");
  const symbol = (key: string) => iofSymbolName(key, i18n.language);
  // Anchors: after the start, or after a control (a control visited twice anchors after every visit, as the sheet does).
  const anchors: { id: number; label: string }[] = [];
  for (const r of rows) {
    if (r.kind === "control" && !anchors.some((a) => a.id === r.id)) anchors.push({ id: r.id, label: ordered ? `${r.seqIndex + 1} · ${r.code}` : r.code });
  }
  const finish = instructions?.finish;
  const specials = instructions?.specials ?? [];
  const select = "min-w-0 px-1 py-0.5 border border-slate-200 rounded bg-white text-xs";
  // Collapsed by default (a summary line), so the sequence above keeps the inspector's height.
  return (
    <details className="group/instr px-2.5 py-1 border-t border-slate-100 text-[11px] text-slate-500" data-testid="editor-description-instructions">
      <summary className="cursor-pointer select-none flex items-center gap-1.5 list-none [&::-webkit-details-marker]:hidden" title={t("instructionsHint")}
        data-testid="editor-instructions-toggle">
        <span className="text-slate-400 transition-transform group-open/instr:rotate-90">▸</span>
        <span>{t("instructions")}</span>
        <span className="ml-auto text-slate-400 tabular-nums" data-testid="editor-instructions-summary">
          {finish?.kind ?? DEFAULT_FINISH_KIND}{specials.length > 0 ? ` · ${t("specialCount", { count: specials.length })}` : ""}
        </span>
      </summary>
      <div className="space-y-1 pt-1">
        <div className="flex items-center gap-1.5">
          <span className="w-12 shrink-0">{t("finishVariant")}</span>
          <select
            data-testid="editor-finish-kind"
            value={finish?.kind ?? DEFAULT_FINISH_KIND}
            onChange={(e) => onChange(setFinish(instructions, { kind: e.target.value }))}
            className={`flex-1 ${select}`}
          >
            {FINISH_OPTIONS.map((o) => <option key={o.iof} value={o.iof}>{o.iof} {symbol(o.iof)}</option>)}
          </select>
          <LengthInput
            key={`finish:${finish?.lengthM ?? ""}`}
            testId="editor-finish-length"
            label={t("finishLength")}
            placeholder={t("lengthMeasured")}
            value={finish?.lengthM}
            onCommit={(m) => onChange(setFinish(instructions, { lengthM: m }))}
          />
        </div>
        {specials.map((s, i) => (
          <div key={i} className="flex items-center gap-1.5" data-testid="editor-special-row" data-index={i} data-kind={s.kind} data-after={s.afterControlId ?? ""}>
            <select
              data-testid="editor-special-after"
              aria-label={t("specialAfter")}
              title={t("specialAfter")}
              value={s.afterControlId ?? ""}
              onChange={(e) => onChange(updateSpecial(instructions, i, { afterControlId: e.target.value === "" ? null : Number(e.target.value) }))}
              className={`w-16 shrink-0 ${select}`}
            >
              <option value="">{t("specialAfterStart")}</option>
              {anchors.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
            <select
              data-testid="editor-special-kind"
              aria-label={t("specialKind")}
              value={s.kind}
              onChange={(e) => onChange(updateSpecial(instructions, i, { kind: e.target.value }))}
              className={`flex-1 ${select}`}
            >
              {SPECIAL_OPTIONS.map((o) => <option key={o.iof} value={o.iof}>{o.iof} {symbol(o.iof)}</option>)}
            </select>
            <LengthInput
              key={`special:${i}:${s.lengthM ?? ""}`}
              testId="editor-special-length"
              label={t("specialLength")}
              value={s.lengthM}
              onCommit={(m) => onChange(updateSpecial(instructions, i, { lengthM: m }))}
            />
            <button type="button" data-testid="editor-special-remove" title={t("removeSpecial")} aria-label={t("removeSpecial")}
              onClick={() => onChange(removeSpecial(instructions, i))} className="px-0.5 text-red-500 cursor-pointer">✕</button>
          </div>
        ))}
        <button type="button" data-testid="editor-add-special" onClick={() => onChange(addSpecial(instructions, null))}
          className="text-purple-700 hover:underline cursor-pointer">
          + {t("addSpecial")}
        </button>
      </div>
    </details>
  );
}

export interface SelectionSectionProps {
  selected: {
    code: string;
    role: "start" | "finish" | "control";
    x: number;
    y: number;
    description: string | null;
    alsoIn: string[];
    badges: { label: string; testId: string; title?: string }[];
    notes: string;
    /** On the selected course: whether its number is hidden there (`numberHidden`); null when not on it. */
    numberHidden: boolean | null;
  } | null;
  /** Site kind (08 §4.2); the slice-F kinds are listed disabled. */
  onKind?: (kind: "control" | "start" | "finish") => void;
  onNotes?: (notes: string) => void;
  onNumberHidden?: (hidden: boolean) => void;
}

const SLICE_F_KINDS = ["map_exchange", "crossing_point", "map_issue"] as const;

export function SelectionSection({ selected, onKind, onNotes, onNumberHidden }: SelectionSectionProps) {
  const { t } = useTranslation("editor");
  // Optimistic: the box flips at once; the stored value takes over when it changes.
  const [pendingHidden, setPendingHidden] = useState<{ key: string; value: boolean } | null>(null);
  if (!selected) return <p className="px-2.5 py-2 text-slate-400">{t("nothingSelected")}</p>;
  const hiddenKey = `${selected.code}:${selected.numberHidden}`;
  const numberHidden = pendingHidden?.key === hiddenKey ? pendingHidden.value : selected.numberHidden;
  return (
    <dl className="px-2.5 py-1.5 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5" data-testid="editor-selection">
      <dt className="text-slate-400">{t("codes")}</dt>
      <dd data-testid="editor-selected-code" className="font-medium text-slate-700 flex gap-1 items-center">
        {selected.code}
        {selected.badges.map((b) => (
          <span key={b.testId} data-testid={b.testId} title={b.title} className="px-1 rounded-full text-[9px] bg-amber-100 text-amber-800">{b.label}</span>
        ))}
      </dd>
      <dt className="text-slate-400">{t("kind")}</dt>
      <dd>
        <select data-testid="editor-selected-kind" value={selected.role} disabled={!onKind}
          onChange={(e) => onKind?.(e.target.value as "control" | "start" | "finish")}
          className="w-full px-1 py-0.5 border border-slate-200 rounded bg-white text-xs">
          <option value="control">{t("kindControl")}</option>
          <option value="start">{t("kindStart")}</option>
          <option value="finish">{t("kindFinish")}</option>
          {SLICE_F_KINDS.map((k) => <option key={k} value={k} disabled>{t(`kind_${k}`)} — {t("sliceF")}</option>)}
        </select>
      </dd>
      <dt className="text-slate-400 sr-only">x / y</dt>
      <dd className="col-span-2 text-slate-500" data-testid="editor-selected-position">{t("position", { x: selected.x.toFixed(1), y: selected.y.toFixed(1) })}</dd>
      <dt className="text-slate-400">{t("description")}</dt>
      <dd className="text-slate-600" data-testid="editor-selected-description">{selected.description ?? t("noDescription")}</dd>
      {selected.alsoIn.length > 0 && (
        <>
          <dt className="text-slate-400">{t("alsoIn")}</dt>
          <dd className="text-slate-600" data-testid="editor-selected-also-in">{selected.alsoIn.join(", ")}</dd>
        </>
      )}
      {selected.numberHidden !== null && selected.role === "control" && (
        <dd className="col-span-2">
          <label className="flex items-center gap-1.5 text-slate-600">
            <input type="checkbox" data-testid="editor-number-hidden" checked={!!numberHidden} disabled={!onNumberHidden}
              onChange={(e) => { setPendingHidden({ key: hiddenKey, value: e.target.checked }); onNumberHidden?.(e.target.checked); }} />
            {t("numberHidden")}
          </label>
        </dd>
      )}
      <dt className="text-slate-400">{t("notes")}</dt>
      <dd>
        <textarea data-testid="editor-selected-notes" key={`${selected.code}:${selected.notes}`} defaultValue={selected.notes} rows={2} disabled={!onNotes}
          onBlur={(e) => { if (e.target.value !== selected.notes) onNotes?.(e.target.value); }}
          className="w-full px-1 py-0.5 border border-slate-200 rounded bg-white text-xs resize-y" />
      </dd>
    </dl>
  );
}

/** Several controls selected (Shift-click, lasso; §6.5): the bulk actions. */
export function MultiSection({ count, course, onDelete, onAddToCourse, onRadio, busy }: {
  count: number; course: string | null; onDelete: () => void; onAddToCourse: () => void; onRadio: () => void; busy: boolean;
}) {
  const { t } = useTranslation("editor");
  const btn = "w-full px-2 py-1 rounded-md border text-xs cursor-pointer disabled:opacity-40";
  return (
    <div data-testid="editor-multi" data-count={count} className="px-2.5 py-1.5 space-y-1">
      <p className="text-slate-600">{t("multiSelected", { count })}</p>
      {course && (
        <button type="button" data-testid="editor-bulk-add-to-course" disabled={busy} onClick={onAddToCourse} className={`${btn} border-purple-200 text-purple-700 hover:bg-purple-50`}>
          {t("bulkAddToCourse", { count, name: course })}
        </button>
      )}
      <button type="button" data-testid="editor-bulk-radio" disabled={busy} onClick={onRadio} className={`${btn} border-slate-200 text-slate-700 hover:bg-slate-50`}>
        {t("bulkRadio", { count })}
      </button>
      <button type="button" data-testid="editor-bulk-delete" disabled={busy} onClick={onDelete} className={`${btn} border-red-200 text-red-600 hover:bg-red-50`}>
        {t("bulkDelete", { count })}
      </button>
    </div>
  );
}
