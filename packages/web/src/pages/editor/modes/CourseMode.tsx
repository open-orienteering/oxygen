/**
 * Course mode's inspector sections (docs/course-editor.md §4): the course
 * (create, clone, visit order) with its sequence — per-leg metres, ↑ / ↓,
 * drag-reorder, remove, inline code edit — and the selection's properties.
 * Presentational: every write is the page's handler.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { DisplayRow } from "../../../lib/editor/sequence";

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

export interface SelectionSectionProps {
  selected: {
    code: string;
    role: "start" | "finish" | "control";
    x: number;
    y: number;
    description: string | null;
    alsoIn: string[];
    badges: { label: string; testId: string; title?: string }[];
  } | null;
}

export function SelectionSection({ selected }: SelectionSectionProps) {
  const { t } = useTranslation("editor");
  if (!selected) return <p className="px-2.5 py-2 text-slate-400">{t("nothingSelected")}</p>;
  const kind = { start: t("kindStart"), finish: t("kindFinish"), control: t("kindControl") }[selected.role];
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
      <dd>{kind}</dd>
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
    </dl>
  );
}
