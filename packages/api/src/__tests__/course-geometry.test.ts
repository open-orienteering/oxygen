/**
 * Unit tests for the derived course lengths (docs/course-layer.md §4.1):
 * the course layer of an editor course over its sequence (unpositioned
 * controls skipped, free order without legs), leg distances and the
 * paper-mm → terrain-meters length computation. The GeoJSON projection
 * these tests once covered went with `courses.geometry` (E5).
 */

import { describe, it, expect } from "vitest";
import {
  editorCourseLayer,
  hasPositionedItems,
  legDistancesMm,
  courseLengthM,
  type GeometrySeqControl,
} from "../course-geometry.js";

const seq = (
  entries: Array<[string, GeometrySeqControl["type"], number, number]>,
): GeometrySeqControl[] =>
  entries.map(([code, type, xMm, yMm]) => ({ id: `ctrl-${code}`, code, type, xMm, yMm }));

const derived = (s: GeometrySeqControl[], mode?: "ordered" | "free_order") => editorCourseLayer("c1", s, mode).derivation;

describe("editorCourseLayer", () => {
  it("draws the sequence in order with centre-to-centre legs, each item in its role", () => {
    const { courses } = derived(seq([["S1", "Start", 0, 10], ["31", "Control", 30, 10], ["F1", "Finish", 30, 40]]));
    expect(courses[0].sequence.map((e) => [e.siteId, e.role])).toEqual([["ctrl-S1", "start"], ["ctrl-31", "control"], ["ctrl-F1", "finish"]]);
    expect(courses[0].legs.map((l) => [l.from, l.to, l.points[0], l.points[l.points.length - 1]])).toEqual([
      ["ctrl-S1", "ctrl-31", { x: 0, y: 10 }, { x: 30, y: 10 }],
      ["ctrl-31", "ctrl-F1", { x: 30, y: 10 }, { x: 30, y: 40 }],
    ]);
  });

  it("skips unpositioned (0,0) controls and connects across them", () => {
    const { courses } = derived(seq([["31", "Control", 10, 10], ["32", "Control", 0, 0], ["33", "Control", 50, 10]]));
    expect(courses[0].sequence.map((e) => e.siteId)).toEqual(["ctrl-31", "ctrl-33"]);
    expect(courses[0].legs.map((l) => [l.from, l.to])).toEqual([["ctrl-31", "ctrl-33"]]);
  });

  it("free order has no legs", () => {
    const { courses } = derived(seq([["S1", "Start", 0, 10], ["31", "Control", 30, 10], ["F1", "Finish", 60, 50]]), "free_order");
    expect(courses[0].sequence).toHaveLength(3);
    expect(courses[0].legs).toHaveLength(0);
  });

  it("draws no automatic cuts: lengths are centre to centre", () => {
    const { sites, courses } = derived(seq([["31", "Control", 10, 0], ["32", "Control", 40, 0]]));
    expect(sites.every((x) => x.cuts.length === 0)).toBe(true);
    expect(courses[0].legs.every((l) => l.gaps.length === 0)).toBe(true);
  });
});

describe("hasPositionedItems (length_source 'derived' vs NULL)", () => {
  it("is true with one positioned item and false when nothing is positioned", () => {
    expect(hasPositionedItems(editorCourseLayer("c1", seq([["31", "Control", 5, 5]])))).toBe(true);
    expect(hasPositionedItems(editorCourseLayer("c1", seq([["31", "Control", 0, 0], ["32", "Control", 0, 0]])))).toBe(false);
    expect(hasPositionedItems(editorCourseLayer("c1", []))).toBe(false);
  });
});

describe("legDistancesMm (from the course layer, E6)", () => {
  const dist = (s: GeometrySeqControl[], mode?: "ordered" | "free_order") => legDistancesMm(editorCourseLayer("c1", s, mode));

  /** The pre-E6 formula over the sequence itself: the parity reference. */
  const reference = (s: GeometrySeqControl[]): number[] => {
    const p = s.filter((c) => c.xMm !== 0 || c.yMm !== 0);
    return p.slice(1).map((c, i) => Math.sqrt((c.xMm - p[i].xMm) ** 2 + (c.yMm - p[i].yMm) ** 2));
  };

  it("computes euclidean distances between consecutive positioned controls", () => {
    const d = dist(
      seq([
        ["S1", "Start", 0, 10],
        ["31", "Control", 30, 50], // 3-4-5 triangle → 50 mm
        ["32", "Control", 30, 110], // 60 mm
      ]),
    );
    expect(d).toEqual([50, 60]);
  });

  it("ignores unpositioned controls", () => {
    const d = dist(
      seq([
        ["31", "Control", 0, 10],
        ["32", "Control", 0, 0],
        ["33", "Control", 0, 40], // 30 mm from control 31
      ]),
    );
    expect(d).toEqual([30]);
  });

  it("is empty for fewer than two positioned controls, and for free order", () => {
    expect(dist(seq([["31", "Control", 5, 5]]))).toEqual([]);
    expect(dist([])).toEqual([]);
    expect(dist(seq([["31", "Control", 5, 5], ["32", "Control", 9, 8]]), "free_order")).toEqual([]);
  });

  it("equals the pre-E6 sequence formula bit for bit (repeated visits, unplaced, fractional mm), and so the stored legs / lengthM", () => {
    let x = 12.345;
    const rnd = () => {
      x = (x * 9301 + 49297) % 233280;
      return (x / 233280) * 300 - 150;
    };
    const fixtures: GeometrySeqControl[][] = [
      seq([["S1", "Start", -30.25, 0.125], ["31", "Control", -20.333, 7.77], ["32", "Control", 20.1, -0.05], ["31", "Control", -20.333, 7.77], ["F1", "Finish", 30, 0]]),
      seq([["S1", "Start", 0, 0], ["31", "Control", 10.5, 3.25], ["32", "Control", 0, 0], ["33", "Control", 44.4, 12.12]]),
      ...Array.from({ length: 50 }, (_, k) => seq(Array.from({ length: 3 + (k % 20) }, (_, i) => [`${31 + i}`, i === 0 ? "Start" : "Control", rnd(), rnd()] as [string, GeometrySeqControl["type"], number, number]))),
    ];
    for (const f of fixtures) {
      expect(dist(f)).toEqual(reference(f));
      // The stored strings: per-leg rounding and the total, at two scales.
      for (const scale of [10000, 15000]) {
        expect(dist(f).map((d) => Math.round((d * scale) / 1000))).toEqual(reference(f).map((d) => Math.round((d * scale) / 1000)));
        expect(courseLengthM(dist(f), scale)).toBe(courseLengthM(reference(f), scale));
      }
    }
  });
});

describe("legs along their bends (F1, course-layer.md §4.1, §10.1)", () => {
  const bent = (leg: GeometrySeqControl["leg"]): GeometrySeqControl[] => [
    { id: "s", code: "S1", type: "Start", xMm: 10, yMm: 10 },
    { id: "a", code: "31", type: "Control", xMm: 40, yMm: 10, leg },
    { id: "f", code: "F1", type: "Finish", xMm: 40, yMm: 50 },
  ];

  it("measures a leg through its bends; style and corridor never change it", () => {
    expect(legDistancesMm(editorCourseLayer("c1", bent(undefined)))).toEqual([30, 40]);
    // (10,10) → (10,50) → (40,10): 40 + 50.
    expect(legDistancesMm(editorCourseLayer("c1", bent({ bends: [{ x: 10, y: 50 }] })))).toEqual([90, 40]);
    for (const style of ["line", "marked_route", "none"] as const) {
      expect(legDistancesMm(editorCourseLayer("c1", bent({ style, bends: [{ x: 10, y: 50 }] })))).toEqual([90, 40]);
    }
    expect(legDistancesMm(editorCourseLayer("c1", bent({ corridor: { widthM: 50, edge: true, whiteMm: 1, whiteOpacity: 1 } })))).toEqual([30, 40]);
    expect(courseLengthM(legDistancesMm(editorCourseLayer("c1", bent({ bends: [{ x: 10, y: 50 }] }))), 10000)).toBe(1300);
  });
});

describe("courseLengthM", () => {
  it("converts paper mm to terrain meters via the map scale", () => {
    // 100 mm on a 1:10000 map = 1000 m in terrain.
    expect(courseLengthM([60, 40], 10000)).toBe(1000);
  });

  it("rounds to whole meters", () => {
    // 10.05 mm at 1:10000 → 100.5 m → 101.
    expect(courseLengthM([10.05], 10000)).toBe(101);
  });

  it("returns 0 for an empty distance list", () => {
    expect(courseLengthM([], 10000)).toBe(0);
  });
});
