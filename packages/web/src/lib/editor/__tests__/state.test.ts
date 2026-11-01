import { describe, it, expect } from "vitest";
import { areaTool, editorReducer, escapeHasWork, initialEditorState } from "../state";

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

  it("a tool is dropped first by Escape (back to V), then the multi-selection, then the object (§6)", () => {
    let s = editorReducer(initialEditorState, { type: "select-course", id: 1 });
    s = editorReducer(s, { type: "set-multi", ids: [31, 32] });
    s = editorReducer(s, { type: "tool", tool: areaTool("oob_area") });
    expect(escapeHasWork(s)).toBe(true);
    s = editorReducer(s, { type: "escape" });
    expect(s.tool.kind).toBe("select");
    expect(s.multi).toEqual([31, 32]);
    s = editorReducer(s, { type: "escape" });
    expect(s.multi).toEqual([]);
    s = editorReducer(editorReducer(s, { type: "select-object", id: 7 }), { type: "escape" });
    expect(s.selectedObjectId).toBeNull();
    expect(s.selectedCourseId).toBe(1);
  });

  it("Shift-click builds a multi-selection from the selected control; one left is a plain selection", () => {
    let s = editorReducer(initialEditorState, { type: "select", id: 31 });
    s = editorReducer(s, { type: "toggle-multi", id: 32 });
    expect(s).toMatchObject({ multi: [31, 32], selectedControlId: null });
    s = editorReducer(s, { type: "toggle-multi", id: 33 });
    s = editorReducer(s, { type: "toggle-multi", id: 31 });
    expect(s.multi).toEqual([32, 33]);
    s = editorReducer(s, { type: "toggle-multi", id: 32 });
    expect(s).toMatchObject({ multi: [], selectedControlId: 33 });
    expect(editorReducer(s, { type: "map-click", x: 0, y: 0 }).multi).toEqual([]);
  });

  it("an object selection is exclusive with a control and ends with a click elsewhere", () => {
    let s = editorReducer(editorReducer(initialEditorState, { type: "select", id: 31 }), { type: "select-object", id: 4 });
    expect(s).toMatchObject({ selectedObjectId: 4, selectedControlId: null });
    s = editorReducer(s, { type: "select", id: 32 });
    expect(s).toMatchObject({ selectedObjectId: null, selectedControlId: 32 });
  });

  it("chain and polygon updates apply to their own tool only; a tool drops the phantom", () => {
    let s = editorReducer(initialEditorState, { type: "map-click", x: 1, y: 1 });
    s = editorReducer(s, { type: "tool", tool: { kind: "text" } });
    expect(s.phantom).toBeNull();
    expect(editorReducer(s, { type: "polygon", poly: { kind: "whiteout", vertices: [] } })).toBe(s);
    s = editorReducer(s, { type: "tool", tool: areaTool("whiteout") });
    s = editorReducer(s, { type: "polygon", poly: { kind: "whiteout", vertices: [{ x: 1, y: 2 }] } });
    expect(s.tool).toEqual({ kind: "area", poly: { kind: "whiteout", vertices: [{ x: 1, y: 2 }] } });
    expect(editorReducer(s, { type: "toggle-snapping" }).snapping).toBe(true);
  });
});
