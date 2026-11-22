/** Computed route alternatives in the editor (docs/course-elevation.md §7.8). */

import { describe, it, expect } from "vitest";
import type { course } from "@oxygen/shared";
import { BLOCKED } from "@oxygen/shared/src/route/index.js";
import { alternativeItems, alternativeShapes, courseRouteTotals, flatPaceSPerKm, formatClock, oobFeatures, parsePace } from "../leg-alternatives";

describe("the pace (docs/course-elevation.md §7.8)", () => {
  it("minutes per km as a clock or a decimal; nothing else, and only a pace someone runs", () => {
    expect(parsePace("5:30")).toBe(330);
    expect(parsePace(" 6:00 ")).toBe(360);
    expect(parsePace("5.5")).toBe(330);
    expect(parsePace("5,5")).toBe(330);
    expect(parsePace("6")).toBe(360);
    for (const bad of ["", "abc", "5:75", "1:30", "45", "-5", "5:3"]) expect(parsePace(bad), bad).toBeNull();
  });

  it("a clock from seconds", () => {
    expect(formatClock(330)).toBe("5:30");
    expect(formatClock(59.6)).toBe("1:00");
    expect(formatClock(3725)).toBe("62:05");
    expect(formatClock(-3)).toBe("0:00");
  });

  it("the pace on flat forest: the winner's time for the course's length, shared over the legs by their costs", () => {
    // 5 km at 6:00 is 1800 s; the legs cost 6000 flat metres: 300 s per flat km.
    expect(flatPaceSPerKm(360, 5000, [2500, 3500])).toBe(300);
    // An easier course (roads) is run at a slower flat pace for the same winner pace.
    expect(flatPaceSPerKm(360, 5000, [2000, 2000])).toBe(450);
    for (const none of [null, [], [0, 0], [Number.POSITIVE_INFINITY]]) expect(flatPaceSPerKm(360, 5000, none)).toBeNull();
    expect(flatPaceSPerKm(360, 0, [100])).toBeNull();
  });

  it("the course along its routes: the metres on the ground, the winner's time, how many legs have a route", () => {
    const legs = [{ points: [{ x: 0, y: 0 }, { x: 30, y: 0 }], routed: false }, { points: [{ x: 30, y: 0 }, { x: 30, y: 20 }, { x: 60, y: 20 }], routed: true }];
    expect(courseRouteTotals(legs, 10000, 700, 360)).toEqual({ routeM: 800, timeS: 252, routed: 1 });
    expect(courseRouteTotals(legs, 10000, null, 360)).toEqual({ routeM: 800, timeS: null, routed: 1 });
    expect(courseRouteTotals(null, 10000, 700, 360)).toBeNull();
    expect(courseRouteTotals([], 10000, 700, 360)).toBeNull();
    expect(courseRouteTotals(legs, null, 700, 360)).toBeNull();
  });
});

describe("the alternatives' list and shapes (docs/course-elevation.md §7.8)", () => {
  const routes = [
    { points: [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 0 }], lengthM: 141, costM: 120, fastest: true, shortest: false },
    { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], lengthM: 100, costM: 200, fastest: false, shortest: true },
    { points: [{ x: 0, y: 0 }, { x: 5, y: -5 }, { x: 10, y: 0 }], lengthM: 141, costM: 130, fastest: false, shortest: false },
  ];

  it("each with its kind, its metres, its time at the pace and its interior vertices", () => {
    const items = alternativeItems(routes, 10000, null, 300);
    expect(items.map((i) => [i.kind, i.lengthM, i.timeS, i.climbM])).toEqual([["fastest", 141, 36, null], ["shortest", 100, 60, null], ["alternative", 141, 39, null]]);
    expect(items[0].interior).toEqual([{ x: 5, y: 5 }]);
    expect(items[1].interior).toEqual([]);
    expect(alternativeItems([{ ...routes[0], shortest: true }], 10000, null, 300)[0].kind).toBe("fastestShortest");
    // Before the pace on flat forest is known: no time.
    expect(alternativeItems(routes, 10000, null, null).map((i) => i.timeS)).toEqual([null, null, null]);
  });

  it("the map's shapes: dashed, the pointed-at one solid", () => {
    const shapes = alternativeShapes(alternativeItems(routes, 10000, null, 300), 1);
    expect(shapes.map((s) => (s as { dashed?: boolean }).dashed)).toEqual([true, false, true]);
    expect(shapes[0]).toMatchObject({ kind: "line", testId: "editor-route-alternative", data: { index: "0", kind: "fastest" } });
  });

  it("the course's out-of-bounds objects are uncrossable: areas, and 708 lines only", () => {
    const o = (kind: string, n: number, props: Record<string, unknown> = {}) =>
      ({ id: 1, kind, geometry: Array.from({ length: n }, (_, i) => ({ x: i, y: i * i })), props, scope: { all: true }, z: 0 }) as unknown as course.CourseObject;
    const f = oobFeatures([o("oob_area", 3), o("oob_line", 2), o("oob_line", 2, { symbol: "707" }), o("whiteout", 4), o("oob_area", 2)]);
    expect(f.map((x) => [x.cls, x.kind])).toEqual([[BLOCKED, "area"], [BLOCKED, "line"]]);
    expect(f[0].box).toEqual([0, 0, 2, 4]);
  });
});
