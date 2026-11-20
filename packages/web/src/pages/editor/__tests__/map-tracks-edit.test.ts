import { describe, expect, it } from "vitest";
import { gpsTrack } from "@oxygen/shared";
import type { TrackMeta } from "../../../lib/editor/write-client";
import { dragIndex, handleBounds, handleIndex, keptLine, nearestTrack, nodesNear, splitIndexAt, splitUndo, trimOfHandle, viewRanges } from "../modes/map/tracks/edit";

const line = (pts: [number, number][]): gpsTrack.ProjectedTrack => ({
  x: Float64Array.from(pts, (p) => p[0]),
  y: Float64Array.from(pts, (p) => p[1]),
  metresPerMm: 7.5,
});
/** Ten points along x, 1 mm apart. */
const straight = line(Array.from({ length: 10 }, (_, i) => [i, 0] as [number, number]));
/** An out-and-back: 0..4 along y = 0, then back 4..0 along y = 0.2. */
const outBack = line([[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [4, 0.2], [3, 0.2], [2, 0.2], [1, 0.2], [0, 0.2]]);

const meta = (over: Partial<TrackMeta> = {}): TrackMeta => ({
  id: "00000000-0000-7000-8000-000000000001", name: "A", sourceName: "a.gpx", pointCount: 10, recordedAt: null, trim: { start: 0, end: 10 },
  derivedFrom: [], singlePass: null, convertedOp: null, createdBy: null, createdAt: "2026-11-16T00:00:00.000Z", version: "1", ...over,
});

describe("handle ↔ point index (docs/map-gps-tracks.md §5.2 'Trim')", () => {
  it("the start handle sits on stored point trim.start, the end handle on trim.end − 1", () => {
    expect(handleIndex("start", { start: 2, end: 8 })).toBe(2);
    expect(handleIndex("end", { start: 2, end: 8 })).toBe(7);
  });
  it("a handle's index back to the trim: start inclusive, end exclusive", () => {
    expect(trimOfHandle("start", 3, { start: 2, end: 8 })).toEqual({ start: 3, end: 8 });
    expect(trimOfHandle("end", 4, { start: 2, end: 8 })).toEqual({ start: 2, end: 5 });
    // The round trip.
    for (const end of ["start", "end"] as const) {
      const trim = { start: 1, end: 9 };
      expect(trimOfHandle(end, handleIndex(end, trim), trim)).toEqual(trim);
    }
  });
  it("bounds keep two points between the handles, over the whole stored track (restorable)", () => {
    expect(handleBounds("start", { start: 2, end: 8 }, 10)).toEqual({ lo: 0, hi: 6 });
    expect(handleBounds("end", { start: 2, end: 8 }, 10)).toEqual({ lo: 3, hi: 9 });
    // Every index in bounds gives a trim of §3.5's rule.
    for (const end of ["start", "end"] as const) {
      const trim = { start: 2, end: 8 };
      const { lo, hi } = handleBounds(end, trim, 10);
      for (let i = lo; i <= hi; i++) {
        const t = trimOfHandle(end, i, trim);
        expect(t.end - t.start).toBeGreaterThanOrEqual(2);
        expect(t.start).toBeGreaterThanOrEqual(0);
        expect(t.end).toBeLessThanOrEqual(10);
      }
    }
  });
  it("a drag lands on the nearest stored point within the bounds, outward too", () => {
    expect(dragIndex(straight, 9, { x: 6.2, y: 0.3 }, 1, 9, 0.1)).toBe(6);
    expect(dragIndex(straight, 6, { x: 8.7, y: -0.3 }, 1, 9, 0.1)).toBe(9);
    // Past the bound it stops at the bound.
    expect(dragIndex(straight, 6, { x: 0, y: 0 }, 3, 9, 0.1)).toBe(3);
    expect(dragIndex(straight, 3, { x: 40, y: 0 }, 0, 6, 0.1)).toBe(6);
  });
  it("on an out-and-back the handle stays on its own leg: among near-equal points the one nearest in index", () => {
    // From the end (index 9, on the way back) towards x = 2: the return leg's point 7, not the outward point 2.
    expect(dragIndex(outBack, 9, { x: 2, y: 0.1 }, 1, 9, 0.15)).toBe(7);
    // From the start (index 0) the outward leg.
    expect(dragIndex(outBack, 0, { x: 2, y: 0.1 }, 0, 8, 0.15)).toBe(2);
    // A clear nearest point wins over index proximity.
    expect(dragIndex(outBack, 9, { x: 2, y: -0.05 }, 1, 9, 0.1)).toBe(2);
  });
});

describe("split at a clicked point (§5.2 'Split')", () => {
  it("the nearer vertex of the nearest kept segment within reach", () => {
    expect(splitIndexAt(straight, { start: 0, end: 10 }, { x: 4.4, y: 0.2 }, 0.5)).toBe(4);
    expect(splitIndexAt(straight, { start: 0, end: 10 }, { x: 4.6, y: -0.2 }, 0.5)).toBe(5);
    // A tie goes to the earlier point.
    expect(splitIndexAt(straight, { start: 0, end: 10 }, { x: 4.5, y: 0 }, 0.5)).toBe(4);
  });
  it("out of reach, or leaving fewer than two visible points on a side: no split", () => {
    expect(splitIndexAt(straight, { start: 0, end: 10 }, { x: 4, y: 1 }, 0.5)).toBeNull();
    expect(splitIndexAt(straight, { start: 0, end: 10 }, { x: 0.1, y: 0 }, 0.5)).toBeNull();
    expect(splitIndexAt(straight, { start: 0, end: 10 }, { x: 8.9, y: 0 }, 0.5)).toBeNull();
    expect(splitIndexAt(straight, { start: 0, end: 10 }, { x: 1, y: 0 }, 0.5)).toBe(1);
    expect(splitIndexAt(straight, { start: 0, end: 10 }, { x: 8, y: 0 }, 0.5)).toBe(8);
    // Only the kept range counts: the trimmed-away stretch is not clicked.
    expect(splitIndexAt(straight, { start: 3, end: 8 }, { x: 1, y: 0 }, 0.5)).toBeNull();
    expect(splitIndexAt(straight, { start: 3, end: 8 }, { x: 3, y: 0 }, 0.5)).toBeNull();
    expect(splitIndexAt(straight, { start: 3, end: 8 }, { x: 4, y: 0 }, 0.5)).toBe(4);
    expect(splitIndexAt(straight, { start: 3, end: 8 }, { x: 6, y: 0 }, 0.5)).toBe(6);
    expect(splitIndexAt(straight, { start: 3, end: 8 }, { x: 7, y: 0 }, 0.5)).toBeNull();
  });
});

describe("the track under a click (§5.2)", () => {
  const a = { id: "a", line: line([[0, 0], [10, 0]]) }, b = { id: "b", line: line([[0, 1], [10, 1]]) };
  it("the nearest within reach, else none; ties to list order", () => {
    expect(nearestTrack([a, b], { x: 5, y: 0.3 }, 0.5)).toBe("a");
    expect(nearestTrack([a, b], { x: 5, y: 0.8 }, 0.5)).toBe("b");
    expect(nearestTrack([a, b], { x: 5, y: 0.5 }, 0.5)).toBe("a");
    expect(nearestTrack([a, b], { x: 5, y: 3 }, 0.5)).toBeNull();
    expect(nearestTrack([], { x: 5, y: 0 }, 0.5)).toBeNull();
  });
});

describe("the kept line and an average's ranges under a trim (§4.1, §5.2)", () => {
  it("keptLine is the trim's slice of the full projection, index-aligned", () => {
    const k = keptLine(straight, { start: 2, end: 5 });
    expect(Array.from(k.x)).toEqual([2, 3, 4]);
    expect(k.metresPerMm).toBe(7.5);
    expect(keptLine(straight, { start: 0, end: 10 })).toBe(straight);
  });
  it("viewRanges clips the stored ranges to the trim and shifts them by trim.start", () => {
    const ranges = [{ start: 0, end: 3 }, { start: 5, end: 7 }, { start: 8, end: 10 }];
    expect(viewRanges(ranges, { start: 0, end: 10 })).toEqual(ranges);
    expect(viewRanges(ranges, { start: 2, end: 9 })).toEqual([{ start: 0, end: 1 }, { start: 3, end: 5 }, { start: 6, end: 7 }]);
    expect(viewRanges(ranges, { start: 3, end: 5 })).toEqual([]);
    expect(viewRanges(null, { start: 0, end: 10 })).toEqual([]);
  });
});

describe("a split's undo (§5.2, user 2026-11-15)", () => {
  const points = { lat: Array.from({ length: 10 }, (_, i) => i), lng: Array.from({ length: 10 }, () => 0), time: null, ele: null };
  it("removes the two parts, re-imports the original under its id, restores trim and mark when set", () => {
    const m = meta({ trim: { start: 1, end: 9 }, convertedOp: "add:x" });
    const u = splitUndo(m, points, ["l", "r"]);
    expect(u.remove).toEqual(["l", "r"]);
    expect(u.item).toEqual({ id: m.id, name: "A", sourceName: "a.gpx", points });
    expect(u.trim).toEqual({ start: 1, end: 9 });
    expect(u.mark).toEqual({ id: m.id, opId: "add:x" });
  });
  it("an untrimmed, unconverted track: no trim or mark step; an average keeps derivedFrom and singlePass", () => {
    const m = meta({ derivedFrom: ["p", "q"], singlePass: [{ start: 2, end: 4 }] });
    const u = splitUndo(m, points, ["l", "r"]);
    expect(u.trim).toBeNull();
    expect(u.mark).toBeNull();
    expect(u.item.derivedFrom).toEqual(["p", "q"]);
    expect(u.item.singlePass).toEqual([{ start: 2, end: 4 }]);
  });
});

describe("nodesNear (G29)", () => {
  const l = (n: number): gpsTrack.ProjectedTrack => ({ x: Float64Array.from({ length: n }, (_, i) => i), y: new Float64Array(n), metresPerMm: 7.5 });
  it("the splittable points within the radius of a point, in index order", () => {
    expect(nodesNear(l(20), { start: 0, end: 20 }, 10, 2.5)).toEqual([8, 9, 10, 11, 12]);
    // Clipped to trim.start + 1 … trim.end − 2.
    expect(nodesNear(l(20), { start: 8, end: 13 }, 10, 5)).toEqual([9, 10, 11]);
  });
  it("on an out-and-back the other leg's points in reach are drawn too", () => {
    const back: gpsTrack.ProjectedTrack = { x: Float64Array.from([0, 1, 2, 3, 2, 1, 0]), y: Float64Array.from([0, 0, 0, 0, 0.1, 0.1, 0.1]), metresPerMm: 7.5 };
    expect(nodesNear(back, { start: 0, end: 7 }, 1, 0.5)).toEqual([1, 5]);
  });
});
