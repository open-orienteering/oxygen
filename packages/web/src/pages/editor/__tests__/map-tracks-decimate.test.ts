import { describe, expect, it } from "vitest";
import { gpsTrack } from "@oxygen/shared";
import { DEFAULT_TOLERANCE_MM, LAYER_POINT_BUDGET, decimateLayer, layerShapes, runsOf, toleranceMm } from "../modes/map/tracks/decimate";

const line = (pts: [number, number][]): gpsTrack.ProjectedTrack => ({
  x: Float64Array.from(pts, (p) => p[0]),
  y: Float64Array.from(pts, (p) => p[1]),
  metresPerMm: 10,
});

/** A seeded zig-zag of `n` points along x, ±amp across. */
function noisy(n: number, amp: number, seed = 1): gpsTrack.ProjectedTrack {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  return line(Array.from({ length: n }, (_, i) => [i * 0.05, (rnd() - 0.5) * 2 * amp] as [number, number]));
}

/** Largest distance of a point of `full` from the polyline `drawn` (mm). */
function deviation(full: gpsTrack.ProjectedTrack, drawn: { x: number; y: number }[]): number {
  let worst = 0;
  for (let i = 0; i < full.x.length; i++) {
    let d = Infinity;
    for (let k = 0; k + 1 < drawn.length; k++) {
      d = Math.min(d, gpsTrack.pointSegmentDistance(full.x[i], full.y[i], drawn[k].x, drawn[k].y, drawn[k + 1].x, drawn[k + 1].y));
    }
    worst = Math.max(worst, d);
  }
  return worst;
}

describe("toleranceMm (docs/map-gps-tracks.md §5.1 'Decimation to the pixel')", () => {
  it("half a pixel at the finer end of the zoom's octave: never more than 0.5 px", () => {
    expect(toleranceMm(0.25)).toBe(0.125);
    expect(toleranceMm(0.3)).toBe(0.125);
    expect(toleranceMm(0.49)).toBe(0.125);
    expect(toleranceMm(0.5)).toBe(0.25);
    expect(toleranceMm(0.01)).toBe(0.5 * 2 ** -7);
    for (const z of [0.003, 0.07, 0.3, 1.7, 9]) {
      expect(toleranceMm(z) / z).toBeLessThanOrEqual(0.5);
      expect(toleranceMm(z) / z).toBeGreaterThan(0.25);
    }
  });

  it("no zoom known yet: the fixed default", () => {
    expect(toleranceMm(null)).toBe(DEFAULT_TOLERANCE_MM);
    expect(toleranceMm(0)).toBe(DEFAULT_TOLERANCE_MM);
    expect(toleranceMm(Number.NaN)).toBe(DEFAULT_TOLERANCE_MM);
  });
});

describe("decimateLayer", () => {
  it("every point within the tolerance, ends kept, a straight line to two points", () => {
    const full = noisy(2000, 0.3);
    const out = decimateLayer([{ id: "a", colour: "#e11d48", line: full }], 0.1);
    const pts = out.lines[0].points;
    expect(pts.length).toBeLessThan(full.x.length);
    expect(pts[0]).toEqual({ x: full.x[0], y: full.y[0] });
    expect(pts[pts.length - 1]).toEqual({ x: full.x[1999], y: full.y[1999] });
    expect(deviation(full, pts)).toBeLessThanOrEqual(0.1 + 1e-9);
    expect(out.tolerance).toBe(0.1);
    const straight = decimateLayer([{ id: "s", colour: "#000", line: line([[0, 0], [1, 1], [2, 2], [3, 3]]) }], 0.01);
    expect(straight.lines[0].points).toEqual([{ x: 0, y: 0 }, { x: 3, y: 3 }]);
  });

  it("deterministic: the same input, the same points", () => {
    const a = decimateLayer([{ id: "a", colour: "#000", line: noisy(500, 0.2, 7) }], 0.05);
    const b = decimateLayer([{ id: "a", colour: "#000", line: noisy(500, 0.2, 7) }], 0.05);
    expect(a).toEqual(b);
  });

  it("over the budget the tolerance doubles until the visible tracks fit", () => {
    const lines = [0, 1, 2].map((i) => ({ id: `t${i}`, colour: "#000", line: noisy(30_000, 1, i + 3) }));
    const out = decimateLayer(lines, 0.001);
    const total = out.lines.reduce((s, l) => s + l.points.length, 0);
    expect(total).toBeLessThanOrEqual(LAYER_POINT_BUDGET);
    expect(out.tolerance).toBeGreaterThan(0.001);
    expect(Math.log2(out.tolerance / 0.001) % 1).toBeCloseTo(0, 9);
    // At half that tolerance they would not have fitted.
    const finer = decimateLayer(lines, out.tolerance / 2, Infinity);
    expect(finer.lines.reduce((s, l) => s + l.points.length, 0)).toBeGreaterThan(LAYER_POINT_BUDGET);
  }, 20_000);
});

describe("layerShapes (§5.1 'The layer')", () => {
  it("one UI-layer path per line: 2 px, its colour, the track id and test id", () => {
    const out = decimateLayer([{ id: "a", colour: "#2563eb", line: line([[0, 0], [5, 0], [5, 5]]) }], 0.01);
    expect(layerShapes(out)).toEqual([
      { kind: "line", points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }], color: "#2563eb", widthPx: 2, testId: "editor-gps-track", data: { "track-id": "a" } },
    ]);
  });
});

describe("an average's single-pass spans dashed (§5.2, G27)", () => {
  it("runsOf: solid and dashed runs that touch, each of two points at least", () => {
    expect(runsOf(10, [])).toEqual([{ start: 0, end: 9, dashed: false }]);
    expect(runsOf(10, [{ start: 3, end: 6 }])).toEqual([{ start: 0, end: 3, dashed: false }, { start: 3, end: 5, dashed: true }, { start: 5, end: 9, dashed: false }]);
    expect(runsOf(10, [{ start: 0, end: 4 }, { start: 7, end: 10 }])).toEqual([
      { start: 0, end: 3, dashed: true }, { start: 3, end: 7, dashed: false }, { start: 7, end: 9, dashed: true },
    ]);
    // A one-sample range has no dashed run: the solid runs meet there.
    expect(runsOf(10, [{ start: 4, end: 5 }])).toEqual([{ start: 0, end: 4, dashed: false }, { start: 4, end: 9, dashed: false }]);
    expect(runsOf(10, [{ start: 0, end: 10 }])).toEqual([{ start: 0, end: 9, dashed: true }]);
  });

  it("a line with ranges: one path per run under the same track id, the dashed ones marked; the run ends kept", () => {
    const l = line(Array.from({ length: 11 }, (_, i) => [i, 0] as [number, number]));
    const out = decimateLayer([{ id: "m", colour: "#000", line: l, dashed: [{ start: 4, end: 8 }] }], 0.01);
    const shapes = layerShapes(out);
    expect(shapes.map((s) => s.kind === "line" && [s.points.map((p) => p.x), !!s.dashed, s.data?.["single-pass"]])).toEqual([
      [[0, 4], false, undefined], [[4, 7], true, "true"], [[7, 10], false, undefined],
    ]);
    expect(shapes.every((s) => s.kind === "line" && s.data?.["track-id"] === "m" && s.testId === "editor-gps-track")).toBe(true);
    // Deterministic and the same objects for the same line (cached per line, ranges and tolerance).
    expect(decimateLayer([{ id: "m", colour: "#000", line: l, dashed: [{ start: 4, end: 8 }] }], 0.01)).toEqual(out);
  });
});
