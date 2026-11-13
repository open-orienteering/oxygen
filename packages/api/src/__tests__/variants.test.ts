/**
 * Runners' variants, the pure half (slice F, row F6b;
 * docs/course-controls-and-matching.md "Forked courses and variants").
 */

import { describe, it, expect } from "vitest";
import {
  dealVariants,
  pickLeastPopulated,
  seededShuffle,
  startOrderCompare,
  type DealRunner,
  type PoolVariant,
} from "../variants.js";

const pool: PoolVariant[] = [
  { id: "a", seq: 11, variantKey: "A" },
  { id: "b", seq: 12, variantKey: "B" },
  { id: "c", seq: 13, variantKey: "C" },
];
const runner = (id: string, startTime: number, extra: Partial<DealRunner> = {}): DealRunner => ({
  id,
  courseId: null,
  startTime,
  startNo: 0,
  name: id,
  ...extra,
});
/** Apply the changes to the runners and list the courses in start order. */
const after = (runners: DealRunner[], changes: { runnerId: string; courseId: string }[]) => {
  const byId = new Map(changes.map((c) => [c.runnerId, c.courseId]));
  return [...runners].sort(startOrderCompare).map((r) => byId.get(r.id) ?? r.courseId);
};

describe("pickLeastPopulated", () => {
  it("takes the variant with the fewest runners, ties the first key", () => {
    expect(pickLeastPopulated(pool, new Map())!.id).toBe("a");
    expect(pickLeastPopulated(pool, new Map([["a", 1]]))!.id).toBe("b");
    expect(pickLeastPopulated(pool, new Map([["a", 2], ["b", 1], ["c", 1]]))!.id).toBe("b");
    expect(pickLeastPopulated(pool, new Map([["a", 1], ["b", 1], ["c", 0]]))!.id).toBe("c");
  });

  it("is null for an empty pool", () => {
    expect(pickLeastPopulated([], new Map())).toBeNull();
  });
});

describe("startOrderCompare", () => {
  it("orders by start time (none last), then start number (none last), then name", () => {
    const rs = [
      runner("late", 0),
      runner("z", 100, { startNo: 2 }),
      runner("y", 100, { startNo: 1 }),
      runner("x", 100),
      runner("early", 50),
      runner("b", 0, { name: "Berg" }),
      runner("a", 0, { name: "Alm" }),
    ];
    expect([...rs].sort(startOrderCompare).map((r) => r.id)).toEqual(["early", "y", "z", "x", "a", "b", "late"]);
  });
});

describe("dealVariants", () => {
  it("deals round-robin in key order over the start order: consecutive starters differ", () => {
    const rs = [runner("r3", 300), runner("r1", 100), runner("r4", 400), runner("r2", 200)];
    const changes = dealVariants(rs, pool.slice(0, 2), { mode: "startOrder", onlyUnassigned: false });
    expect(after(rs, changes)).toEqual(["a", "b", "a", "b"]);
  });

  it("reports only the runners whose variant changes", () => {
    const rs = [runner("r1", 100, { courseId: "a" }), runner("r2", 200, { courseId: "a" })];
    expect(dealVariants(rs, pool.slice(0, 2), { mode: "startOrder", onlyUnassigned: false })).toEqual([
      { runnerId: "r2", courseId: "b" },
    ]);
  });

  it("random shuffles reproducibly from the seed and keeps the balance", () => {
    const rs = Array.from({ length: 9 }, (_, i) => runner(`r${i}`, (i + 1) * 100));
    const one = dealVariants(rs, pool, { mode: "random", onlyUnassigned: false, seed: 42 });
    const two = dealVariants(rs, pool, { mode: "random", onlyUnassigned: false, seed: 42 });
    expect(one).toEqual(two);
    const counts = new Map<string, number>();
    for (const c of one) counts.set(c.courseId, (counts.get(c.courseId) ?? 0) + 1);
    expect([...counts.values()]).toEqual([3, 3, 3]);
    const other = dealVariants(rs, pool, { mode: "random", onlyUnassigned: false, seed: 7 });
    expect(other).not.toEqual(one);
  });

  it("onlyUnassigned keeps the assigned runners and balances the others", () => {
    const rs = [
      runner("r1", 100, { courseId: "a" }),
      runner("r2", 200, { courseId: "a" }),
      runner("r3", 300),
      runner("r4", 400),
      runner("r5", 500, { courseId: "gone" }), // not in the pool → unassigned
    ];
    const changes = dealVariants(rs, pool.slice(0, 2), { mode: "startOrder", onlyUnassigned: true });
    expect(after(rs, changes)).toEqual(["a", "a", "b", "b", "a"]);
  });

  it("never changes a locked (raced) runner; she counts toward the balance", () => {
    const rs = [runner("r1", 100, { courseId: "b", locked: true }), runner("r2", 200), runner("r3", 300)];
    expect(after(rs, dealVariants(rs, pool.slice(0, 2), { mode: "startOrder", onlyUnassigned: false }))).toEqual([
      "b", "a", "b",
    ]);
    expect(after(rs, dealVariants(rs, pool.slice(0, 2), { mode: "startOrder", onlyUnassigned: true }))).toEqual([
      "b", "a", "a",
    ]);
    const unlockedNone = [runner("r1", 100, { locked: true })];
    expect(dealVariants(unlockedNone, pool, { mode: "startOrder", onlyUnassigned: true })).toEqual([]);
  });

  it("a pool of one gives everyone the one variant; an empty pool changes nothing", () => {
    const rs = [runner("r1", 100), runner("r2", 200)];
    expect(after(rs, dealVariants(rs, pool.slice(0, 1), { mode: "startOrder", onlyUnassigned: false }))).toEqual([
      "a", "a",
    ]);
    expect(dealVariants(rs, [], { mode: "startOrder", onlyUnassigned: false })).toEqual([]);
  });
});

describe("seededShuffle", () => {
  it("is a permutation and leaves its input alone", () => {
    const xs = [1, 2, 3, 4, 5, 6];
    const out = seededShuffle(xs, 1);
    expect([...out].sort()).toEqual(xs);
    expect(xs).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
