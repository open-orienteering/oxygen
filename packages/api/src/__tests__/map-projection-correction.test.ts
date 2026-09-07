import { describe, it, expect } from "vitest";
import {
  ocadToWgs84,
  wgs84ToOcad,
  withGrivationCorrection,
  type OcadCrs,
} from "../map-projection.js";

/** Minimal SWEREF99 TM-like CRS for unit tests (no real OCAD file needed). */
function makeCrs(grivationRad: number): OcadCrs {
  const easting = 650_000;
  const northing = 6_580_000;
  const scale = 10_000;
  return {
    easting,
    northing,
    scale,
    grivation: grivationRad,
    code: 3006,
    catalog: "EPSG",
    toProjectedCoord([x, y]: number[]): number[] {
      const cosG = Math.cos(-grivationRad);
      const sinG = Math.sin(-grivationRad);
      const rx = x * cosG - y * sinG;
      const ry = x * sinG + y * cosG;
      const factor = scale / 100_000;
      return [rx * factor + easting, ry * factor + northing];
    },
  };
}

describe("withGrivationCorrection", () => {
  it("returns the same CRS when correction is zero", () => {
    const crs = makeCrs(0.05);
    expect(withGrivationCorrection(crs, 0)).toBe(crs);
  });

  it("adds degrees (CW) to grivation in radians", () => {
    const crs = makeCrs(0);
    const corrected = withGrivationCorrection(crs, 11);
    expect(corrected.grivation).toBeCloseTo((11 * Math.PI) / 180, 12);
  });

  it("composes with an existing file grivation", () => {
    const fileG = (2.8 * Math.PI) / 180;
    const crs = makeCrs(fileG);
    const corrected = withGrivationCorrection(crs, 8.2);
    expect(corrected.grivation).toBeCloseTo(fileG + (8.2 * Math.PI) / 180, 12);
  });

  it("round-trips OCAD ↔ WGS84 with the corrected grivation", () => {
    const crs = withGrivationCorrection(makeCrs(0), 11);
    const x = 12_345;
    const y = -67_890;
    const wgs = ocadToWgs84(x, y, crs);
    expect(wgs).not.toBeNull();
    const back = wgs84ToOcad(wgs!.lat, wgs!.lng, crs);
    expect(back).not.toBeNull();
    expect(back!.x).toBeCloseTo(x, 4);
    expect(back!.y).toBeCloseTo(y, 4);
  });

  it("shifts projected coordinates relative to uncorrected CRS", () => {
    const base = makeCrs(0);
    const corrected = withGrivationCorrection(base, 11);
    const [x, y] = [10_000, 20_000];
    const p0 = base.toProjectedCoord([x, y]);
    const p1 = corrected.toProjectedCoord([x, y]);
    // Same paper point must land at a different grid position once
    // grivation changes — otherwise the wrapper is a no-op.
    const dist = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    expect(dist).toBeGreaterThan(1);
  });
});
