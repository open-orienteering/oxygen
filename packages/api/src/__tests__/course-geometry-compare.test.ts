/** Old vs new `courses.geometry` comparison (`course-geometry-compare.ts`). */

import { describe, it, expect } from "vitest";
import { compareEditorGeometry, importedCourseFidelity, type GeometryLike } from "../course-geometry-compare.js";
import { editorCourseGeometry, type GeometrySeqControl } from "../course-geometry.js";

const seq: GeometrySeqControl[] = [
  { id: "s", code: "S1", type: "Start", xMm: 0, yMm: -10 },
  { id: "a", code: "31", type: "Control", xMm: 10, yMm: 0 },
  { id: "b", code: "32", type: "Control", xMm: 40, yMm: 0 },
  { id: "f", code: "F1", type: "Finish", xMm: 40, yMm: 20 },
];
const features = [{ x: 12.5, y: 0, r: 0.2 }, { x: 25, y: 0.2, r: 0.2 }];
const clone = (g: GeometryLike): GeometryLike => JSON.parse(JSON.stringify(g));

describe("compareEditorGeometry", () => {
  const now = editorCourseGeometry("c", seq, "ordered", features);

  it("reports nothing for identical geometry", () => {
    const r = compareEditorGeometry(clone(now), now);
    expect(r).toEqual({ structure: [], circles: { compared: 2, same: 2, diffs: [] }, legs: { compared: 3, same: 3, diffs: [] } });
  });

  it("reports a changed slit with both widths, and an added and a removed gap", () => {
    const old = clone(now);
    const c31 = old.features.find((f) => f.properties?.code === "31")!;
    c31.properties!.cuts = [{ start: 80, end: 100 }];
    const legS = old.features.find((f) => f.properties?.from === "S1")!;
    legS.properties!.gaps = [{ from: 0.4, to: 0.5 }];
    const leg31 = old.features.find((f) => f.properties?.from === "31")!;
    delete leg31.properties!.gaps;
    const r = compareEditorGeometry(old, now);
    expect(r.structure).toEqual([]);
    expect(r.circles.diffs).toHaveLength(1);
    expect(r.circles.diffs[0]).toMatchObject({ key: "31", status: "changed", oldWidth: 20 });
    expect(r.circles.diffs[0].newWidth).toBeGreaterThan(20);
    expect(r.legs.diffs.map((d) => [d.key, d.status])).toEqual([["S1→31", "removed"], ["31→32", "added"]]);
    expect(r.legs.diffs[1].newWidth).toBeGreaterThan(1);
  });

  it("flags a stale row and leaves the moved control and its legs out of the comparison", () => {
    const moved = editorCourseGeometry("c", seq.map((c) => (c.code === "32" ? { ...c, xMm: 41 } : c)), "ordered", features);
    const r = compareEditorGeometry(moved, now);
    expect(r.structure).toEqual(["32 moved"]);
    expect(r.circles).toEqual({ compared: 1, same: 1, diffs: [] });
    expect(r.legs).toEqual({ compared: 1, same: 1, diffs: [] });
  });
});

describe("importedCourseFidelity", () => {
  const imported: GeometryLike = {
    features: [
      { geometry: { type: "Point", coordinates: [0, 0] }, properties: { symbolType: "start", code: "S1" } },
      { geometry: { type: "Point", coordinates: [20, 0] }, properties: { symbolType: "control", code: "31", cuts: [{ start: 80, end: 100 }] } },
      { geometry: { type: "Point", coordinates: [40, 0] }, properties: { symbolType: "control", code: "32" } },
      { geometry: { type: "Point", coordinates: [60, 0] }, properties: { symbolType: "control", code: "33", cuts: [{ start: 170, end: 190 }] } },
      { geometry: { type: "Point", coordinates: [80, 0] }, properties: { symbolType: "finish", code: "F1" } },
      // S1→31: clipped straight, in two pieces.
      { geometry: { type: "LineString", coordinates: [[4, 0], [9, 0]] }, properties: { symbolType: "leg", from: "S1", to: "31", preclipped: true } },
      { geometry: { type: "LineString", coordinates: [[10, 0], [17, 0]] }, properties: { symbolType: "leg", from: "S1", to: "31", preclipped: true } },
      // 31→32: bent 2 mm round something.
      { geometry: { type: "LineString", coordinates: [[23, 0], [30, 2], [37, 0]] }, properties: { symbolType: "leg", from: "31", to: "32", preclipped: true } },
      // 32→33, 33→F1: straight fallback legs.
      { geometry: { type: "LineString", coordinates: [[40, 0], [60, 0]] }, properties: { symbolType: "leg", from: "32", to: "33" } },
      { geometry: { type: "LineString", coordinates: [[60, 0], [80, 0]] }, properties: { symbolType: "leg", from: "33", to: "F1" } },
      { geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, properties: { symbolType: "restricted_area" } },
      { geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, properties: { symbolType: "description_box" } },
    ],
  };

  it("counts bent legs, authored vs automatic cuts and the extras", () => {
    // A boulder on 31's east rim (agrees with its authored 80–100°), one on 32's rim, none at 33.
    const f = importedCourseFidelity(imported, [{ x: 22.5, y: 0, r: 0.2 }, { x: 40, y: 2.5, r: 0.2 }]);
    expect(f).toMatchObject({ legs: 4, preclippedLegs: 2, bentLegs: 1, authoredCutControls: 2, cutAgreement: { both: 1, authoredOnly: 1, automaticOnly: 1 }, extras: { restricted_area: 1, description_box: 1 } });
    expect(f.maxBendMm).toBeCloseTo(2, 9);
  });

  it("without a map every authored cut is authored-only", () => {
    expect(importedCourseFidelity(imported, null).cutAgreement).toEqual({ both: 0, authoredOnly: 2, automaticOnly: 0 });
  });
});
