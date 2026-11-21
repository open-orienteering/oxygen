import { describe, expect, it } from "vitest";
import type { CourseProfile } from "@oxygen/shared/src/terrain/profile/index.js";
import { boundLabels, decimate, graphPaths, graphScale, heightAtDistance, legAt, legBounds, niceTicks, profilePoints, readProfileOpen, writeProfileOpen, PROFILE_PREF_KEY, type GraphPoint } from "../profile-graph";

const leg = (offsetM: number, zs: (number | null)[], stepM = 10) => ({
  offsetM, climbM: 0, descentM: 0,
  profile: { lengthM: (zs.length - 1) * stepM, samples: zs.map((zM, i) => ({ dM: i * stepM, zM, confident: true })), climbM: 0, descentM: 0, netM: null, coverage: 1, confidence: 1 },
});
const profile = { legs: [leg(0, [10, 12, 14]), leg(20, [14, null, 8, 6])], lengthM: 50, climbM: 4, descentM: 8, coverage: 1, confidence: 1, partial: false } as unknown as CourseProfile;
const box = { width: 520, height: 160, left: 20, right: 0, top: 10, bottom: 10 };

describe("the profile graph's model (docs/course-elevation.md §5)", () => {
  it("points run along the course, each on its leg; the bounds are the controls", () => {
    const pts = profilePoints(profile);
    expect(pts.map((p) => p.dM)).toEqual([0, 10, 20, 20, 30, 40, 50]);
    expect(pts.map((p) => p.leg)).toEqual([0, 0, 0, 1, 1, 1, 1]);
    expect(legBounds(profile)).toEqual([0, 20, 50]);
  });

  it("a distance lies on the leg it starts; the end is the last leg's", () => {
    const b = [0, 20, 50];
    expect([0, 19.9, 20, 49, 50, 80].map((d) => legAt(b, d))).toEqual([0, 0, 1, 1, 1, 1]);
  });

  it("ticks are round and inside the range", () => {
    expect(niceTicks(0, 100, 4)).toEqual([0, 50, 100]);
    expect(niceTicks(3, 47, 5)).toEqual([10, 20, 30, 40]);
    expect(niceTicks(0, 3200, 6)).toEqual([0, 1000, 2000, 3000]);
    expect(niceTicks(5, 5, 3)).toEqual([5]);
  });

  it("the scale spans at least 10 m, on tick values, and maps both ways", () => {
    const flat: GraphPoint[] = [{ dM: 0, zM: 100, leg: 0 }, { dM: 500, zM: 101, leg: 0 }];
    const s = graphScale(flat, 500, box);
    expect(s.zMax - s.zMin).toBeGreaterThanOrEqual(10);
    expect(s.x(0)).toBe(20);
    expect(s.x(500)).toBe(520);
    expect(s.y(s.zMin)).toBe(150);
    expect(s.y(s.zMax)).toBe(10);
    expect(s.dAt(270)).toBeCloseTo(250, 6);
    expect(s.dAt(-5)).toBe(0);
    expect(s.dAt(9999)).toBe(500);
    expect(s.zTicks.every((z) => z >= s.zMin && z <= s.zMax)).toBe(true);
  });

  it("the height axis ends on ticks and has at least two, whatever the range", () => {
    for (const [lo, hi] of [[0, 45], [0, 450], [103, 148], [212, 239], [0, 3], [-7, 12]]) {
      const s = graphScale([{ dM: 0, zM: lo, leg: 0 }, { dM: 100, zM: hi, leg: 0 }], 100, { ...box, height: 104 });
      expect(s.zTicks.length, `${lo}–${hi}`).toBeGreaterThanOrEqual(2);
      expect(s.zTicks[0]).toBe(s.zMin);
      expect(s.zTicks[s.zTicks.length - 1]).toBe(s.zMax);
      expect(s.zMin).toBeLessThanOrEqual(lo);
      expect(s.zMax).toBeGreaterThanOrEqual(hi);
    }
  });

  it("distance ticks step by a round number of metres", () => {
    const s = graphScale([{ dM: 0, zM: 0, leg: 0 }, { dM: 480, zM: 5, leg: 0 }], 480, box);
    expect(s.dTicks[0]).toBe(0);
    expect(new Set(s.dTicks.slice(1).map((d, i) => d - s.dTicks[i]))).toEqual(new Set([s.dStep]));
    expect(s.dTicks.every((d) => d <= 480)).toBe(true);
  });

  it("a course without data still has a scale", () => {
    const s = graphScale([{ dM: 0, zM: null, leg: 0 }], 100, box);
    expect(Number.isFinite(s.y(0))).toBe(true);
  });

  it("the line breaks where there is no data; the area closes on the baseline", () => {
    const pts = profilePoints(profile);
    const s = graphScale(pts, 50, box);
    const { line, area } = graphPaths(pts, s, 150);
    expect(line.match(/M/g)).toHaveLength(2);
    expect(area.match(/Z/g)).toHaveLength(2);
    expect(area.startsWith("M20,150L")).toBe(true);
  });

  it("decimation keeps each column's lowest and highest point and every gap", () => {
    const pts: GraphPoint[] = Array.from({ length: 1000 }, (_, i) => ({ dM: i, zM: i === 500 ? null : i === 123 ? 99 : i === 777 ? -99 : Math.sin(i), leg: 0 }));
    const out = decimate(pts, 999, 50);
    expect(out.length).toBeLessThanOrEqual(154);
    expect(out.some((p) => p.zM === 99)).toBe(true);
    expect(out.some((p) => p.zM === -99)).toBe(true);
    expect(out.some((p) => p.zM === null)).toBe(true);
    expect(out.map((p) => p.dM)).toEqual([...out.map((p) => p.dM)].sort((a, b) => a - b));
    expect(decimate(pts.slice(0, 20), 19, 50)).toHaveLength(20);
    // Each run's ends stay: the line reaches the start, the finish and both sides of the gap.
    for (const d of [0, 499, 501, 999]) expect(out.some((p) => p.dM === d), String(d)).toBe(true);
  });

  it("the height at a distance is read between the points; null in a gap and outside", () => {
    const pts = profilePoints(profile);
    expect(heightAtDistance(pts, 5)).toBe(11);
    expect(heightAtDistance(pts, 20)).toBe(14);
    expect(heightAtDistance(pts, 25)).toBeNull();
    expect(heightAtDistance(pts, 45)).toBe(7);
    expect(heightAtDistance(pts, 51)).toBeNull();
    expect(heightAtDistance([], 0)).toBeNull();
  });

  it("control labels thin out when crowded; the first and the last stay", () => {
    const x = (d: number) => d;
    expect(boundLabels([0, 100, 200], x)).toEqual([0, 1, 2]);
    expect(boundLabels([0, 5, 20, 45, 50], x)).toEqual([0, 2, 4]);
  });

  it("the panel's preference is kept per device and survives a storage that throws", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(readProfileOpen(storage)).toBe(false);
    writeProfileOpen(storage, true);
    expect(store.get(PROFILE_PREF_KEY)).toBe("open");
    expect(readProfileOpen(storage)).toBe(true);
    writeProfileOpen(storage, false);
    expect(readProfileOpen(storage)).toBe(false);
    const broken = { getItem: () => { throw new Error("no"); }, setItem: () => { throw new Error("no"); } };
    expect(readProfileOpen(broken)).toBe(false);
    expect(() => writeProfileOpen(broken, true)).not.toThrow();
    expect(readProfileOpen(null)).toBe(false);
  });
});
