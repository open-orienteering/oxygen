/**
 * `isOcdGeometryStaleVsXml` decides whether a previously-stored OCD
 * geometry (high-fidelity, baked in by the operator) should be kept
 * when an IOF XML re-import brings in a fresh straight-line geometry.
 *
 * The rule is: keep OCD unless the *average* drift between matched
 * control points exceeds 30 metres. Points are joined by
 * `properties.id` (the control UUID/seq), so unmatched points on
 * either side are silently skipped — adding or removing a control
 * never on its own marks the OCD as stale.
 *
 * Distances are computed in WGS84 with the standard 111 km/degree
 * approximation, so the test fixtures here use lat/lng coordinates
 * (degrees) rather than mm-on-paper.
 */

import { describe, it, expect } from "vitest";
import { isOcdGeometryStaleVsXml } from "../routers/course.js";
import type {
  GeoJSONFeature,
  GeoJSONFeatureCollection,
} from "../iof-course-parser.js";

/** Build a minimal FeatureCollection of control points keyed by `id`. */
function fc(
  points: Array<{ id: string; lng: number; lat: number }>,
): GeoJSONFeatureCollection {
  const features: GeoJSONFeature[] = points.map((p) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [p.lng, p.lat] },
    properties: { id: p.id, symbolType: "control" },
  }));
  return { type: "FeatureCollection", features };
}

/** Offset a lat/lng by `metersN/E` — small enough that the linear
 *  approximation isOcdGeometryStaleVsXml uses is correct. */
function offsetLng(centerLat: number, meters: number): number {
  return meters / (111_000 * Math.cos((centerLat * Math.PI) / 180));
}
function offsetLat(meters: number): number {
  return meters / 111_000;
}

const STOCKHOLM_LAT = 59.32;
const STOCKHOLM_LNG = 18.07;

describe("isOcdGeometryStaleVsXml", () => {
  it("returns false when XML has no points to compare against", () => {
    const ocd = fc([{ id: "1", lng: STOCKHOLM_LNG, lat: STOCKHOLM_LAT }]);
    const xml: GeoJSONFeatureCollection = {
      type: "FeatureCollection",
      features: [],
    };
    expect(isOcdGeometryStaleVsXml(ocd, xml)).toBe(false);
  });

  it("treats identical positions as not stale", () => {
    const points = [
      { id: "1", lng: STOCKHOLM_LNG, lat: STOCKHOLM_LAT },
      { id: "2", lng: STOCKHOLM_LNG + offsetLng(STOCKHOLM_LAT, 100), lat: STOCKHOLM_LAT },
      { id: "3", lng: STOCKHOLM_LNG, lat: STOCKHOLM_LAT + offsetLat(100) },
    ];
    expect(isOcdGeometryStaleVsXml(fc(points), fc(points))).toBe(false);
  });

  it("accepts small drifts (<30 m average)", () => {
    const ocd = fc([
      { id: "1", lng: STOCKHOLM_LNG, lat: STOCKHOLM_LAT },
      { id: "2", lng: STOCKHOLM_LNG, lat: STOCKHOLM_LAT },
    ]);
    // Shift one point ~20 m east — average drift = 10 m.
    const xml = fc([
      { id: "1", lng: STOCKHOLM_LNG + offsetLng(STOCKHOLM_LAT, 20), lat: STOCKHOLM_LAT },
      { id: "2", lng: STOCKHOLM_LNG, lat: STOCKHOLM_LAT },
    ]);
    expect(isOcdGeometryStaleVsXml(ocd, xml)).toBe(false);
  });

  it("flags a control moved far beyond tolerance (>30 m average)", () => {
    const ocd = fc([{ id: "1", lng: STOCKHOLM_LNG, lat: STOCKHOLM_LAT }]);
    // 100 m east — well over the 30 m threshold.
    const xml = fc([
      { id: "1", lng: STOCKHOLM_LNG + offsetLng(STOCKHOLM_LAT, 100), lat: STOCKHOLM_LAT },
    ]);
    expect(isOcdGeometryStaleVsXml(ocd, xml)).toBe(true);
  });

  it("ignores XML points whose id is absent from the OCD geometry", () => {
    const ocd = fc([{ id: "1", lng: STOCKHOLM_LNG, lat: STOCKHOLM_LAT }]);
    // Matching pair drifts 5 m; an extra XML id "2" 1 km away must be
    // ignored (it can't be paired with anything in OCD).
    const xml = fc([
      { id: "1", lng: STOCKHOLM_LNG + offsetLng(STOCKHOLM_LAT, 5), lat: STOCKHOLM_LAT },
      { id: "2", lng: STOCKHOLM_LNG + offsetLng(STOCKHOLM_LAT, 1000), lat: STOCKHOLM_LAT },
    ]);
    expect(isOcdGeometryStaleVsXml(ocd, xml)).toBe(false);
  });

  it("returns false when no control ids match between the two sets", () => {
    const ocd = fc([{ id: "1", lng: STOCKHOLM_LNG, lat: STOCKHOLM_LAT }]);
    const xml = fc([
      { id: "999", lng: STOCKHOLM_LNG + offsetLng(STOCKHOLM_LAT, 5000), lat: STOCKHOLM_LAT },
    ]);
    // pairs === 0 → not stale (insufficient data to make a call).
    expect(isOcdGeometryStaleVsXml(ocd, xml)).toBe(false);
  });

  it("averages over many points before flagging", () => {
    // Three points: two perfectly aligned, one shifted 60 m → average
    // drift = 20 m, below threshold → keep OCD.
    const ocd = fc([
      { id: "1", lng: STOCKHOLM_LNG, lat: STOCKHOLM_LAT },
      { id: "2", lng: STOCKHOLM_LNG, lat: STOCKHOLM_LAT },
      { id: "3", lng: STOCKHOLM_LNG, lat: STOCKHOLM_LAT },
    ]);
    const xml = fc([
      { id: "1", lng: STOCKHOLM_LNG, lat: STOCKHOLM_LAT },
      { id: "2", lng: STOCKHOLM_LNG, lat: STOCKHOLM_LAT },
      { id: "3", lng: STOCKHOLM_LNG + offsetLng(STOCKHOLM_LAT, 60), lat: STOCKHOLM_LAT },
    ]);
    expect(isOcdGeometryStaleVsXml(ocd, xml)).toBe(false);
  });
});
