/** Resampling, smoothing and simplification (docs/map-gps-tracks.md §3.3–3.4). */
import { describe, expect, it } from "vitest";
import { movingAverage, pointSegmentDistance, resampleTrack, simplifyTrack, smoothTrack } from "../geometry.js";
import type { ProjectedTrack } from "../project.js";

/** 1:10 000 — 10 ground metres per paper mm, so 2 m = 0.2 mm. */
const M_PER_MM = 10;

function line(pts: [number, number][], metresPerMm = M_PER_MM): ProjectedTrack {
  return { x: Float64Array.from(pts.map((p) => p[0])), y: Float64Array.from(pts.map((p) => p[1])), metresPerMm };
}

/** A seeded LCG in [0, 1) — the noise is the same on every run. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** A straight east–west line 200 m long, a fix every 2 m with ±1.5 m of independent cross-track noise (paper mm). */
function noisyStraight(): { noisy: ProjectedTrack } {
  const r = lcg(42);
  const pts: [number, number][] = [];
  for (let i = 0; i <= 100; i++) {
    const o = i === 0 || i === 100 ? 0 : (r() - 0.5) * 3;
    pts.push([(i * 2) / M_PER_MM, o / M_PER_MM]);
  }
  return { noisy: line(pts) };
}

/** RMS of y, in ground metres. */
function rmsY(l: ProjectedTrack): number {
  let s = 0;
  for (const y of l.y) s += (y * M_PER_MM) ** 2;
  return Math.sqrt(s / l.y.length);
}

function polylineDistance(px: number, py: number, l: ProjectedTrack): number {
  let d = Infinity;
  for (let i = 1; i < l.x.length; i++) d = Math.min(d, pointSegmentDistance(px, py, l.x[i - 1], l.y[i - 1], l.x[i], l.y[i]));
  return l.x.length === 1 ? Math.hypot(px - l.x[0], py - l.y[0]) : d;
}

describe("resampleTrack", () => {
  it("equal intervals of at most 2 m, both ends exact", () => {
    const l = line([[0, 0], [1.05, 0], [1.05, 0.5]]); // 15.5 m
    const r = resampleTrack(l);
    expect(r.x).toHaveLength(Math.ceil(15.5 / 2) + 1);
    expect([r.x[0], r.y[0]]).toEqual([0, 0]);
    expect([r.x.at(-1), r.y.at(-1)]).toEqual([1.05, 0.5]);
    for (let i = 1; i < r.x.length; i++) {
      const d = Math.hypot(r.x[i] - r.x[i - 1], r.y[i] - r.y[i - 1]) * M_PER_MM;
      expect(d).toBeLessThanOrEqual(2 + 1e-9);
    }
    // Arc spacing is equal: 15.5 / 8 m (the corner sample is cut, so chord ≤ arc).
    expect(Math.hypot(r.x[1] - r.x[0], r.y[1] - r.y[0]) * M_PER_MM).toBeCloseTo(15.5 / 8, 9);
  });

  it("drops consecutive duplicates; a line shorter than the step keeps its two ends", () => {
    const r = resampleTrack(line([[0, 0], [0, 0], [0.05, 0], [0.05, 0]]));
    expect(Array.from(r.x)).toEqual([0, 0.05]);
  });

  it("a single point, or one point repeated, comes back unchanged", () => {
    expect(Array.from(resampleTrack(line([[1, 2]])).x)).toEqual([1]);
    expect(Array.from(resampleTrack(line([[1, 2], [1, 2]])).x)).toEqual([1, 1]);
  });

  it("rejects a step that is not positive", () => {
    expect(() => resampleTrack(line([[0, 0], [1, 0]]), 0)).toThrow(RangeError);
  });
});

describe("smoothTrack", () => {
  it("a straight line is a fixed point (to 1e-9 mm)", () => {
    const l = line([[0, 0], [3, 4], [9, 12]]);
    const s = smoothTrack(l);
    const r = resampleTrack(l);
    expect(s.x).toHaveLength(r.x.length);
    for (let i = 0; i < s.x.length; i++) {
      expect(Math.abs(s.x[i] - r.x[i])).toBeLessThan(1e-9);
      expect(Math.abs(s.y[i] - r.y[i])).toBeLessThan(1e-9);
    }
  });

  it("reduces the cross-track noise of a noisy straight line to under two thirds", () => {
    const { noisy } = noisyStraight();
    const before = rmsY(resampleTrack(noisy));
    const after = rmsY(smoothTrack(noisy));
    expect(before).toBeGreaterThan(0.5);
    expect(after).toBeLessThan((2 / 3) * before);
  });

  it("rounds a right-angle corner within the window and leaves the legs alone", () => {
    // 50 m east, then 50 m north; apex at (5, 0) mm.
    const l = line([[0, 0], [5, 0], [5, 5]]);
    const r = resampleTrack(l);
    const s = smoothTrack(l);
    let apexShift = Infinity;
    for (let i = 0; i < s.x.length; i++) {
      apexShift = Math.min(apexShift, Math.hypot(s.x[i] - 5, s.y[i]) * M_PER_MM);
      // A sample more than half a window (5 m) from the apex along the line is not moved.
      if (Math.hypot(r.x[i] - 5, r.y[i]) * M_PER_MM > 5) {
        expect(Math.abs(s.x[i] - r.x[i])).toBeLessThan(1e-12);
        expect(Math.abs(s.y[i] - r.y[i])).toBeLessThan(1e-12);
      }
    }
    // The corner is cut, by less than 1.5 m.
    expect(apexShift).toBeGreaterThan(0.1);
    expect(apexShift).toBeLessThan(1.5);
  });

  it("pins the ends bit-identically", () => {
    const { noisy } = noisyStraight();
    const s = smoothTrack(noisy);
    expect([s.x[0], s.y[0]]).toEqual([noisy.x[0], noisy.y[0]]);
    expect([s.x.at(-1), s.y.at(-1)]).toEqual([noisy.x.at(-1), noisy.y.at(-1)]);
  });

  it("is deterministic and does not mutate its input", () => {
    const { noisy } = noisyStraight();
    const copy = { x: Float64Array.from(noisy.x), y: Float64Array.from(noisy.y) };
    const a = smoothTrack(noisy), b = smoothTrack(noisy);
    const bytes = (f: Float64Array) => Array.from(new Uint8Array(f.buffer));
    expect(bytes(a.x)).toEqual(bytes(b.x));
    expect(bytes(a.y)).toEqual(bytes(b.y));
    expect(noisy.x).toEqual(copy.x);
    expect(noisy.y).toEqual(copy.y);
  });

  it("movingAverage: weights 1, 2, 3, 2, 1 for K = 2; the window shrinks near the ends", () => {
    const pts: [number, number][] = [0, 1, 2, 3, 4, 5, 6].map((i) => [i * 0.2, i === 3 ? 0.9 : 0]);
    const s = movingAverage(line(pts), 2);
    expect(s.y[3]).toBeCloseTo((3 * 0.9) / 9, 12);
    expect(s.y[2]).toBeCloseTo((2 * 0.9) / 9, 12);
    expect(s.y[1]).toBeCloseTo(0, 12); // half-width 1: samples 0–2 only
    expect(s.y[0]).toBe(0);
    expect(s.x[3]).toBeCloseTo(0.6, 12);
  });

  it("smoothTrack is resampleTrack then movingAverage with K = floor(window / 2 / step)", () => {
    const { noisy } = noisyStraight();
    expect(Array.from(smoothTrack(noisy).y)).toEqual(Array.from(movingAverage(resampleTrack(noisy, 2), 2).y));
    expect(Array.from(smoothTrack(noisy, { stepM: 1, windowM: 7 }).y)).toEqual(Array.from(movingAverage(resampleTrack(noisy, 1), 3).y));
  });

  it("a window narrower than two steps leaves the resampled line", () => {
    const { noisy } = noisyStraight();
    expect(Array.from(smoothTrack(noisy, { windowM: 3 }).y)).toEqual(Array.from(resampleTrack(noisy).y));
  });
});

describe("simplifyTrack", () => {
  it.each([0.05, 0.1, 0.5])("tolerance %d mm: every input point within it of the output, a subset in order, ends kept", (tol) => {
    const { noisy } = noisyStraight();
    const s = simplifyTrack(noisy, tol);
    expect(s.x.length).toBeLessThan(noisy.x.length);
    for (let i = 0; i < noisy.x.length; i++) expect(polylineDistance(noisy.x[i], noisy.y[i], s)).toBeLessThanOrEqual(tol + 1e-12);
    let j = 0;
    for (let i = 0; i < s.x.length; i++) {
      while (j < noisy.x.length && !(noisy.x[j] === s.x[i] && noisy.y[j] === s.y[i])) j++;
      expect(j).toBeLessThan(noisy.x.length);
    }
    expect([s.x[0], s.y[0]]).toEqual([noisy.x[0], noisy.y[0]]);
    expect([s.x.at(-1), s.y.at(-1)]).toEqual([noisy.x.at(-1), noisy.y.at(-1)]);
  });

  it("defaults to 0.1 mm", () => {
    const { noisy } = noisyStraight();
    expect(Array.from(simplifyTrack(noisy).x)).toEqual(Array.from(simplifyTrack(noisy, 0.1).x));
  });

  it("collinear points reduce to the two ends; tolerance 0 removes only exactly collinear ones", () => {
    expect(Array.from(simplifyTrack(line([[0, 0], [1, 0], [2, 0], [3, 0]])).x)).toEqual([0, 3]);
    expect(Array.from(simplifyTrack(line([[0, 0], [1, 0], [2, 0], [3, 0], [4, 1]]), 0).x)).toEqual([0, 3, 4]);
    expect(simplifyTrack(line([[0, 0], [1, 0], [2, 1e-9], [3, 0]]), 0).x).toHaveLength(4);
  });

  it("a closed loop keeps its shape (the chord is a point)", () => {
    const pts: [number, number][] = [];
    for (let i = 0; i <= 36; i++) pts.push([Math.cos((i * Math.PI) / 18) * 5, Math.sin((i * Math.PI) / 18) * 5]);
    pts[36] = pts[0];
    const l = line(pts);
    const s = simplifyTrack(l, 0.1);
    expect(s.x.length).toBeGreaterThan(4);
    for (let i = 0; i < l.x.length; i++) expect(polylineDistance(l.x[i], l.y[i], s)).toBeLessThanOrEqual(0.1);
  });

  it("200 000 points without overflowing the stack, deterministically", () => {
    const r = lcg(7);
    const pts: [number, number][] = [];
    for (let i = 0; i < 200_000; i++) pts.push([i * 0.01, (r() - 0.5) * 0.4]);
    const l = line(pts);
    const a = simplifyTrack(l), b = simplifyTrack(l);
    expect(a.x.length).toBeGreaterThan(2);
    expect(Array.from(a.x)).toEqual(Array.from(b.x));
  }, 20_000); // a size test, not a speed budget: generous under a loaded machine

  it("rejects a negative tolerance; one or two points come back as they are", () => {
    expect(() => simplifyTrack(line([[0, 0], [1, 0], [2, 0]]), -1)).toThrow(RangeError);
    expect(Array.from(simplifyTrack(line([[0, 0], [1, 1]])).x)).toEqual([0, 1]);
  });
});
