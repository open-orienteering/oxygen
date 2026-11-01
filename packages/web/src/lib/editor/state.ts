/**
 * The new editor's view state (docs/course-editor.md §3): the legacy
 * selection model (`courseEditorReducer`: selected course, selected
 * control, phantom, the Escape cascade) plus what the shell adds — the
 * mode, the view (Course · All controls) and "hide other controls".
 * Server data stays in the React Query cache.
 */

import { courseEditorReducer, initialCourseEditorState, type CourseEditorAction, type CourseEditorState } from "../course-editor";

export type EditorMode = "course" | "layout" | "field";
export type EditorView = "course" | "all";

export interface EditorState extends CourseEditorState {
  mode: EditorMode;
  view: EditorView;
  hideOthers: boolean;
}

export type EditorAction =
  | CourseEditorAction
  | { type: "mode"; mode: EditorMode }
  | { type: "view"; view: EditorView }
  | { type: "toggle-hide-others" };

export const initialEditorState: EditorState = { ...initialCourseEditorState, mode: "course", view: "course", hideOthers: false };

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "mode":
      // Layout (D7) and Field (D9) are not built yet: only Course mode is entered.
      return action.mode === "course" ? { ...state, mode: "course" } : state;
    case "view":
      return state.view === action.view ? state : { ...state, view: action.view, phantom: null };
    case "toggle-hide-others":
      // Hiding needs a selected course to mean anything (as `H` in the legacy editor).
      return state.selectedCourseId === null ? state : { ...state, hideOthers: !state.hideOthers };
    default: {
      const next = courseEditorReducer(state, action);
      if (next === state) return state;
      // Without a course there is nothing to hide others from.
      return { ...state, ...next, hideOthers: next.selectedCourseId === null ? false : state.hideOthers };
    }
  }
}

/** Whether Escape has anything left to dismiss (else it leaves fullscreen). */
export function escapeHasWork(s: EditorState): boolean {
  return s.phantom !== null || s.selectedControlId !== null || s.selectedCourseId !== null;
}
