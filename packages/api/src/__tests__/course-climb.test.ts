import { describe, expect, it } from "vitest";
import type { TerrainSampler } from "@oxygen/shared/src/terrain/profile/index.js";
import { climbFieldSource, computedClimbM, isTypedClimb, statedClimb } from "../course-climb.js";

/** A plane rising 10 % along x at 1:10 000; no data left of `from`. */
const plane = (from = -Infinity): TerrainSampler => ({
  heightAt: (p) => (p.x < from ? null : p.x * 10 * 0.1),
  confidentAt: () => true,
  groundMPerMm: 10,
  cellM: 2,
  datum: "relative",
  source: "contours",
});
const leg = (...xs: number[]) => ({ points: xs.map((x) => ({ x, y: 0 })) });

describe("the course's stored climb (docs/course-elevation.md §6)", () => {
  it("a stated climb above 0 carries its source; none hands the climb back", () => {
    expect(statedClimb(85, "manual")).toEqual({ climbM: 85, climbSource: "manual" });
    expect(statedClimb(84.6, "file")).toEqual({ climbM: 85, climbSource: "file" });
    for (const none of [0, null, undefined, -3, Number.NaN]) expect(statedClimb(none, "manual")).toEqual({ climbM: 0, climbSource: null });
  });

  it("typed: manual, file, or a climb without a source; not a computed one, not an empty one", () => {
    expect(isTypedClimb({ climbM: 85, climbSource: "manual" })).toBe(true);
    expect(isTypedClimb({ climbM: 85, climbSource: "file" })).toBe(true);
    expect(isTypedClimb({ climbM: 85, climbSource: null })).toBe(true);
    expect(isTypedClimb({ climbM: 85, climbSource: "computed" })).toBe(false);
    expect(isTypedClimb({ climbM: 0, climbSource: null })).toBe(false);
  });

  it("the picked field's row source", () => {
    const provider = { id: "lantmateriet-2m", grade: "anchor" as const, attribution: "© Lantmäteriet" };
    expect(climbFieldSource({ url: "u", basis: "contours", provider: null })).toBe("contours");
    expect(climbFieldSource({ url: "u", basis: "contours", provider })).toBe("contours.lantmateriet-2m");
    expect(climbFieldSource({ url: "u", basis: "ground", provider })).toBe("ground.lantmateriet-2m");
  });

  it("the climb to store is the course's, in whole metres, one pass over its legs", () => {
    // 20 mm east = 200 m at 10 %: 20 m up; then 5 mm back: 5 m down; then up again 10 m.
    expect(computedClimbM([leg(0, 20), leg(20, 15), leg(15, 25)], plane())).toBe(30);
  });

  it("nothing to store: no legs, no length, a course that only descends, a partial profile", () => {
    expect(computedClimbM([], plane())).toBeNull();
    expect(computedClimbM([leg(5, 5)], plane())).toBeNull();
    expect(computedClimbM([leg(20, 0)], plane())).toBeNull();
    expect(computedClimbM([leg(0, 20)], plane(10))).toBeNull();
  });
});
