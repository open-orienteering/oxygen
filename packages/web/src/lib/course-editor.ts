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
  const used = new Set<number>();
  for (const codes of existingCodes) {
    for (const part of String(codes).split(";")) {
      const n = parseInt(part.trim(), 10);
      if (Number.isFinite(n) && n > 0 && String(n) === part.trim()) used.add(n);
    }
  }
  let code = 31;
  while (used.has(code)) code++;
  return code;
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
