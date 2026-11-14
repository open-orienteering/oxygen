/**
 * GPS track storage, the pure part (docs/map-gps-tracks.md §1.2; row G24):
 * points validation (refused, never re-rounded; all-null columns stored as
 * null), the single-pass ranges, the first recorded time and the split of
 * a stored row (points, trims, ranges).
 */

import { describe, it, expect } from "vitest";
import { TRPCError } from "@trpc/server";
import { gpsTrack } from "@oxygen/shared";
import { MAX_TRACK_POINTS, firstTime, splitStoredTrack, validateSinglePass, validateTrackPoints } from "../gps-tracks.js";

function points(n: number, timed = true): gpsTrack.TrackPoints {
  return {
    lat: Array.from({ length: n }, (_, i) => 596_000_000 + i * 10),
    lng: Array.from({ length: n }, (_, i) => 180_000_000 - i * 10),
    time: timed ? Array.from({ length: n }, (_, i) => 1_700_000_000_000 + i * 1000) : null,
    ele: Array.from({ length: n }, (_, i) => 12.3 + i),
  };
}

/** The error code a call throws (the message prefix), or null. */
function codeOf(fn: () => unknown): { code: string; prefix: string } | null {
  try {
    fn();
    return null;
  } catch (e) {
    if (!(e instanceof TRPCError)) throw e;
    return { code: e.code, prefix: e.message.split(":")[0] };
  }
}

describe("validateTrackPoints", () => {
  it("accepts a parsed track and returns its columns unchanged", () => {
    const p = points(5);
    p.ele = p.ele!.map((v) => gpsTrack.quantiseEle(v!));
    expect(validateTrackPoints(p)).toEqual(p);
  });

  it("stores a column of only nulls as null (§2.1)", () => {
    const p = { ...points(3), time: [null, null, null], ele: [null, 1.5, null] };
    expect(validateTrackPoints(p)).toEqual({ ...p, time: null, ele: [null, 1.5, null] });
  });

  it.each<[string, (p: Record<string, unknown>) => void]>([
    ["not an object", (p) => { p.lat = "x"; }],
    ["lat and lng of different length", (p) => { (p.lng as number[]).pop(); }],
    ["fewer than two points", (p) => { p.lat = [1]; p.lng = [1]; p.time = null; p.ele = null; }],
    ["a fractional lat", (p) => { (p.lat as number[])[1] = 1.5; }],
    ["lat beyond 90°", (p) => { (p.lat as number[])[0] = 900_000_001; }],
    ["lng beyond 180°", (p) => { (p.lng as number[])[0] = -1_800_000_001; }],
    ["a NaN lng", (p) => { (p.lng as number[])[0] = Number.NaN; }],
    ["a time column of another length", (p) => { (p.time as number[]).pop(); }],
    ["a negative time", (p) => { (p.time as number[])[0] = -1; }],
    ["a fractional time", (p) => { (p.time as number[])[0] = 1.5; }],
    ["an elevation not rounded to 0.1 m", (p) => { (p.ele as number[])[0] = 12.34; }],
    ["an infinite elevation", (p) => { (p.ele as number[])[0] = Infinity; }],
    ["a string in a column", (p) => { (p.ele as unknown[])[0] = "1"; }],
    ["a missing column", (p) => { delete p.ele; }],
  ])("refuses %s as TRACK_POINTS_INVALID", (_label, mutate) => {
    const p = points(4) as unknown as Record<string, unknown>;
    mutate(p);
    expect(codeOf(() => validateTrackPoints(p))).toEqual({ code: "BAD_REQUEST", prefix: "TRACK_POINTS_INVALID" });
  });

  it("accepts the edge coordinates", () => {
    const p = { lat: [-900_000_000, 900_000_000], lng: [-1_800_000_000, 1_800_000_000], time: null, ele: null };
    expect(validateTrackPoints(p)).toEqual(p);
  });

  it(`accepts ${MAX_TRACK_POINTS} points and refuses one more as TRACK_TOO_MANY_POINTS`, () => {
    expect(validateTrackPoints(points(MAX_TRACK_POINTS)).lat).toHaveLength(MAX_TRACK_POINTS);
    expect(codeOf(() => validateTrackPoints(points(MAX_TRACK_POINTS + 1)))).toEqual({ code: "PAYLOAD_TOO_LARGE", prefix: "TRACK_TOO_MANY_POINTS" });
  }, 20_000);
});

describe("validateSinglePass", () => {
  it("accepts ascending, disjoint, non-touching ranges within the track", () => {
    expect(validateSinglePass([{ start: 0, end: 2 }, { start: 3, end: 10 }], 10)).toEqual([{ start: 0, end: 2 }, { start: 3, end: 10 }]);
    expect(validateSinglePass([], 10)).toEqual([]);
  });

  it.each([
    ["empty", [{ start: 2, end: 2 }]],
    ["reversed", [{ start: 3, end: 2 }]],
    ["negative", [{ start: -1, end: 2 }]],
    ["past the end", [{ start: 8, end: 11 }]],
    ["touching", [{ start: 0, end: 2 }, { start: 2, end: 4 }]],
    ["overlapping", [{ start: 0, end: 3 }, { start: 2, end: 4 }]],
    ["out of order", [{ start: 5, end: 6 }, { start: 0, end: 2 }]],
    ["fractional", [{ start: 0.5, end: 2 }]],
  ])("refuses %s ranges", (_label, ranges) => {
    expect(codeOf(() => validateSinglePass(ranges, 10))).toEqual({ code: "BAD_REQUEST", prefix: "TRACK_POINTS_INVALID" });
  });
});

describe("firstTime", () => {
  it("is the first non-null time, or null", () => {
    expect(firstTime({ ...points(3), time: [null, 5, 6] })).toBe(5);
    expect(firstTime(points(3, false))).toBeNull();
  });
});

describe("splitStoredTrack", () => {
  const p = points(10);

  it("splits the full stored points with splitTrack and carries both trims", () => {
    const [left, right] = splitStoredTrack({ points: p, trimStart: 2, trimEnd: 9, singlePass: null }, 5);
    const [a, b] = gpsTrack.splitTrack({ name: null, points: p }, 5);
    expect(left.points).toEqual(a.points);
    expect(right.points).toEqual(b.points);
    expect([left.trimStart, left.trimEnd]).toEqual([2, 6]);
    expect([right.trimStart, right.trimEnd]).toEqual([0, 4]);
    expect(left.singlePass).toBeNull();
    expect(right.singlePass).toBeNull();
  });

  it("divides single_pass with splitRanges", () => {
    const [left, right] = splitStoredTrack({ points: p, trimStart: 0, trimEnd: 10, singlePass: [{ start: 1, end: 3 }, { start: 4, end: 7 }] }, 5);
    expect(left.singlePass).toEqual([{ start: 1, end: 3 }, { start: 4, end: 6 }]);
    expect(right.singlePass).toEqual([{ start: 0, end: 2 }]);
  });

  it("stores a part's column of only nulls as null", () => {
    const half = { ...p, time: [1, 2, 3, null, null, null, null, null, null, null] };
    const [left, right] = splitStoredTrack({ points: half, trimStart: 0, trimEnd: 10, singlePass: null }, 3);
    expect(left.points.time).toEqual([1, 2, 3, null]);
    expect(right.points.time).toBeNull();
  });

  it.each([
    [0, 10, 0], [0, 10, 9], [0, 10, 8 + 1], [2, 9, 2], [2, 9, 8],
  ])("refuses a split without two visible points on each side (trim [%i, %i), index %i)", (trimStart, trimEnd, index) => {
    expect(codeOf(() => splitStoredTrack({ points: p, trimStart, trimEnd, singlePass: null }, index))).toEqual({ code: "BAD_REQUEST", prefix: "TRACK_SPLIT_INVALID" });
  });

  it("accepts the extreme indices of the visible range", () => {
    expect(() => splitStoredTrack({ points: p, trimStart: 2, trimEnd: 9, singlePass: null }, 3)).not.toThrow();
    expect(() => splitStoredTrack({ points: p, trimStart: 2, trimEnd: 9, singlePass: null }, 7)).not.toThrow();
  });
});
