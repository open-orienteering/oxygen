/**
 * Setter maps in the editor (docs/course-layout.md §8, docs/course-editor.md
 * §9; research 08 §4.6, §5.5): which scope Layout mode's *Setter maps*
 * section generates for, the scope's setter sheets in setter order, the
 * *next* setter of *Move to next setter* (wrapping), and the Field-mode
 * list of a setter's controls.
 */

import type { EditorView } from "./state";
import type { FieldRowInput } from "./field";

type Pt = { x: number; y: number };

/** A `courseMap.list` row as these helpers read it. */
export interface SetterSheetRow {
  seq: number;
  name: string;
  kind: string;
  /** The sheet's course (seq); null for the event's setter maps. */
  courseId: number | null;
  sortOrder: number;
  setter: { index: number; controls: number[] } | null;
}

/** The scope *Setter maps* generates for: the event in view All or without a course, else the top bar's course (its seq). */
export function setterScopeOf(view: EditorView, course: { id: number } | null): number | null {
  return view === "all" || !course ? null : course.id;
}

/** The scope's setter sheets, by setter number (then seq). */
export function setterSheetsOf<T extends SetterSheetRow>(rows: readonly T[], scope: number | null): T[] {
  return rows
    .filter((r) => r.kind === "setter" && r.setter !== null && r.courseId === scope)
    .sort((a, b) => a.setter!.index - b.setter!.index || a.seq - b.seq);
}

/** Every setter sheet of the event, the event's first, then by course and setter number (the Field picker). */
export function allSetterSheets<T extends SetterSheetRow>(rows: readonly T[]): T[] {
  return rows
    .filter((r) => r.kind === "setter" && r.setter !== null)
    .sort((a, b) => (a.courseId ?? 0) - (b.courseId ?? 0) || a.setter!.index - b.setter!.index || a.seq - b.seq);
}

/** *Move to next setter*: the sheet after `currentSeq` among `sheets` (setter order), the last one's next is the first; null with fewer than two. */
export function nextSetterSheet<T extends { seq: number }>(sheets: readonly T[], currentSeq: number): T | null {
  if (sheets.length < 2) return null;
  const at = sheets.findIndex((s) => s.seq === currentSeq);
  return at < 0 ? null : sheets[(at + 1) % sheets.length];
}

/** What the Field list reads of a control (`control.list` / `course.controlCoordinates`, by public id). */
export interface FieldControlInfo {
  code: string;
  kind: string;
  pt: Pt | null;
}

/**
 * A setter's controls as Field-mode rows (course-editor.md §9): in the
 * sheet's code order; start and finish as such, every other kind (a
 * control, an exchange, a crossing or map-issue point) a control row the
 * setter checks off. A control the editor no longer knows is left out.
 */
export function setterRowInputs(controls: readonly number[], info: ReadonlyMap<number, FieldControlInfo>): FieldRowInput[] {
  return controls.flatMap((id) => {
    const c = info.get(id);
    if (!c) return [];
    const kind: FieldRowInput["kind"] = c.kind === "start" || c.kind === "finish" ? c.kind : "control";
    return [{ id, code: c.code, kind, pt: c.pt }];
  });
}
