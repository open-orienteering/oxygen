import { describe, it, expect } from "vitest";
import type { SeriesAllocationEntry } from "@oxygen/shared";
import {
  buildInventoryView,
  codesHaveSrr,
  courseEditorReducer,
  courseMembership,
  courselessClassNames,
  effectiveRoleControlId,
  initialCourseEditorState,
  matchCourselessClass,
  nextFreeControlCode,
  nextFreeSrrCode,
  nextSeriesControlCode,
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

function entry(
  code: number,
  seriesId: string,
  extra: Partial<SeriesAllocationEntry> = {},
): SeriesAllocationEntry {
  return {
    code,
    type: "normal",
    seriesId,
    seriesName: seriesId,
    borrowed: false,
    ...extra,
  };
}

describe("nextSeriesControlCode", () => {
  it("follows series priority then code", () => {
    const allocation = [
      entry(40, "own"),
      entry(41, "own"),
      entry(31, "lent", { borrowed: true, seriesName: "Lent" }),
    ];
    expect(nextSeriesControlCode(allocation, []).entry?.seriesId).toBe("own");
    expect(nextSeriesControlCode(allocation, []).code).toBe(40);
    expect(nextSeriesControlCode(allocation, ["40"]).code).toBe(41);
    expect(nextSeriesControlCode(allocation, ["40", "41"]).code).toBe(31);
  });

  it("skips codes already used in the event, including multi-code strings", () => {
    const allocation = [entry(31, "a"), entry(32, "a"), entry(33, "a")];
    expect(nextSeriesControlCode(allocation, ["31;99"]).code).toBe(32);
  });

  it("only sees entries present in the allocation (inactive omitted)", () => {
    const allocation = [entry(31, "a"), entry(33, "a")];
    expect(nextSeriesControlCode(allocation, []).code).toBe(31);
    expect(nextSeriesControlCode(allocation, ["31"]).code).toBe(33);
  });

  it("skips a duplicate code on a later series once the first is consumed", () => {
    const allocation = [
      entry(31, "own"),
      entry(31, "lent", { borrowed: true, type: "srr" }),
      entry(40, "lent", { borrowed: true }),
    ];
    expect(nextSeriesControlCode(allocation, []).code).toBe(31);
    expect(nextSeriesControlCode(allocation, ["31"]).code).toBe(40);
    expect(nextSeriesControlCode(allocation, ["31"]).entry?.seriesId).toBe("lent");
  });

  it("falls back to ≥ 31 gap-fill with entry null when exhausted", () => {
    const allocation = [entry(31, "a"), entry(32, "a"), entry(40, "b")];
    const r = nextSeriesControlCode(allocation, ["31", "32", "40"]);
    expect(r.code).toBe(33);
    expect(r.entry).toBeNull();
  });

  it("falls back when allocation is empty", () => {
    const r = nextSeriesControlCode([], ["31"]);
    expect(r.code).toBe(32);
    expect(r.entry).toBeNull();
  });

  it("passes through SRR type on the chosen entry", () => {
    const allocation = [
      entry(31, "a"),
      entry(33, "a", { type: "srr", seriesName: "Own" }),
    ];
    const r = nextSeriesControlCode(allocation, ["31"]);
    expect(r.code).toBe(33);
    expect(r.entry?.type).toBe("srr");
    expect(r.entry?.seriesName).toBe("Own");
  });

  it("prefers the requested series over higher-priority ones", () => {
    const allocation = [
      entry(40, "own"),
      entry(41, "own"),
      entry(70, "lent", { borrowed: true, seriesName: "Lent" }),
      entry(71, "lent", { borrowed: true, seriesName: "Lent" }),
    ];
    const r = nextSeriesControlCode(allocation, [], "lent");
    expect(r.code).toBe(70);
    expect(r.entry?.seriesId).toBe("lent");
    expect(nextSeriesControlCode(allocation, ["70"], "lent").code).toBe(71);
  });

  it("falls through to priority order when the preferred series is exhausted", () => {
    const allocation = [
      entry(40, "own"),
      entry(70, "lent", { borrowed: true, seriesName: "Lent" }),
    ];
    const r = nextSeriesControlCode(allocation, ["70"], "lent");
    expect(r.code).toBe(40);
    expect(r.entry?.seriesId).toBe("own");
  });

  it("treats an unknown preferred series like auto", () => {
    const allocation = [entry(40, "own")];
    const r = nextSeriesControlCode(allocation, [], "missing");
    expect(r.code).toBe(40);
    expect(r.entry?.seriesId).toBe("own");
  });
});

describe("buildInventoryView", () => {
  it("groups by series in allocation order and marks used multi-codes", () => {
    const allocation = [
      entry(31, "own", { seriesName: "Own" }),
      entry(32, "own", { seriesName: "Own", type: "srr" }),
      entry(40, "loan", { seriesName: "Loan", borrowed: true }),
    ];

    expect(buildInventoryView(allocation, ["32;99"])).toEqual([
      {
        seriesId: "own",
        seriesName: "Own",
        borrowed: false,
        codes: [
          { code: 31, type: "normal", used: false },
          { code: 32, type: "srr", used: true },
        ],
      },
      {
        seriesId: "loan",
        seriesName: "Loan",
        borrowed: true,
        codes: [{ code: 40, type: "normal", used: false }],
      },
    ]);
  });

  it("marks duplicate codes used in every series", () => {
    const allocation = [
      entry(31, "own"),
      entry(31, "loan", { borrowed: true, type: "srr" }),
    ];
    const view = buildInventoryView(allocation, ["31"]);
    expect(view[0].codes[0].used).toBe(true);
    expect(view[1].codes[0].used).toBe(true);
  });
});

describe("nextFreeSrrCode", () => {
  const allocation = [
    entry(31, "a"),
    entry(32, "a", { type: "srr" }),
    entry(40, "b", { type: "srr" }),
  ];

  it("skips normal and used entries", () => {
    expect(nextFreeSrrCode(allocation, ["32;99"])?.code).toBe(40);
  });

  it("returns null when exhausted or empty", () => {
    expect(nextFreeSrrCode(allocation, ["32", "40"])).toBeNull();
    expect(nextFreeSrrCode([], [])).toBeNull();
  });
});

describe("codesHaveSrr", () => {
  const allocation = [
    entry(31, "a"),
    entry(32, "a", { type: "srr" }),
    entry(40, "b", { type: "srr" }),
  ];

  it("detects single and multi-code SRR controls", () => {
    expect(codesHaveSrr("32", allocation)).toBe(true);
    expect(codesHaveSrr("31;40", allocation)).toBe(true);
  });

  it("rejects normal, unknown, and malformed codes", () => {
    expect(codesHaveSrr("31", allocation)).toBe(false);
    expect(codesHaveSrr("99", allocation)).toBe(false);
    expect(codesHaveSrr("32x", allocation)).toBe(false);
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

describe("effectiveRoleControlId", () => {
  // Wire statuses: 4 = start, 5 = finish, 0 = normal control.
  const coords = [
    { id: 31, status: 0 },
    { id: 118, status: 4 },
    { id: 112, status: 4 },
    { id: 120, status: 5 },
  ];

  it("returns null when the event has no control of that role", () => {
    expect(effectiveRoleControlId([{ id: 31, status: 0 }], "start", null)).toBeNull();
    expect(effectiveRoleControlId([], "finish", null)).toBeNull();
  });

  it("defaults to the lowest-id control of the role", () => {
    expect(effectiveRoleControlId(coords, "start", null)).toBe(112);
    expect(effectiveRoleControlId(coords, "finish", null)).toBe(120);
  });

  it("prefers the explicitly assigned control", () => {
    expect(effectiveRoleControlId(coords, "start", 118)).toBe(118);
  });

  it("falls back to the default when the assignment is stale", () => {
    // e.g. the assigned start was deleted after the course was saved
    expect(effectiveRoleControlId(coords, "start", 999)).toBe(112);
  });

  it("ignores assignments pointing at a control of the wrong role", () => {
    expect(effectiveRoleControlId(coords, "finish", 118)).toBe(120);
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

describe("courselessClassNames", () => {
  it("excludes linked classes and names already used by courses", () => {
    expect(
      courselessClassNames(
        [
          { name: "H21", courseId: 0 },
          { name: "D21", courseId: 4 },
          { name: "U1", courseId: 0 },
        ],
        ["h21"],
      ),
    ).toEqual(["U1"]);
  });
});

describe("matchCourselessClass", () => {
  const classes = [
    { id: 3, name: "H21", courseId: 0 },
    { id: 4, name: "D21", courseId: 9 },
  ];

  it("matches an unlinked class case-insensitively", () => {
    expect(matchCourselessClass("h21", classes)).toBe(3);
  });

  it("ignores linked classes and returns null without an exact match", () => {
    expect(matchCourselessClass("d21", classes)).toBeNull();
    expect(matchCourselessClass("H2", classes)).toBeNull();
  });
});
