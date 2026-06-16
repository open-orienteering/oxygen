import { describe, it, expect } from "vitest";
import type { ReplayWaypoint } from "@oxygen/shared";
import {
  computeSmoothedSpeeds,
  normalizeSpeeds,
  speedColor,
  tickPositions,
} from "../speed-color";

/** Build a straight east-west track at a constant time step. */
function straightTrack(
  count: number,
  stepMs: number,
  metresPerStep: number,
): ReplayWaypoint[] {
  // ~111320 m per degree latitude; move north so cos(lat) ~ 1 and is exact.
  const degPerStep = metresPerStep / 111320;
  const wps: ReplayWaypoint[] = [];
  for (let i = 0; i < count; i++) {
    wps.push({ timeMs: i * stepMs, lat: i * degPerStep, lng: 0 });
  }
  return wps;
}

describe("speedColor", () => {
  it("maps the ramp stops to their exact colours", () => {
    expect(speedColor(0)).toBe("rgb(30, 64, 175)");
    expect(speedColor(0.5)).toBe("rgb(34, 211, 238)");
    expect(speedColor(1)).toBe("rgb(74, 222, 128)");
  });

  it("clamps out-of-range and non-finite inputs to the ramp ends", () => {
    expect(speedColor(-3)).toBe(speedColor(0));
    expect(speedColor(99)).toBe(speedColor(1));
    expect(speedColor(NaN)).toBe(speedColor(0));
  });

  it("interpolates within a segment", () => {
    // Quarter of the way from blue(30,64,175) to cyan(34,211,238).
    expect(speedColor(0.25)).toBe("rgb(32, 138, 207)");
  });
});

describe("computeSmoothedSpeeds", () => {
  it("recovers a constant pace on a straight track", () => {
    // 10 m every 1 s -> 10 m/s.
    const wps = straightTrack(20, 1000, 10);
    const speeds = computeSmoothedSpeeds(wps, [], 12_000);
    for (const s of speeds) {
      expect(s).toBeCloseTo(10, 5);
    }
  });

  it("reports a faster leg as a higher speed", () => {
    // First half 5 m/s, second half 20 m/s (small window so legs stay distinct).
    const wps: ReplayWaypoint[] = [];
    let lat = 0;
    for (let i = 0; i < 10; i++) {
      wps.push({ timeMs: i * 1000, lat, lng: 0 });
      lat += 5 / 111320;
    }
    for (let i = 10; i < 20; i++) {
      wps.push({ timeMs: i * 1000, lat, lng: 0 });
      lat += 20 / 111320;
    }
    const speeds = computeSmoothedSpeeds(wps, [], 2000);
    expect(speeds[2]).toBeLessThan(speeds[17]);
    expect(speeds[2]).toBeCloseTo(5, 1);
    expect(speeds[17]).toBeCloseTo(20, 1);
  });

  it("does not blow up or average across an interruption gap", () => {
    const wps = straightTrack(8, 1000, 10);
    // Gap before index 4 (segment [3,4] is a signal loss).
    const speeds = computeSmoothedSpeeds(wps, [4], 12_000);
    expect(speeds.every((s) => Number.isNaN(s) || Number.isFinite(s))).toBe(true);
    // Speed at index 3 must only look left of the gap; index 4 only right.
    expect(speeds[3]).toBeCloseTo(10, 5);
    expect(speeds[4]).toBeCloseTo(10, 5);
  });

  it("returns NaN for tracks shorter than two points", () => {
    expect(computeSmoothedSpeeds([], [])).toEqual([]);
    expect(computeSmoothedSpeeds([{ timeMs: 0, lat: 0, lng: 0 }], [])).toEqual([NaN]);
  });
});

describe("normalizeSpeeds", () => {
  it("maps the lowest to 0 and highest to 1 across a spread", () => {
    const speeds = Array.from({ length: 100 }, (_, i) => i);
    const norm = normalizeSpeeds(speeds);
    expect(norm[0]).toBe(0);
    expect(norm[99]).toBe(1);
    expect(norm.every((n) => n >= 0 && n <= 1)).toBe(true);
    // Monotonic non-decreasing.
    for (let i = 1; i < norm.length; i++) {
      expect(norm[i]).toBeGreaterThanOrEqual(norm[i - 1]);
    }
  });

  it("clamps a single outlier to the top of the range", () => {
    const speeds = [...Array.from({ length: 100 }, (_, i) => i), 100_000];
    const norm = normalizeSpeeds(speeds);
    expect(norm[norm.length - 1]).toBe(1); // outlier clamped, not off-scale
    expect(norm[5]).toBe(0); // p5 boundary
  });

  it("preserves NaN entries", () => {
    const norm = normalizeSpeeds([NaN, 1, 2, NaN, 3]);
    expect(Number.isNaN(norm[0])).toBe(true);
    expect(Number.isNaN(norm[3])).toBe(true);
    expect(Number.isFinite(norm[1])).toBe(true);
  });

  it("returns mid-grey position for a flat distribution", () => {
    const norm = normalizeSpeeds([5, 5, 5, 5]);
    expect(norm).toEqual([0.5, 0.5, 0.5, 0.5]);
  });
});

describe("tickPositions", () => {
  function track(): ReplayWaypoint[] {
    return [
      { timeMs: 0, lat: 0, lng: 0 },
      { timeMs: 60_000, lat: 1, lng: 1 },
      { timeMs: 120_000, lat: 2, lng: 2 },
      { timeMs: 180_000, lat: 3, lng: 3 },
    ];
  }

  it("emits one tick per interval boundary", () => {
    const ticks = tickPositions(track(), [], 60_000);
    expect(ticks).toHaveLength(3);
    expect(ticks[0]).toEqual({ lat: 1, lng: 1 });
    expect(ticks[2]).toEqual({ lat: 3, lng: 3 });
  });

  it("interpolates a tick that falls mid-segment", () => {
    const wps: ReplayWaypoint[] = [
      { timeMs: 0, lat: 0, lng: 0 },
      { timeMs: 120_000, lat: 4, lng: 4 },
    ];
    const ticks = tickPositions(wps, [], 60_000);
    expect(ticks[0]).toEqual({ lat: 2, lng: 2 });
  });

  it("skips ticks that land inside an interruption gap", () => {
    // Gap before index 2 -> the 120 s tick lands in the gap and is dropped.
    const ticks = tickPositions(track(), [2], 60_000);
    expect(ticks).toHaveLength(2);
    expect(ticks).toEqual([
      { lat: 1, lng: 1 },
      { lat: 3, lng: 3 },
    ]);
  });

  it("returns nothing for degenerate input", () => {
    expect(tickPositions([], [], 60_000)).toEqual([]);
    expect(tickPositions(track(), [], 0)).toEqual([]);
  });
});
