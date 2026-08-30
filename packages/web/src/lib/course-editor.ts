/**
 * Page-local state machine for the course editor.
 *
 * The editor is tool-less: every map click resolves to a selection — an
 * existing control, or a "phantom" point on empty map / on a course leg —
 * and the page renders contextual actions (add / add to course / insert /
 * delete) next to that selection. Everything heavier (control data,
 * course geometry) lives in the React Query cache; drag-in-progress
 * rendering is MapViewer-internal. Keeping this a pure reducer makes the
 * keyboard and gesture handling on the page trivially unit-testable.
 */

import type { SeriesAllocationEntry } from "@oxygen/shared";

export type { SeriesAllocationEntry } from "@oxygen/shared";

/** An empty-map or leg click: the anchor for contextual add/insert actions. */
export interface PhantomPoint {
  /** Map mm. */
  x: number;
  y: number;
  /**
   * When the click hit a course leg: the position in the selected
   * course's control sequence a new control would be inserted at.
   * `null` for plain empty-map clicks.
   */
  insertAt: number | null;
}

export interface CourseEditorState {
  /** Public control id (first punch code) of the selected control. */
  selectedControlId: number | null;
  /** Course seq of the course whose sequence is being edited. */
  selectedCourseId: number | null;
  phantom: PhantomPoint | null;
}

export type CourseEditorAction =
  | { type: "select"; id: number | null }
  | { type: "select-course"; id: number | null }
  /** Click on empty map — anchor a phantom there. */
  | { type: "map-click"; x: number; y: number }
  /** Click on a course leg — phantom carrying the sequence insert position. */
  | { type: "leg-click"; x: number; y: number; insertAt: number }
  /** A control.create round-trip finished — select the new control. */
  | { type: "placed"; id: number }
  /** A control was deleted — drop it from the selection if it was selected. */
  | { type: "deleted"; id: number }
  /** Escape key: phantom → control selection → course selection, in that order. */
  | { type: "escape" };

export const initialCourseEditorState: CourseEditorState = {
  selectedControlId: null,
  selectedCourseId: null,
  phantom: null,
};

export function courseEditorReducer(
  state: CourseEditorState,
  action: CourseEditorAction,
): CourseEditorState {
  switch (action.type) {
    case "select":
      return state.selectedControlId === action.id && state.phantom === null
        ? state
        : { ...state, selectedControlId: action.id, phantom: null };
    case "select-course":
      if (state.selectedCourseId === action.id) return state;
      // The phantom's contextual actions are course-scoped (insert
      // position, add-to-course) — drop it on any course change.
      return { ...state, selectedCourseId: action.id, phantom: null };
    case "map-click":
      return {
        ...state,
        selectedControlId: null,
        phantom: { x: action.x, y: action.y, insertAt: null },
      };
    case "leg-click":
      return {
        ...state,
        selectedControlId: null,
        phantom: { x: action.x, y: action.y, insertAt: action.insertAt },
      };
    case "placed":
      return { ...state, selectedControlId: action.id, phantom: null };
    case "deleted":
      return state.selectedControlId === action.id
        ? { ...state, selectedControlId: null }
        : state;
    case "escape":
      if (state.phantom !== null) {
        return { ...state, phantom: null };
      }
      if (state.selectedControlId !== null) {
        return { ...state, selectedControlId: null };
      }
      if (state.selectedCourseId !== null) {
        return { ...state, selectedCourseId: null };
      }
      return state;
  }
}

/** Punch codes already placed in the event (semicolon-separated lists). */
export function parseUsedCodes(existingCodes: Iterable<string>): Set<number> {
  const used = new Set<number>();
  for (const codes of existingCodes) {
    for (const part of String(codes).split(";")) {
      const n = parseInt(part.trim(), 10);
      if (Number.isFinite(n) && n > 0 && String(n) === part.trim()) used.add(n);
    }
  }
  return used;
}

/**
 * Suggest a punch code for a newly placed control: the smallest unused
 * code ≥ 31 (SI codes 1–30 are reserved for start/finish/check/clear
 * conventions). Fills gaps left by deletions rather than growing
 * unboundedly.
 *
 * @param existingCodes the `codes` strings of every active control
 *   (semicolon-separated lists of punch codes).
 */
export function nextFreeControlCode(existingCodes: Iterable<string>): number {
  const used = parseUsedCodes(existingCodes);
  let code = 31;
  while (used.has(code)) code++;
  return code;
}

/**
 * Next punch code from the club series inventory. Returns the first
 * allocation entry whose code is unused in the event. When
 * `preferredSeriesId` is set, that series' free codes are tried first;
 * once it is exhausted allocation falls through to the normal priority
 * order. Empty or exhausted inventory falls back to
 * {@link nextFreeControlCode} with `entry: null`.
 */
export function nextSeriesControlCode(
  allocation: SeriesAllocationEntry[],
  existingCodes: Iterable<string>,
  preferredSeriesId: string | null = null,
): { code: number; entry: SeriesAllocationEntry | null } {
  const used = parseUsedCodes(existingCodes);
  if (preferredSeriesId !== null) {
    for (const entry of allocation) {
      if (entry.seriesId === preferredSeriesId && !used.has(entry.code)) {
        return { code: entry.code, entry };
      }
    }
  }
  for (const entry of allocation) {
    if (!used.has(entry.code)) {
      return { code: entry.code, entry };
    }
  }
  return { code: nextFreeControlCode(existingCodes), entry: null };
}

export interface InventorySeriesView {
  seriesId: string;
  seriesName: string;
  borrowed: boolean;
  codes: { code: number; type: "normal" | "srr"; used: boolean }[];
}

/**
 * Group the flat allocation by series while preserving allocation order,
 * and mark every occurrence of an event-used code.
 */
export function buildInventoryView(
  allocation: SeriesAllocationEntry[],
  existingCodes: Iterable<string>,
): InventorySeriesView[] {
  const used = parseUsedCodes(existingCodes);
  const views: InventorySeriesView[] = [];
  const byId = new Map<string, InventorySeriesView>();
  for (const entry of allocation) {
    let view = byId.get(entry.seriesId);
    if (!view) {
      view = {
        seriesId: entry.seriesId,
        seriesName: entry.seriesName,
        borrowed: entry.borrowed,
        codes: [],
      };
      byId.set(entry.seriesId, view);
      views.push(view);
    }
    view.codes.push({
      code: entry.code,
      type: entry.type,
      used: used.has(entry.code),
    });
  }
  return views;
}

/** First unused SRR-capable code from the allocation, or null. */
export function nextFreeSrrCode(
  allocation: SeriesAllocationEntry[],
  existingCodes: Iterable<string>,
): SeriesAllocationEntry | null {
  const used = parseUsedCodes(existingCodes);
  return allocation.find((entry) => entry.type === "srr" && !used.has(entry.code)) ?? null;
}

/** Whether a single or semicolon-separated code string includes an SRR unit. */
export function codesHaveSrr(
  codes: string,
  allocation: SeriesAllocationEntry[],
): boolean {
  const srrCodes = new Set(
    allocation.filter((entry) => entry.type === "srr").map((entry) => entry.code),
  );
  return [...parseUsedCodes([codes])].some((code) => srrCodes.has(code));
}

/**
 * Which courses use each control: public control id → course names, in
 * course-list order. Controls used by no course are absent. Used by the
 * editor to warn when moving a control affects other courses.
 *
 * @param courses course rows with the semicolon-separated `controls`
 *   sequence string from `course.list`.
 */
export function courseMembership(
  courses: ReadonlyArray<{ name: string; controls: string }>,
): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const course of courses) {
    for (const part of course.controls.split(";")) {
      if (!part) continue;
      const id = Number(part);
      if (!Number.isFinite(id)) continue;
      const names = out.get(id);
      if (!names) out.set(id, [course.name]);
      else if (!names.includes(course.name)) names.push(course.name);
    }
  }
  return out;
}

/**
 * Resolve the start/finish control a course effectively uses, mirroring
 * the server's geometry builder: the explicitly assigned control when it
 * exists, otherwise the lowest-id control of that role (server default is
 * lowest seq; code-less start/finish rows expose seq as their public id).
 *
 * @param coords positioned controls from `course.controlCoordinates`
 *   (`status` uses the wire integers: 4 = start, 5 = finish).
 * @param assignedId the course's `startControlId` / `finishControlId`.
 * @returns the public id of the effective control, or `null` when the
 *   event has none of that role.
 */
export function effectiveRoleControlId(
  coords: ReadonlyArray<{ id: number; status: number }>,
  role: "start" | "finish",
  assignedId: number | null,
): number | null {
  const status = role === "start" ? 4 : 5;
  const candidates = coords.filter((c) => c.status === status);
  if (candidates.length === 0) return null;
  if (assignedId != null && candidates.some((c) => c.id === assignedId)) {
    return assignedId;
  }
  return candidates.reduce(
    (min, c) => (c.id < min ? c.id : min),
    candidates[0].id,
  );
}

/**
 * Per-leg terrain meters for an ordered display sequence (start +
 * controls + finish). Mirrors the server's calculation in
 * `course-geometry.ts`: paper mm × mapScale / 1000, with unpositioned
 * controls (`null`) skipped so a single unplaced control doesn't break
 * the chain — the next positioned control measures from the last
 * positioned one.
 *
 * @returns one entry per input point: the leg distance INTO that point
 *   (meters, rounded), or `null` for the first point, unpositioned
 *   points, points with no positioned predecessor, or when `mapScale`
 *   is unknown.
 */
export function sequenceLegMeters(
  points: Array<{ x: number; y: number } | null>,
  mapScale: number | null,
): Array<number | null> {
  const out: Array<number | null> = new Array(points.length).fill(null);
  if (!mapScale) return out;
  let prev: { x: number; y: number } | null = null;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!p) continue;
    if (prev) {
      const dx = p.x - prev.x;
      const dy = p.y - prev.y;
      out[i] = Math.round((Math.sqrt(dx * dx + dy * dy) * mapScale) / 1000);
    }
    prev = p;
  }
  return out;
}

/** Names of classes without a linked course, excluding names already used by courses. */
export function courselessClassNames(
  classes: { name: string; courseId: number }[],
  courseNames: Iterable<string>,
): string[] {
  const usedNames = new Set(
    Array.from(courseNames, (name) => name.toLocaleLowerCase()),
  );
  return classes
    .filter(
      (cls) =>
        cls.courseId === 0 && !usedNames.has(cls.name.toLocaleLowerCase()),
    )
    .map((cls) => cls.name);
}

/** Case-insensitive exact match to an unlinked class; returns its public seq. */
export function matchCourselessClass(
  name: string,
  classes: { id: number; name: string; courseId: number }[],
): number | null {
  const normalized = name.toLocaleLowerCase();
  return (
    classes.find(
      (cls) =>
        cls.courseId === 0 && cls.name.toLocaleLowerCase() === normalized,
    )?.id ?? null
  );
}
