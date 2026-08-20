import { describe, it, expect } from "vitest";
import {
  courseEditorReducer,
  courseMembership,
  initialCourseEditorState,
  nextFreeControlCode,
  sequenceLegMeters,
  type CourseEditorState,
} from "../course-editor";

const base = (over: Partial<CourseEditorState> = {}): CourseEditorState => ({
  selectedControlId: null,
  selectedCourseId: null,
  phantom: null,
  ...over,
});

describe("courseEditorReducer", () => {
  it("starts with nothing selected and no phantom", () => {
    expect(initialCourseEditorState).toEqual(base());
  });

  it("selects and deselects controls", () => {
    let s = courseEditorReducer(initialCourseEditorState, { type: "select", id: 31 });
    expect(s.selectedControlId).toBe(31);
    s = courseEditorReducer(s, { type: "select", id: null });
    expect(s.selectedControlId).toBeNull();
  });

  it("selecting a control clears the phantom", () => {
    const s = courseEditorReducer(
      base({ phantom: { x: 1, y: 2, insertAt: null } }),
      { type: "select", id: 31 },
    );
    expect(s.phantom).toBeNull();
    expect(s.selectedControlId).toBe(31);
  });

  describe("map-click", () => {
    it("sets a phantom and clears the control selection", () => {
      const s = courseEditorReducer(
        base({ selectedControlId: 42 }),
        { type: "map-click", x: 10, y: 20 },
      );
      expect(s.phantom).toEqual({ x: 10, y: 20, insertAt: null });
      expect(s.selectedControlId).toBeNull();
    });

    it("re-anchors an existing phantom", () => {
      const s = courseEditorReducer(
        base({ phantom: { x: 1, y: 1, insertAt: 3 } }),
        { type: "map-click", x: 5, y: 6 },
      );
      expect(s.phantom).toEqual({ x: 5, y: 6, insertAt: null });
    });
  });

  describe("leg-click", () => {
    it("sets a phantom carrying the insert position", () => {
      const s = courseEditorReducer(
        base({ selectedControlId: 42, selectedCourseId: 7 }),
        { type: "leg-click", x: 3, y: 4, insertAt: 2 },
      );
      expect(s.phantom).toEqual({ x: 3, y: 4, insertAt: 2 });
      expect(s.selectedControlId).toBeNull();
      expect(s.selectedCourseId).toBe(7);
    });
  });

  describe("course selection", () => {
    it("selects and deselects a course", () => {
      let s = courseEditorReducer(initialCourseEditorState, { type: "select-course", id: 7 });
      expect(s.selectedCourseId).toBe(7);
      s = courseEditorReducer(s, { type: "select-course", id: null });
      expect(s.selectedCourseId).toBeNull();
    });

    it("changing course clears the phantom (its actions were course-scoped)", () => {
      const s = courseEditorReducer(
        base({ selectedCourseId: 7, phantom: { x: 1, y: 2, insertAt: 1 } }),
        { type: "select-course", id: 8 },
      );
      expect(s.phantom).toBeNull();
      expect(s.selectedCourseId).toBe(8);
    });

    it("keeps the control selection when switching course", () => {
      const s = courseEditorReducer(
        base({ selectedControlId: 42, selectedCourseId: 7 }),
        { type: "select-course", id: 8 },
      );
      expect(s.selectedControlId).toBe(42);
    });
  });

  it("selects a newly placed control and clears the phantom", () => {
    const s = courseEditorReducer(
      base({ phantom: { x: 1, y: 2, insertAt: null } }),
      { type: "placed", id: 55 },
    );
    expect(s.selectedControlId).toBe(55);
    expect(s.phantom).toBeNull();
  });

  it("clears the selection when the selected control is deleted", () => {
    const s = courseEditorReducer(base({ selectedControlId: 42 }), { type: "deleted", id: 42 });
    expect(s.selectedControlId).toBeNull();
  });

  it("keeps the selection when a different control is deleted", () => {
    const selected = base({ selectedControlId: 42 });
    const s = courseEditorReducer(selected, { type: "deleted", id: 31 });
    expect(s).toBe(selected);
  });

  describe("escape", () => {
    it("first clears the phantom", () => {
      const s = courseEditorReducer(
        base({ phantom: { x: 1, y: 2, insertAt: null }, selectedCourseId: 7 }),
        { type: "escape" },
      );
      expect(s.phantom).toBeNull();
      expect(s.selectedCourseId).toBe(7);
    });

    it("then clears the control selection", () => {
      const s = courseEditorReducer(
        base({ selectedControlId: 42, selectedCourseId: 7 }),
        { type: "escape" },
      );
      expect(s.selectedControlId).toBeNull();
      expect(s.selectedCourseId).toBe(7);
    });

    it("then deselects the course", () => {
      const s = courseEditorReducer(base({ selectedCourseId: 7 }), { type: "escape" });
      expect(s.selectedCourseId).toBeNull();
    });

    it("is a no-op in the base state", () => {
      const s = courseEditorReducer(initialCourseEditorState, { type: "escape" });
      expect(s).toBe(initialCourseEditorState);
    });
  });
});

describe("nextFreeControlCode", () => {
  it("returns 31 when nothing is used", () => {
    expect(nextFreeControlCode([])).toBe(31);
  });

  it("returns the smallest unused code ≥ 31", () => {
    expect(nextFreeControlCode(["31", "32", "34"])).toBe(33);
  });

  it("handles multi-code controls", () => {
    expect(nextFreeControlCode(["31;32", "33"])).toBe(34);
  });

  it("ignores non-numeric and sub-31 codes", () => {
    expect(nextFreeControlCode(["S1", "10", "31x", ""])).toBe(31);
  });
});

describe("courseMembership", () => {
  const courses = [
    { name: "Lång", controls: "31;32;33" },
    { name: "Kort", controls: "31;34" },
    { name: "Tom", controls: "" },
  ];

  it("maps each control id to the names of the courses using it", () => {
    const m = courseMembership(courses);
    expect(m.get(31)).toEqual(["Lång", "Kort"]);
    expect(m.get(32)).toEqual(["Lång"]);
    expect(m.get(34)).toEqual(["Kort"]);
  });

  it("omits controls not used by any course", () => {
    expect(courseMembership(courses).has(99)).toBe(false);
  });

  it("lists a course once even when it visits a control twice", () => {
    const m = courseMembership([{ name: "Fjäril", controls: "31;32;31" }]);
    expect(m.get(31)).toEqual(["Fjäril"]);
  });

  it("returns an empty map for no courses", () => {
    expect(courseMembership([]).size).toBe(0);
  });
});

describe("sequenceLegMeters", () => {
  it("computes terrain meters between consecutive points (mm × scale / 1000)", () => {
    // 10 mm at 1:10000 → 100 m
    const legs = sequenceLegMeters(
      [{ x: 0, y: 10 }, { x: 0, y: 20 }, { x: 30, y: 60 }],
      10000,
    );
    expect(legs).toEqual([null, 100, 500]);
  });

  it("skips unpositioned points and bridges across them", () => {
    const legs = sequenceLegMeters(
      [{ x: 0, y: 10 }, null, { x: 0, y: 20 }],
      10000,
    );
    // Point 1 is unpositioned → no leg; point 2 measures from point 0.
    expect(legs).toEqual([null, null, 100]);
  });

  it("returns nulls without a map scale", () => {
    expect(sequenceLegMeters([{ x: 0, y: 0 }, { x: 10, y: 0 }], null)).toEqual([null, null]);
  });

  it("returns an empty array for an empty sequence", () => {
    expect(sequenceLegMeters([], 15000)).toEqual([]);
  });
});
