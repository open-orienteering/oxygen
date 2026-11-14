/** Trim and split on the stored track (docs/map-gps-tracks.md §3.5). */
import { describe, expect, it } from "vitest";
import { quantiseDeg, quantiseEle, splitRanges, splitTrack, trackLength, trimTrack, type Track } from "../track.js";

function track(n: number, timed = true): Track {
  const r = Array.from({ length: n }, (_, i) => i);
  return {
    name: "T",
    points: {
      lat: r.map((i) => 590000000 + i),
      lng: r.map((i) => 180000000 + i),
      time: timed ? r.map((i) => (i === 2 ? null : 1000 * i)) : null,
      ele: null,
    },
  };
}

describe("quantisation", () => {
  it("stores degrees as integer 1e-7 degrees and elevation to 0.1 m", () => {
    expect(quantiseDeg(59.123456789)).toBe(591234568);
    expect(quantiseDeg(-18.00000004)).toBe(-180000000);
    expect(quantiseEle(31.44)).toBe(31.4);
    expect(quantiseEle(-2.06)).toBe(-2.1);
  });
});

describe("trimTrack", () => {
  it("keeps [start, end) in every column, nulls kept, the name kept", () => {
    const t = trimTrack(track(6), { start: 1, end: 4 });
    expect(trackLength(t)).toBe(3);
    expect(t.points.lat).toEqual([590000001, 590000002, 590000003]);
    expect(t.points.lng).toEqual([180000001, 180000002, 180000003]);
    expect(t.points.time).toEqual([1000, null, 3000]);
    expect(t.points.ele).toBeNull();
    expect(t.name).toBe("T");
  });

  it("a whole-column null stays null; the whole range is the identity", () => {
    const t = track(4, false);
    expect(trimTrack(t, { start: 0, end: 4 }).points).toEqual(t.points);
  });

  it("does not mutate the input", () => {
    const t = track(5);
    const before = structuredClone(t);
    trimTrack(t, { start: 1, end: 3 });
    expect(t).toEqual(before);
  });

  it.each([
    [{ start: -1, end: 3 }],
    [{ start: 0, end: 6 }],
    [{ start: 2, end: 3 }],
    [{ start: 3, end: 2 }],
    [{ start: 0.5, end: 3 }],
  ])("rejects %o on 5 points", (range) => {
    expect(() => trimTrack(track(5), range)).toThrow(RangeError);
  });
});

describe("splitTrack", () => {
  it("shares the split point: [0, i] and [i, n − 1]", () => {
    const [a, b] = splitTrack(track(5), 2);
    expect(a.points.lat).toEqual([590000000, 590000001, 590000002]);
    expect(b.points.lat).toEqual([590000002, 590000003, 590000004]);
    expect(a.points.time).toEqual([0, 1000, null]);
    expect(b.points.time).toEqual([null, 3000, 4000]);
    expect(a.name).toBe("T");
    expect(b.name).toBe("T");
  });

  it("split, split, delete the middle cuts out a stretch and the ends still touch the cut", () => {
    const [head, rest] = splitTrack(track(10), 3);
    const [, tail] = splitTrack(rest, 4); // index 7 in the original
    expect(head.points.lat.at(-1)).toBe(590000003);
    expect(tail.points.lat[0]).toBe(590000007);
  });

  it.each([0, 4, -1, 1.5, 9])("rejects index %d on 5 points", (i) => {
    expect(() => splitTrack(track(5), i)).toThrow(RangeError);
  });

  it("needs three points", () => {
    expect(() => splitTrack(track(2), 1)).toThrow(RangeError);
    expect(splitTrack(track(3), 1).map(trackLength)).toEqual([2, 2]);
  });
});

describe("splitRanges", () => {
  it("divides ranges as splitTrack divides points: before, after, straddling", () => {
    // 10 points split at 4: left points 0..4 (5), right points 4..9 (6, re-indexed from 0).
    const [left, right] = splitRanges([{ start: 0, end: 2 }, { start: 3, end: 6 }, { start: 7, end: 10 }], 4);
    expect(left).toEqual([{ start: 0, end: 2 }, { start: 3, end: 5 }]);
    expect(right).toEqual([{ start: 0, end: 2 }, { start: 3, end: 6 }]);
  });

  it("puts a range of the split point alone in both parts", () => {
    expect(splitRanges([{ start: 4, end: 5 }], 4)).toEqual([[{ start: 4, end: 5 }], [{ start: 0, end: 1 }]]);
  });

  it("drops a range ending at the split point from the right, and one starting after it from the left", () => {
    expect(splitRanges([{ start: 1, end: 4 }, { start: 5, end: 8 }], 4)).toEqual([[{ start: 1, end: 4 }], [{ start: 1, end: 4 }]]);
  });

  it("matches splitTrack's index sets point by point", () => {
    const ranges = [{ start: 0, end: 3 }, { start: 5, end: 7 }, { start: 8, end: 12 }];
    const inRanges = (rs: { start: number; end: number }[], i: number) => rs.some((r) => i >= r.start && i < r.end);
    for (let index = 1; index <= 10; index++) {
      const [l, r] = splitRanges(ranges, index);
      for (let i = 0; i <= index; i++) expect(inRanges(l, i)).toBe(inRanges(ranges, i));
      for (let i = index; i < 12; i++) expect(inRanges(r, i - index)).toBe(inRanges(ranges, i));
    }
  });

  it("handles no ranges and does not mutate", () => {
    expect(splitRanges([], 3)).toEqual([[], []]);
    const ranges = [{ start: 2, end: 6 }];
    splitRanges(ranges, 3);
    expect(ranges).toEqual([{ start: 2, end: 6 }]);
  });
});
