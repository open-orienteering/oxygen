import { describe, it, expect } from "vitest";
import { courseOverlayIds, type OverlayCourse } from "../course-overlay-ids";

// Wire statuses: 4 = start, 5 = finish, 0 = normal control.
// Start 112 sits at the west edge, start 118 at the east edge; control 31
// is next to 112, control 33 next to 118. Finish 120 is south, 125 north.
const coords = [
  { id: 31, status: 0, mapX: 10, mapY: 50 },
  { id: 32, status: 0, mapX: 50, mapY: 50 },
  { id: 33, status: 0, mapX: 95, mapY: 50 },
  { id: 112, status: 4, mapX: 0, mapY: 50 },
  { id: 118, status: 4, mapX: 100, mapY: 50 },
  { id: 120, status: 5, mapX: 50, mapY: 0 },
  { id: 125, status: 5, mapX: 50, mapY: 100 },
];

function course(over: Partial<OverlayCourse> = {}): OverlayCourse {
  return {
    controls: "",
    startControlId: null,
    finishControlId: null,
    firstAsStart: false,
    lastAsFinish: false,
    ...over,
  };
}

describe("courseOverlayIds (docs/course-editor.md §6.1, P5)", () => {
  it("lists the start of a course that has only a start (the regression)", () => {
    // Before P5 the start was prepended only when the course had controls,
    // so the provisional visit of the armed K tool had nothing to join.
    expect(courseOverlayIds(course({ startControlId: 118 }), coords)).toEqual(["118", "120"]);
  });

  it("lists the finish of a course that has only a finish", () => {
    expect(courseOverlayIds(course({ finishControlId: 125 }), coords)).toEqual(["112", "125"]);
  });

  it("lists start, controls and finish of a full course with explicit ends", () => {
    expect(
      courseOverlayIds(
        course({ controls: "31;32;33", startControlId: 118, finishControlId: 120 }),
        coords,
      ),
    ).toEqual(["118", "31", "32", "33", "120"]);
  });

  it("prefers the explicit ends over the nearest ones", () => {
    // 112 is nearest to 31; the explicit ids win regardless.
    expect(
      courseOverlayIds(
        course({ controls: "31;32", startControlId: 118, finishControlId: 125 }),
        coords,
      ),
    ).toEqual(["118", "31", "32", "125"]);
  });

  it("falls back to the start nearest the first control for a legacy course", () => {
    expect(courseOverlayIds(course({ controls: "33;32" }), coords)[0]).toBe("118");
    expect(courseOverlayIds(course({ controls: "31;32" }), coords)[0]).toBe("112");
  });

  it("falls back to the finish nearest the last control for a legacy course", () => {
    const near120 = [...coords, { id: 40, status: 0, mapX: 50, mapY: 5 }];
    expect(courseOverlayIds(course({ controls: "31;40" }), near120).at(-1)).toBe("120");
    const near125 = [...coords, { id: 41, status: 0, mapX: 50, mapY: 95 }];
    expect(courseOverlayIds(course({ controls: "31;41" }), near125).at(-1)).toBe("125");
  });

  it("uses the event default (lowest id) for a course with no controls and no explicit ends", () => {
    // Nothing to be nearest to: the readers' default (course-layer.md §6.2).
    expect(courseOverlayIds(course(), coords)).toEqual(["112", "120"]);
  });

  it("treats a stale explicit id like no explicit id", () => {
    expect(courseOverlayIds(course({ controls: "33", startControlId: 999 }), coords)).toEqual([
      "118",
      "33",
      "120",
    ]);
    expect(courseOverlayIds(course({ startControlId: 999 }), coords)[0]).toBe("112");
  });

  it("ignores an explicit id pointing at a control of the wrong role", () => {
    expect(courseOverlayIds(course({ startControlId: 120 }), coords)[0]).toBe("112");
  });

  it("adds no start under firstAsStart and no finish under lastAsFinish", () => {
    expect(
      courseOverlayIds(
        course({
          controls: "31;32",
          startControlId: 118,
          finishControlId: 120,
          firstAsStart: true,
          lastAsFinish: true,
        }),
        coords,
      ),
    ).toEqual(["31", "32"]);
  });

  it("lists only the controls when the event has no start or finish", () => {
    const plain = coords.filter((c) => c.status === 0);
    expect(courseOverlayIds(course({ controls: "31;32", startControlId: 118 }), plain)).toEqual([
      "31",
      "32",
    ]);
    expect(courseOverlayIds(course(), plain)).toEqual([]);
  });

  it("does not duplicate an end already at the head or tail of the controls", () => {
    expect(
      courseOverlayIds(
        course({ controls: "118;31;120", startControlId: 118, finishControlId: 120 }),
        coords,
      ),
    ).toEqual(["118", "31", "120"]);
  });

  it("keeps the explicit start when the first control is unpositioned", () => {
    // `course.controlCoordinates` leaves unpositioned controls out, so
    // control 50 has no row.
    expect(courseOverlayIds(course({ controls: "50", startControlId: 118 }), coords)[0]).toBe(
      "118",
    );
    // No position to measure from: the event default.
    expect(courseOverlayIds(course({ controls: "50" }), coords)[0]).toBe("112");
  });
});
