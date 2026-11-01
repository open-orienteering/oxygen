/**
 * The armed creation tools' chain (docs/course-editor.md §6.1; 08 §5.3
 * "Placement flow"): `S` / `K` / `M` stay armed, every click places one
 * site at the insertion point, which then advances. Pure: the page keeps
 * the state and performs the writes; this module decides where the next
 * site goes, what the ghost says and how the chain moves.
 *
 * Positions are control-sequence positions (`structure-edit.ts`). Without
 * a selected course the tools only create sites: no insertion point, no
 * pending leg, no number.
 */

import type { DisplayRow } from "../../../lib/editor/sequence";

type Pt = { x: number; y: number };

export type PlacementTool = "start" | "control" | "finish";

export interface PlacementState {
  tool: PlacementTool;
  /** Control-sequence position the next control goes to; null without a course. */
  insertAt: number | null;
  /** The site the pending leg starts from (the last one placed, or the one before the insertion point). */
  anchorId: number | null;
  /** The chain so far, newest last: what `Ctrl+Z` while armed steps back over. */
  placed: { id: number; insertAt: number | null; anchorId: number | null }[];
}

/** What was selected when the tool was armed: a control on the course, or a leg's insert position. */
export interface ArmContext {
  rows: readonly DisplayRow[];
  /** A course is selected (and its structure loaded). */
  course: boolean;
  selectedControlId: number | null;
  /** A leg click's insert position (the phantom's), when armed from a leg. */
  legInsertAt: number | null;
}

const controlRows = (rows: readonly DisplayRow[]) => rows.filter((r) => r.kind === "control");

/** The row the leg into control-sequence position `at` starts from: the control before it, else the start. */
function rowBefore(rows: readonly DisplayRow[], at: number): DisplayRow | null {
  const controls = controlRows(rows);
  if (at > 0 && controls[at - 1]) return controls[at - 1];
  return rows.find((r) => r.kind === "start") ?? null;
}

/** The row a control placed at `at` leads into: the control there, else the finish. */
export function rowAfter(rows: readonly DisplayRow[], at: number): DisplayRow | null {
  const controls = controlRows(rows);
  return controls[at] ?? rows.find((r) => r.kind === "finish") ?? null;
}

/**
 * Arm a tool. The insertion point is the control selected when it was
 * armed (after its first visit), or the leg (its insert position),
 * otherwise the item before the finish (08 §5.3). `S` anchors at the
 * course's start (position 0).
 */
export function armPlacement(tool: PlacementTool, ctx: ArmContext): PlacementState {
  if (!ctx.course) return { tool, insertAt: null, anchorId: null, placed: [] };
  const controls = controlRows(ctx.rows);
  let insertAt = controls.length;
  if (tool === "start") insertAt = 0;
  else if (ctx.legInsertAt !== null) insertAt = Math.max(0, Math.min(ctx.legInsertAt, controls.length));
  else if (ctx.selectedControlId !== null) {
    const at = controls.findIndex((r) => r.id === ctx.selectedControlId);
    if (at >= 0) insertAt = at + 1;
    else if (ctx.rows.find((r) => r.kind === "start")?.id === ctx.selectedControlId) insertAt = 0;
  }
  return { tool, insertAt, anchorId: rowBefore(ctx.rows, insertAt)?.id ?? null, placed: [] };
}

/** Switch the armed tool keeping the chain (`S` → `K` …); `S` re-anchors at the start. */
export function switchTool(s: PlacementState, tool: PlacementTool, ctx: ArmContext): PlacementState {
  if (tool === "start") return { ...armPlacement("start", ctx), placed: s.placed };
  return { ...s, tool };
}

/**
 * After a site was placed (new or reused). A control advances the
 * insertion point and becomes the anchor; a start re-anchors the chain at
 * position 0; a finish ends it (the caller returns to `V`).
 */
export function afterPlaced(s: PlacementState, id: number): PlacementState {
  const entry = { id, insertAt: s.insertAt, anchorId: s.anchorId };
  if (s.tool === "control") {
    return { ...s, insertAt: s.insertAt === null ? null : s.insertAt + 1, anchorId: s.insertAt === null ? null : id, placed: [...s.placed, entry] };
  }
  if (s.tool === "start") {
    return { ...s, tool: "control", insertAt: s.insertAt === null ? null : 0, anchorId: s.insertAt === null ? null : id, placed: [...s.placed, entry] };
  }
  return { ...s, placed: [...s.placed, entry] };
}

/** `Ctrl+Z` while armed: the last placement is undone, the anchor and insertion point go back with it. */
export function afterUndo(s: PlacementState): PlacementState {
  const last = s.placed[s.placed.length - 1];
  if (!last) return s;
  return { ...s, insertAt: last.insertAt, anchorId: last.anchorId, placed: s.placed.slice(0, -1) };
}

export interface GhostInfo {
  /** The sequence number the next control gets (1-based); null without a course or for start / finish. */
  number: number | null;
  /** Lines of the pending leg, paper mm: anchor → cursor, and cursor → the next row when inserting. */
  legs: [Pt, Pt][];
  /** The pending leg's length (anchor → cursor), paper mm; null without an anchor. */
  legMm: number | null;
}

/** The ghost at `cursor`: its number and the pending leg (08 §5.3). */
export function ghostInfo(s: PlacementState, rows: readonly DisplayRow[], cursor: Pt, ptOf: (id: number) => Pt | null): GhostInfo {
  if (s.insertAt === null) return { number: null, legs: [], legMm: null };
  const anchor = s.anchorId !== null ? ptOf(s.anchorId) : null;
  const legs: [Pt, Pt][] = [];
  if (anchor) legs.push([anchor, cursor]);
  if (s.tool === "control") {
    const next = rowAfter(rows, s.insertAt);
    // A finish placed with `M` closes the chain: nothing after it.
    if (next?.pt && next.id !== s.anchorId) legs.push([cursor, next.pt]);
  }
  return {
    number: s.tool === "control" ? s.insertAt + 1 : null,
    legs,
    legMm: anchor ? Math.hypot(cursor.x - anchor.x, cursor.y - anchor.y) : null,
  };
}
