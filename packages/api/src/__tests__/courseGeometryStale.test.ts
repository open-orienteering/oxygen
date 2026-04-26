import { describe, it, expect } from "vitest";
import { isOcdGeometryStaleVsXml } from "../routers/course.js";
import type {
  GeoJSONFeature,
  GeoJSONFeatureCollection,
} from "../iof-course-parser.js";

/**
 * Build a minimal FeatureCollection consisting of Point features (in order)
 * matching the shape the OCD parser and XML straight-line builder produce.
 */
function fc(
  points: Array<{ code: string; xMm: number; yMm: number }>,
): GeoJSONFeatureCollection {
  const features: GeoJSONFeature[] = points.map((p) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [p.xMm, p.yMm] },
    properties: { symbolType: "control", code: p.code },
  }));
  return { type: "FeatureCollection", features };
}

describe("isOcdGeometryStaleVsXml", () => {
  it("treats identical positions and sequence as not stale", () => {
    const a = fc([
      { code: "31", xMm: 100, yMm: 200 },
      { code: "32", xMm: 110, yMm: 210 },
      { code: "33", xMm: 120, yMm: 220 },
    ]);
    const b = fc([
      { code: "31", xMm: 100, yMm: 200 },
      { code: "32", xMm: 110, yMm: 210 },
      { code: "33", xMm: 120, yMm: 220 },
    ]);
    expect(isOcdGeometryStaleVsXml(a, b)).toBe(false);
  });

  it("absorbs sub-tolerance floating-point jitter", () => {
    const ocd = fc([
      { code: "31", xMm: 100, yMm: 200 },
      { code: "32", xMm: 110, yMm: 210 },
    ]);
    const xml = fc([
      { code: "31", xMm: 100.0001, yMm: 199.9999 },
      { code: "32", xMm: 110.2, yMm: 210.1 },
    ]);
    expect(isOcdGeometryStaleVsXml(ocd, xml)).toBe(false);
  });

  it("flags a single control moved beyond tolerance", () => {
    const ocd = fc([
      { code: "31", xMm: 100, yMm: 200 },
      { code: "32", xMm: 110, yMm: 210 },
      { code: "33", xMm: 120, yMm: 220 },
    ]);
    const xml = fc([
      { code: "31", xMm: 100, yMm: 200 },
      { code: "32", xMm: 115, yMm: 210 }, // moved 5 mm in X
      { code: "33", xMm: 120, yMm: 220 },
    ]);
    expect(isOcdGeometryStaleVsXml(ocd, xml)).toBe(true);
  });

  it("flags shift just over tolerance (anisotropic Euclidean)", () => {
    // Shift by 0.4 mm in both X and Y → distance ≈ 0.566 mm > 0.5 mm tol
    const ocd = fc([{ code: "31", xMm: 100, yMm: 200 }]);
    const xml = fc([{ code: "31", xMm: 100.4, yMm: 200.4 }]);
    expect(isOcdGeometryStaleVsXml(ocd, xml)).toBe(true);
  });

  it("does not flag shift just under tolerance", () => {
    // Shift by 0.3 mm in both X and Y → distance ≈ 0.424 mm < 0.5 mm tol
    const ocd = fc([{ code: "31", xMm: 100, yMm: 200 }]);
    const xml = fc([{ code: "31", xMm: 100.3, yMm: 200.3 }]);
    expect(isOcdGeometryStaleVsXml(ocd, xml)).toBe(false);
  });

  it("flags a control inserted into the sequence", () => {
    const ocd = fc([
      { code: "31", xMm: 100, yMm: 200 },
      { code: "33", xMm: 120, yMm: 220 },
    ]);
    const xml = fc([
      { code: "31", xMm: 100, yMm: 200 },
      { code: "32", xMm: 110, yMm: 210 },
      { code: "33", xMm: 120, yMm: 220 },
    ]);
    expect(isOcdGeometryStaleVsXml(ocd, xml)).toBe(true);
  });

  it("flags a reordered sequence even with identical positions", () => {
    const ocd = fc([
      { code: "31", xMm: 100, yMm: 200 },
      { code: "32", xMm: 110, yMm: 210 },
      { code: "33", xMm: 120, yMm: 220 },
    ]);
    const xml = fc([
      { code: "31", xMm: 100, yMm: 200 },
      { code: "33", xMm: 120, yMm: 220 },
      { code: "32", xMm: 110, yMm: 210 },
    ]);
    expect(isOcdGeometryStaleVsXml(ocd, xml)).toBe(true);
  });

  it("ignores XML codes that are not in the OCD geometry", () => {
    // Edge case: the XML lists more controls (eg. visited but not present
    // in old OCD), but the sequences match by length/order — still treated
    // as stale since the sequences differ.
    const ocd = fc([
      { code: "31", xMm: 100, yMm: 200 },
      { code: "32", xMm: 110, yMm: 210 },
    ]);
    const xml = fc([
      { code: "31", xMm: 100, yMm: 200 },
      { code: "99", xMm: 110, yMm: 210 },
    ]);
    expect(isOcdGeometryStaleVsXml(ocd, xml)).toBe(true);
  });

  it("keeps OCD when XML has no usable Point positions", () => {
    // If the XML didn't carry mapX/mapY (e.g. an export from a system that
    // omits MapPosition), the straight-line builder yields zero points.
    // Don't downgrade OCD to nothing in that case.
    const ocd = fc([
      { code: "31", xMm: 100, yMm: 200 },
      { code: "32", xMm: 110, yMm: 210 },
    ]);
    const xml: GeoJSONFeatureCollection = {
      type: "FeatureCollection",
      features: [],
    };
    expect(isOcdGeometryStaleVsXml(ocd, xml)).toBe(false);
  });

  it("respects a custom tolerance", () => {
    const ocd = fc([{ code: "31", xMm: 100, yMm: 200 }]);
    const xml = fc([{ code: "31", xMm: 102, yMm: 200 }]); // 2 mm shift
    expect(isOcdGeometryStaleVsXml(ocd, xml, 5)).toBe(false);
    expect(isOcdGeometryStaleVsXml(ocd, xml, 1)).toBe(true);
  });
});
