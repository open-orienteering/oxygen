/**
 * The editor's notices and the D6 undo guard's page side (docs/course-editor.md §3 "Conflicts", "Undo after another
 * editor's change"): which notice a successful write clears (CRS-065), and which undo entries a skipped undo drops.
 * Pure, so the rules are unit-tested without the page.
 */

import type { WrittenRow } from "./write-client";

type Pt = { x: number; y: number };

/** A row a notice is about (`kind:id`, as the write client keys them). */
export interface NoticeRow {
  kind: string;
  id: number;
}

export type EditorNotice =
  /** A write was refused as stale: reload, redo the edit. `row`: the row it was about, when known. */
  | { kind: "refresh"; items: string[] | null; row?: NoticeRow }
  | {
    kind: "moved"; controlId: number; mine: Pt; theirs: Pt | null; by?: { name: string; at: string } | null;
    /** A queued Field-mode write that met a move elsewhere on replay (D9c): its outbox entry, which the buttons settle. */
    queueSeq?: number;
  }
  /** An undo or redo refused under D6: the row was changed elsewhere since. `name`: the course's name or control's code. */
  | { kind: "undoSkipped"; row: NoticeRow; name: string | null; by?: { name: string; at: string } | null; step?: "undo" | "redo" };

const sameRow = (a: NoticeRow, b: NoticeRow) => a.kind === b.kind && a.id === b.id;

/**
 * Whether a write that succeeded clears the notice shown (CRS-065): only a write about the notice's own row does.
 * A `refresh` goes with a write of its row (a notice without a row, with any write); a `moved` notice waits for its
 * answer — Keep mine, Keep theirs, or a new move of that control (`move`); a queued one goes with its outbox entry;
 * an `undoSkipped` notice stays until dismissed.
 */
export function clearsNotice(notice: EditorNotice | null, wrote: readonly WrittenRow[], move?: { controlId: number }): boolean {
  if (!notice) return false;
  switch (notice.kind) {
    case "refresh":
      return !notice.row || wrote.some((r) => sameRow(r, notice.row!));
    case "moved":
      return notice.queueSeq === undefined && move?.controlId === notice.controlId;
    case "undoSkipped":
      return false;
  }
}

/** The undo entries a skipped undo of `row` drops (D6): every entry, in either branch, that wrote the row. */
export function writesRow(entry: { rows?: readonly NoticeRow[] }, row: NoticeRow): boolean {
  return !!entry.rows?.some((r) => sameRow(r, row));
}

/** A course row of `course.list` as the created-control check reads it (ids are public seqs). */
export interface ListedCourse {
  id: number;
  version: string;
  controls: string;
  startControlId?: number | null;
  finishControlId?: number | null;
  parentCourseId?: number | null;
}

/**
 * D6's created-control rule (docs/course-editor.md §3): the undo of a control this client created deletes it, and the
 * delete cascades out of every course visiting it, so the undo is skipped when a course other than the entry's own
 * visits it now. A row of the last polled list counts unless it is stale behind this client's newer token (`book`
 * holds another token: this client wrote the course since, an undo a moment ago included). A variant (F7) is judged
 * by its root, which the server writes it with: a variant of the entry's own course is not another course, and a
 * variant is not read while its root's row is stale. @returns the course that blocks the undo, if any.
 */
export function createdControlElsewhere(
  courses: readonly ListedCourse[],
  controlId: number,
  courseId: number | null,
  book: (courseId: number) => string | undefined,
): ListedCourse | undefined {
  const byId = new Map(courses.map((c) => [c.id, c]));
  const stale = (c: ListedCourse) => { const v = book(c.id); return v !== undefined && v !== c.version; };
  return courses.find((c) => {
    if (c.id === courseId) return false;
    const visits = c.controls.split(";").filter(Boolean).map(Number).includes(controlId) || c.startControlId === controlId || c.finishControlId === controlId;
    if (!visits || stale(c)) return false;
    if (c.parentCourseId != null) {
      if (c.parentCourseId === courseId) return false;
      const root = byId.get(c.parentCourseId);
      if (root && stale(root)) return false;
    }
    return true;
  });
}
