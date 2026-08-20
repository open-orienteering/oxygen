/**
 * Unit tests for the editor course-geometry builder.
 *
 * These cover the pure math used when the course editor (or a control
 * position change) regenerates a course's GeoJSON overlay: point/leg
 * feature construction, unpositioned-control handling, leg distances and
 * the paper-mm → terrain-meters length computation.
 */

import { describe, it, expect } from "vitest";
import {
  buildEditorGeometry,
  legDistancesMm,
  courseLengthM,
  type GeometrySeqControl,
} from "../course-geometry.js";

const seq = (
  entries: Array<[string, GeometrySeqControl["type"], number, number]>,
): GeometrySeqControl[] =>
  entries.map(([code, type, xMm, yMm]) => ({ code, type, xMm, yMm }));

describe("buildEditorGeometry", () => {
  it("builds point features and straight legs for an ordered sequence", () => {
    const fc = buildEditorGeometry(
      seq([
        ["S1", "Start", 0, 10],
        ["31", "Control", 30, 10],
        ["32", "Control", 30, 50],
        ["F1", "Finish", 60, 50],
      ]),
    );

    const points = fc.features.filter((f) => f.geometry.type === "Point");
    const legs = fc.features.filter((f) => f.geometry.type === "LineString");
    expect(points).toHaveLength(4);
    expect(legs).toHaveLength(3);

    expect(points[0].properties).toMatchObject({ symbolType: "start", code: "S1", id: "S1" });
    expect(points[1].properties).toMatchObject({ symbolType: "control", code: "31" });
    expect(points[3].properties).toMatchObject({ symbolType: "finish", code: "F1" });

    expect(legs[0].properties).toMatchObject({ symbolType: "leg", from: "S1", to: "31" });
    expect(legs[0].geometry).toEqual({
      type: "LineString",
      coordinates: [
        [0, 10],
        [30, 10],
      ],
    });
    expect(legs[2].properties).toMatchObject({ from: "32", to: "F1" });
  });

  it("skips unpositioned (0,0) controls and connects across them", () => {
    const fc = buildEditorGeometry(
      seq([
        ["31", "Control", 10, 10],
        ["32", "Control", 0, 0], // never placed on the map
        ["33", "Control", 50, 10],
      ]),
    );
    const points = fc.features.filter((f) => f.geometry.type === "Point");
    const legs = fc.features.filter((f) => f.geometry.type === "LineString");
    expect(points.map((p) => p.properties.code)).toEqual(["31", "33"]);
    expect(legs).toHaveLength(1);
    expect(legs[0].properties).toMatchObject({ from: "31", to: "33" });
  });

  it("returns an empty collection when nothing is positioned", () => {
    const fc = buildEditorGeometry(
      seq([
        ["31", "Control", 0, 0],
        ["32", "Control", 0, 0],
      ]),
    );
    expect(fc.features).toHaveLength(0);
  });

  it("a single positioned control yields one point and no legs", () => {
    const fc = buildEditorGeometry(seq([["31", "Control", 5, 5]]));
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].geometry.type).toBe("Point");
  });
});

describe("legDistancesMm", () => {
  it("computes euclidean distances between consecutive positioned controls", () => {
    const d = legDistancesMm(
      seq([
        ["S1", "Start", 0, 10],
        ["31", "Control", 30, 50], // 3-4-5 triangle → 50 mm
        ["32", "Control", 30, 110], // 60 mm
      ]),
    );
    expect(d).toEqual([50, 60]);
  });

  it("ignores unpositioned controls", () => {
    const d = legDistancesMm(
      seq([
        ["31", "Control", 0, 10],
        ["32", "Control", 0, 0],
        ["33", "Control", 0, 40], // 30 mm from control 31
      ]),
    );
    expect(d).toEqual([30]);
  });

  it("is empty for fewer than two positioned controls", () => {
    expect(legDistancesMm(seq([["31", "Control", 5, 5]]))).toEqual([]);
    expect(legDistancesMm([])).toEqual([]);
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
