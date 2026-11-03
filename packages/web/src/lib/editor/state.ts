/**
 * The new editor's view state (docs/course-editor.md §3, §6): the legacy
 * selection model (`courseEditorReducer`: selected course, selected
 * control, phantom, the Escape cascade) plus what the shell adds — the
 * mode, the view (Course · All controls · Class), "hide other controls", the
 * active tool, a multi-selection of controls, a selected course object and
 * the snapping toggle. Server data stays in the React Query cache.
 */

import { courseEditorReducer, initialCourseEditorState, type CourseEditorAction, type CourseEditorState } from "../course-editor";
import type { PlacementState } from "../../pages/editor/tools/placement";
import type { AreaKind, PolygonState } from "../../pages/editor/tools/polygon";

export type EditorMode = "course" | "layout" | "field";
/** `class`: Class view (docs/course-layout.md §6; 08 §5.4) — the course as `classSeq` prints it. */
export type EditorView = "course" | "all" | "class";

/** The tool rail's tools (08 §5.2): `V`, the armed `S` / `K` / `M`, `A` areas, `T` text, `G` gaps. */
export type EditorTool =
  | { kind: "select" }
  | { kind: "place"; chain: PlacementState }
  | { kind: "area"; poly: PolygonState }
  | { kind: "text" }
  /** Gaps on the selected circle, or on the leg into control-sequence position `legInsertAt` (the clicked leg). */
  | { kind: "gap"; legInsertAt: number | null };

export interface EditorState extends CourseEditorState {
  mode: EditorMode;
  view: EditorView;
  /** Class view's class (its seq); null in the other views. */
  classSeq: number | null;
  hideOthers: boolean;
  tool: EditorTool;
  /** Controls selected together (Shift-click, lasso), in selection order; empty or ≥ 2. */
  multi: number[];
  /** The selected course object (public id), exclusive with a selected control. */
  selectedObjectId: number | null;
  snapping: boolean;
}

export type EditorAction =
  | CourseEditorAction
  | { type: "mode"; mode: EditorMode }
  | { type: "view"; view: EditorView }
  /** Class view of a class of the selected course; null leaves it for Course view. */
  | { type: "class"; seq: number | null }
  | { type: "toggle-hide-others" }
  | { type: "tool"; tool: EditorTool }
  | { type: "chain"; chain: PlacementState }
  | { type: "polygon"; poly: PolygonState }
  | { type: "toggle-multi"; id: number }
  | { type: "set-multi"; ids: number[] }
  | { type: "select-object"; id: number | null }
  | { type: "toggle-snapping" };

const SELECT: EditorTool = { kind: "select" };

export const initialEditorState: EditorState = {
  ...initialCourseEditorState, mode: "course", view: "course", classSeq: null, hideOthers: false, tool: SELECT, multi: [], selectedObjectId: null, snapping: false,
};

/** A new area tool of `kind`. */
export const areaTool = (kind: AreaKind): EditorTool => ({ kind: "area", poly: { kind, vertices: [] } });

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "mode":
      // Course and Field (§9) keep the selection. Layout mode locks course edits (08 §5.4): the course stays
      // selected, a tool, a phantom and the selections of Course mode are dropped.
      if (action.mode === state.mode) return state;
      return action.mode === "layout"
        ? { ...state, mode: "layout", tool: SELECT, phantom: null, selectedControlId: null, multi: [], selectedObjectId: null }
        : { ...state, mode: action.mode };
    case "view":
      // Class view needs a class (the "class" action); the other views drop it.
      if (action.view === "class") return state.classSeq === null ? state : { ...state, view: "class", phantom: null };
      return state.view === action.view ? state : { ...state, view: action.view, classSeq: null, phantom: null };
    case "class":
      if (action.seq === null) return state.view === "class" ? { ...state, view: "course", classSeq: null } : state;
      return state.view === "class" && state.classSeq === action.seq ? state : { ...state, view: "class", classSeq: action.seq, phantom: null };
    case "toggle-hide-others":
      // Hiding needs a selected course to mean anything (as `H` in the legacy editor).
      return state.selectedCourseId === null ? state : { ...state, hideOthers: !state.hideOthers };
    case "tool":
      // Any tool drops the phantom (its action bar would compete with the tool).
      return { ...state, tool: action.tool, phantom: null };
    case "chain":
      return state.tool.kind === "place" ? { ...state, tool: { kind: "place", chain: action.chain } } : state;
    case "polygon":
      return state.tool.kind === "area" ? { ...state, tool: { kind: "area", poly: action.poly } } : state;
    case "toggle-multi": {
      const base = state.multi.length > 0 ? state.multi : state.selectedControlId !== null ? [state.selectedControlId] : [];
      const multi = base.includes(action.id) ? base.filter((id) => id !== action.id) : [...base, action.id];
      return withMulti(state, multi);
    }
    case "set-multi":
      return withMulti(state, action.ids);
    case "select-object":
      return { ...state, selectedObjectId: action.id, selectedControlId: action.id === null ? state.selectedControlId : null, multi: [], phantom: null };
    case "toggle-snapping":
      return { ...state, snapping: !state.snapping };
    case "escape":
      // An active tool is dropped first (back to V), then a multi-selection, then an object; then the legacy cascade.
      if (state.tool.kind !== "select") return { ...state, tool: SELECT };
      if (state.multi.length > 0) return { ...state, multi: [] };
      if (state.selectedObjectId !== null) return { ...state, selectedObjectId: null };
      return legacy(state, action);
    default:
      return legacy(state, action);
  }
}

/** One control selected → the plain selection; several → `multi` (the primary selection off). */
function withMulti(state: EditorState, ids: number[]): EditorState {
  if (ids.length <= 1) return { ...state, multi: [], selectedControlId: ids[0] ?? null, selectedObjectId: null, phantom: null };
  return { ...state, multi: ids, selectedControlId: null, selectedObjectId: null, phantom: null };
}

function legacy(state: EditorState, action: CourseEditorAction): EditorState {
  const next = courseEditorReducer(state, action);
  if (next === state) return state;
  // A control selection, a phantom or a course change ends a multi-selection and an object selection.
  const clears = action.type === "select" || action.type === "map-click" || action.type === "leg-click" || action.type === "placed" || action.type === "select-course";
  return {
    ...state,
    ...next,
    // Hiding belongs to the course it was switched on for: a course change switches it off.
    hideOthers: next.selectedCourseId !== state.selectedCourseId ? false : state.hideOthers,
    // A class runs one course: another course ends Class view.
    ...(next.selectedCourseId !== state.selectedCourseId && state.view === "class" ? { view: "course" as const, classSeq: null } : {}),
    ...(clears ? { multi: [], selectedObjectId: null } : {}),
  };
}

/** Whether Escape has anything left to dismiss (else it leaves fullscreen). */
export function escapeHasWork(s: EditorState): boolean {
  return s.tool.kind !== "select" || s.multi.length > 0 || s.selectedObjectId !== null
    || s.phantom !== null || s.selectedControlId !== null || s.selectedCourseId !== null;
}
