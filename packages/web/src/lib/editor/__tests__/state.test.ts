import { describe, it, expect } from "vitest";
import { areaTool, editorReducer, escapeHasWork, initialEditorState, showSelectionRing } from "../state";

describe("showSelectionRing (docs/course-editor.md §6.1)", () => {
  it("draws the ring in V and when no tool is passed, never while an exclusive tool is armed", () => {
    expect(showSelectionRing(null)).toBe(true);
    expect(showSelectionRing({ tool: null })).toBe(true);
    expect(showSelectionRing({ tool: {} })).toBe(true);
    expect(showSelectionRing({ tool: { exclusive: false } })).toBe(true);
    expect(showSelectionRing({ tool: { exclusive: true } })).toBe(false);
  });

  it("the ring is V's: a control just placed in V keeps it, with the action bar (P4 reverts P1)", () => {
    const placed = editorReducer(initialEditorState, { type: "placed", id: 7 });
    expect(placed.selectedControlId).toBe(7);
    expect(placed).not.toHaveProperty("placed");
    expect(showSelectionRing({ tool: null })).toBe(true);
    // Selecting the control already selected, with no phantom, is a no-op.
    expect(editorReducer(placed, { type: "select", id: 7 })).toBe(placed);
    // Field keeps the selection; Layout drops it.
    expect(editorReducer(placed, { type: "mode", mode: "field" }).selectedControlId).toBe(7);
    expect(editorReducer(placed, { type: "mode", mode: "layout" }).selectedControlId).toBeNull();
  });
});

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

  it("Course and Field (D9) are entered and keep the selection", () => {
    let f = editorReducer(editorReducer(initialEditorState, { type: "select-course", id: 1 }), { type: "select", id: 31 });
    f = editorReducer(f, { type: "mode", mode: "field" });
    expect([f.mode, f.selectedCourseId, f.selectedControlId]).toEqual(["field", 1, 31]);
    f = editorReducer(f, { type: "mode", mode: "course" });
    expect([f.mode, f.selectedControlId]).toEqual(["course", 31]);
  });

  it("Layout mode is entered with the course selection kept and everything else of Course mode dropped (D7)", () => {
    let s = editorReducer(initialEditorState, { type: "select-course", id: 3 });
    s = editorReducer(s, { type: "map-click", x: 1, y: 1 });
    s = editorReducer(s, { type: "tool", tool: areaTool("oob_area") });
    s = editorReducer(s, { type: "mode", mode: "layout" });
    expect(s.mode).toBe("layout");
    expect(s.selectedCourseId).toBe(3);
    expect(s.tool).toEqual({ kind: "select" });
    expect(s.phantom).toBeNull();
    expect(s.selectedControlId).toBeNull();
    expect(editorReducer(s, { type: "mode", mode: "course" }).mode).toBe("course");
    expect(editorReducer(s, { type: "mode", mode: "field" }).mode).toBe("field");
  });

  it("a view change drops the phantom", () => {
    const s = editorReducer(editorReducer(initialEditorState, { type: "map-click", x: 1, y: 1 }), { type: "view", view: "all" });
    expect(s.view).toBe("all");
    expect(s.phantom).toBeNull();
  });

  it("Class view (course-layout.md §6): a class enters it, Course / All leave it, another course ends it", () => {
    let s = editorReducer(initialEditorState, { type: "select-course", id: 1 });
    expect(editorReducer(s, { type: "view", view: "class" })).toBe(s);
    s = editorReducer(s, { type: "class", seq: 7 });
    expect(s).toMatchObject({ view: "class", classSeq: 7 });
    expect(editorReducer(s, { type: "view", view: "course" })).toMatchObject({ view: "course", classSeq: null });
    expect(editorReducer(s, { type: "view", view: "all" })).toMatchObject({ view: "all", classSeq: null });
    expect(editorReducer(s, { type: "class", seq: null })).toMatchObject({ view: "course", classSeq: null });
    expect(editorReducer(s, { type: "select-course", id: 2 })).toMatchObject({ view: "course", classSeq: null, selectedCourseId: 2 });
    expect(editorReducer(s, { type: "select", id: 31 })).toMatchObject({ view: "class", classSeq: 7 });
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

  it("the eyedropper (pick-symbol, §6.4) is a tool: Escape drops it first, any mode change drops it", () => {
    let s = editorReducer(initialEditorState, { type: "select-object", id: 7 });
    s = editorReducer(s, { type: "tool", tool: { kind: "pick-symbol" } });
    expect(escapeHasWork(s)).toBe(true);
    const esc = editorReducer(s, { type: "escape" });
    expect([esc.tool.kind, esc.selectedObjectId]).toEqual(["select", 7]);
    for (const mode of ["field", "layout"] as const) expect(editorReducer(s, { type: "mode", mode }).tool.kind).toBe("select");
    expect(editorReducer(s, { type: "mode", mode: "course" }).tool.kind).toBe("pick-symbol");
  });
});

describe("variations (docs/course-editor.md §12, F7)", () => {
  const onCourse = editorReducer(initialEditorState, { type: "select-course", id: 1 });

  it("Variant view needs a key; other views drop it", () => {
    expect(editorReducer(onCourse, { type: "view", view: "variant" })).toBe(onCourse);
    const v = editorReducer({ ...onCourse, phantom: { x: 1, y: 2, insertAt: 0 } }, { type: "variant", key: "AB" });
    expect([v.view, v.variantKey, v.phantom]).toEqual(["variant", "AB", null]);
    expect(editorReducer(v, { type: "variant", key: "AB" })).toBe(v);
    expect([editorReducer(v, { type: "variant", key: null }).view, editorReducer(v, { type: "variant", key: null }).variantKey]).toEqual(["course", null]);
    const all = editorReducer(v, { type: "view", view: "all-variations" });
    expect([all.view, all.variantKey]).toEqual(["all-variations", null]);
  });

  it("an alternative is activated per group, shown in Course view and claims K until Escape", () => {
    const v = editorReducer(onCourse, { type: "variant", key: "AB" });
    const a = editorReducer({ ...v, phantom: { x: 1, y: 2, insertAt: 0 } }, { type: "alternative", groupId: "v1", label: "B" });
    expect([a.view, a.variantKey, a.activeAlternatives, a.focusGroupId, a.phantom]).toEqual(["course", null, { v1: "B" }, "v1", null]);
    expect(editorReducer(a, { type: "alternative", groupId: "v1", label: "B" })).toBe(a);
    expect(escapeHasWork({ ...a, selectedCourseId: null })).toBe(true);
    const esc = editorReducer(a, { type: "escape" });
    expect([esc.focusGroupId, esc.activeAlternatives, esc.selectedCourseId]).toEqual([null, { v1: "B" }, 1]);
  });

  it("in Class view and Layout mode a key picks the variant drawn, the view and mode kept (F8)", () => {
    const cls = editorReducer(onCourse, { type: "class", seq: 4 });
    const ab = editorReducer(cls, { type: "variant", key: "BA" });
    expect([ab.view, ab.classSeq, ab.variantKey]).toEqual(["class", 4, "BA"]);
    expect(editorReducer(ab, { type: "variant", key: "BA" })).toBe(ab);
    expect([editorReducer(ab, { type: "variant", key: null }).view, editorReducer(ab, { type: "variant", key: null }).variantKey]).toEqual(["class", null]);
    // Another class starts again at the first variant.
    expect(editorReducer(ab, { type: "class", seq: 5 }).variantKey).toBeNull();
    const layout = editorReducer(onCourse, { type: "mode", mode: "layout" });
    const ba = editorReducer(layout, { type: "variant", key: "BA" });
    expect([ba.mode, ba.view, ba.variantKey]).toEqual(["layout", "course", "BA"]);
    // Variant view entered in Course mode stays Variant view through Layout mode.
    const v = editorReducer(editorReducer(onCourse, { type: "variant", key: "AB" }), { type: "mode", mode: "layout" });
    expect([v.view, v.variantKey]).toEqual(["variant", "AB"]);
  });

  it("a course change resets the variant, the alternatives and the overlay", () => {
    let s = editorReducer(onCourse, { type: "alternative", groupId: "v1", label: "B" });
    s = editorReducer(s, { type: "view", view: "all-variations" });
    s = editorReducer(s, { type: "select-course", id: 2 });
    expect([s.view, s.variantKey, s.activeAlternatives, s.focusGroupId]).toEqual(["course", null, {}, null]);
  });
});
