import { describe, expect, it } from "vitest";
import { clusterMeridians, foldLineAngleDeg, lineTiltDeg, MERIDIAN_MAX_STDDEV_DEG, MERIDIAN_MIN_COUNT } from "../north.js";

describe("foldLineAngleDeg / lineTiltDeg", () => {
  it("folds opposite directions onto the same undirected angle", () => {
    expect(foldLineAngleDeg(-176.7)).toBeCloseTo(3.3, 5);
    expect(foldLineAngleDeg(176.7)).toBeCloseTo(-3.3, 5);
    expect(foldLineAngleDeg(3.3)).toBeCloseTo(3.3, 5);
  });
  it("measures tilt from paper +Y, clockwise positive, folded", () => {
    expect(lineTiltDeg(0, 0, 0, 1000)).toBe(0);
    expect(lineTiltDeg(0, 1000, 0, 0)).toBe(0);
    expect(lineTiltDeg(0, 0, 1000, 1000)).toBeCloseTo(45, 9);
    expect(lineTiltDeg(0, 0, -1000, 1000)).toBeCloseTo(-45, 9);
  });
});

describe("clusterMeridians", () => {
  const near = (n: number, tilt: number) => Array.from({ length: n }, (_, i) => tilt + (i % 2 ? 0.05 : -0.05));

  it("returns the median tilt of a dense near-parallel cluster", () => {
    const r = clusterMeridians(new Map([[7, near(12, 3.3)]]))!;
    expect(r.key).toBe(7);
    expect(r.count).toBe(12);
    expect(r.medianTiltDeg).toBeCloseTo(3.35, 9);
    expect(r.stddevDeg).toBeCloseTo(0.05, 9);
  });

  it("rejects clusters below the count or above the spread threshold", () => {
    expect(clusterMeridians(new Map([[1, near(MERIDIAN_MIN_COUNT - 1, 0)]]))).toBeNull();
    const scattered = Array.from({ length: 12 }, (_, i) => (i % 2 ? 1 : -1) * (MERIDIAN_MAX_STDDEV_DEG + 0.5));
    expect(clusterMeridians(new Map([[1, scattered]]))).toBeNull();
  });

  it("prefers the larger cluster; ties keep the first key", () => {
    expect(clusterMeridians(new Map([[1, near(10, 0)], [2, near(14, 1)]]))!.key).toBe(2);
    expect(clusterMeridians(new Map([[1, near(10, 0)], [2, near(10, 1)]]))!.key).toBe(1);
  });
});
