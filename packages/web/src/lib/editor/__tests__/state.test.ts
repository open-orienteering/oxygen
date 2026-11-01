import { describe, it, expect } from "vitest";
import { editorReducer, escapeHasWork, initialEditorState } from "../state";

describe("editorReducer (docs/course-editor.md §3)", () => {
  it("keeps the legacy selection model and its Escape cascade", () => {
    let s = editorReducer(initialEditorState, { type: "select-course", id: 1 });
    s = editorReducer(s, { type: "select", id: 31 });
    s = editorReducer(s, { type: "map-click", x: 1, y: 2 });
    expect(s.phantom).toEqual({ x: 1, y: 2, insertAt: null });
    expect(escapeHasWork(s)).toBe(true);
    s = editorReducer(s, { type: "escape" });
    expect(s.phantom).toBeNull();
    s = editorReducer(s, { type: "select", id: 31 });
    s = editorReducer(s, { type: "escape" });
    expect(s.selectedControlId).toBeNull();
    expect(s.selectedCourseId).toBe(1);
    s = editorReducer(s, { type: "escape" });
    expect(s.selectedCourseId).toBeNull();
    expect(escapeHasWork(s)).toBe(false);
  });

  it("hide-others needs a course and goes with a course change", () => {
    expect(editorReducer(initialEditorState, { type: "toggle-hide-others" }).hideOthers).toBe(false);
    let s = editorReducer(initialEditorState, { type: "select-course", id: 1 });
    s = editorReducer(s, { type: "toggle-hide-others" });
    expect(s.hideOthers).toBe(true);
    s = editorReducer(s, { type: "select-course", id: 2 });
    expect(s.hideOthers).toBe(false);
    s = editorReducer(editorReducer(s, { type: "toggle-hide-others" }), { type: "select", id: 31 });
    expect(s.hideOthers).toBe(true);
    s = editorReducer(s, { type: "select-course", id: null });
    expect(s.hideOthers).toBe(false);
  });

  it("only Course mode is entered (Layout D7, Field D9); a view change drops the phantom", () => {
    expect(editorReducer(initialEditorState, { type: "mode", mode: "layout" }).mode).toBe("course");
    const s = editorReducer(editorReducer(initialEditorState, { type: "map-click", x: 1, y: 1 }), { type: "view", view: "all" });
    expect(s.view).toBe("all");
    expect(s.phantom).toBeNull();
  });
});
