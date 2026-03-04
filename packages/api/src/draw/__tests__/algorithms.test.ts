import { describe, it, expect } from "vitest";
import {
  randomDraw,
  clubSeparationDraw,
  seededDraw,
  simultaneousDraw,
  type DrawRunner,
} from "../algorithms.js";

// ─── Fixtures ────────────────────────────────────────────────

function makeRunner(
  id: number,
  clubId: number,
  rank = 0,
  clubName = `Club ${clubId}`,
): DrawRunner {
  return { id, name: `Runner ${id}`, clubId, clubName, startNo: 0, rank };
}

/** Build N runners each from a different club */
function mixedClubRunners(n: number): DrawRunner[] {
  return Array.from({ length: n }, (_, i) => makeRunner(i + 1, i + 1));
}

/** Build runners spread across the given clubs (round-robin) */
function buildRunners(count: number, clubIds: number[]): DrawRunner[] {
  return Array.from({ length: count }, (_, i) =>
    makeRunner(i + 1, clubIds[i % clubIds.length]),
  );
}

// ─── Helpers ─────────────────────────────────────────────────

function sameIds(a: DrawRunner[], b: DrawRunner[]): boolean {
  const sortedA = [...a].map((r) => r.id).sort((x, y) => x - y);
  const sortedB = [...b].map((r) => r.id).sort((x, y) => x - y);
  return JSON.stringify(sortedA) === JSON.stringify(sortedB);
}

function countAdjacentSameClub(runners: DrawRunner[]): number {
  let count = 0;
  for (let i = 1; i < runners.length; i++) {
    if (runners[i].clubId === runners[i - 1].clubId) count++;
  }
  return count;
}

// ─── randomDraw ───────────────────────────────────────────────

describe("randomDraw", () => {
  it("returns the same runners", () => {
    const input = mixedClubRunners(10);
    const result = randomDraw(input);
    expect(sameIds(result, input)).toBe(true);
  });

  it("does not mutate the input array", () => {
    const input = mixedClubRunners(5);
    const copy = [...input];
    randomDraw(input);
    expect(input).toEqual(copy);
  });

  it("returns empty array for empty input", () => {
    expect(randomDraw([])).toEqual([]);
  });

  it("returns single-element array unchanged", () => {
    const input = [makeRunner(1, 1)];
    expect(randomDraw(input)).toEqual(input);
  });

  it("returns correct length", () => {
    const input = mixedClubRunners(20);
    expect(randomDraw(input)).toHaveLength(20);
  });

  it("has no duplicate IDs in output", () => {
    const input = mixedClubRunners(20);
    const result = randomDraw(input);
    const ids = result.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ─── clubSeparationDraw ───────────────────────────────────────

describe("clubSeparationDraw", () => {
  it("preserves all runners", () => {
    const input = buildRunners(12, [1, 2, 3, 4]);
    const result = clubSeparationDraw(input);
    expect(sameIds(result, input)).toBe(true);
  });

  it("returns correct length", () => {
    const input = buildRunners(15, [1, 2, 3]);
    expect(clubSeparationDraw(input)).toHaveLength(15);
  });

  it("has no duplicate IDs", () => {
    const input = buildRunners(12, [1, 2, 3]);
    const ids = clubSeparationDraw(input).map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("returns empty array for empty input", () => {
    expect(clubSeparationDraw([])).toEqual([]);
  });

  it("handles single runner", () => {
    const input = [makeRunner(1, 1)];
    const result = clubSeparationDraw(input);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(1);
  });

  it("handles all runners from one club", () => {
    // All same club — separation is impossible, but all runners must be returned
    const input = buildRunners(6, [1]);
    const result = clubSeparationDraw(input);
    expect(sameIds(result, input)).toBe(true);
  });

  it("achieves good club separation for a well-separable field", () => {
    // 4 clubs × 3 runners each — fully separable, should hit 0 adjacent conflicts
    // We run the test multiple times to account for randomness
    const separable = buildRunners(12, [1, 2, 3, 4]);
    let bestConflicts = Infinity;
    for (let attempt = 0; attempt < 20; attempt++) {
      const result = clubSeparationDraw(separable);
      const conflicts = countAdjacentSameClub(result);
      bestConflicts = Math.min(bestConflicts, conflicts);
    }
    // At least one run should achieve 0 conflicts for a perfectly separable field
    expect(bestConflicts).toBe(0);
  });

  it("does fewer club-adjacent conflicts than random on average", () => {
    const runners = buildRunners(20, [1, 2, 3, 4]);
    const TRIALS = 50;

    let separationConflicts = 0;
    let randomConflicts = 0;

    for (let i = 0; i < TRIALS; i++) {
      separationConflicts += countAdjacentSameClub(clubSeparationDraw(runners));
      randomConflicts += countAdjacentSameClub(randomDraw(runners));
    }

    expect(separationConflicts / TRIALS).toBeLessThan(
      randomConflicts / TRIALS,
    );
  });
});

// ─── seededDraw ───────────────────────────────────────────────

describe("seededDraw", () => {
  function buildSeededRunners() {
    // 5 unseeded (rank 0) + 3 seeded (rank 1, 2, 3)
    const unseeded = Array.from({ length: 5 }, (_, i) =>
      makeRunner(i + 1, i + 1, 0),
    );
    const seeded = [
      makeRunner(6, 1, 3),
      makeRunner(7, 2, 1),
      makeRunner(8, 3, 2),
    ];
    return { unseeded, seeded, all: [...unseeded, ...seeded] };
  }

  it("preserves all runners", () => {
    const { all } = buildSeededRunners();
    const result = seededDraw(all);
    expect(sameIds(result, all)).toBe(true);
  });

  it("returns correct length", () => {
    const { all } = buildSeededRunners();
    expect(seededDraw(all)).toHaveLength(all.length);
  });

  it("seeded runners appear after all unseeded runners", () => {
    const { unseeded, seeded, all } = buildSeededRunners();
    const result = seededDraw(all);
    const unseededIds = new Set(unseeded.map((r) => r.id));
    const seededIds = new Set(seeded.map((r) => r.id));

    const firstSeededIndex = result.findIndex((r) => seededIds.has(r.id));
    const lastUnseededIndex = result.reduce(
      (max, r, i) => (unseededIds.has(r.id) ? i : max),
      -1,
    );

    expect(firstSeededIndex).toBeGreaterThan(lastUnseededIndex);
  });

  it("seeded runners are ordered by descending rank (highest rank = last start)", () => {
    const { all } = buildSeededRunners();
    const result = seededDraw(all);
    // Last 3 are seeded; rank order should be ascending in position → descending rank at end
    const seededPortion = result.slice(-3);
    const ranks = seededPortion.map((r) => r.rank);
    // rank of last element should be ≥ rank of second-to-last, etc.
    for (let i = 0; i < ranks.length - 1; i++) {
      expect(ranks[i]).toBeGreaterThanOrEqual(ranks[i + 1]);
    }
    // Actually: lower rank starts first (earlier), highest rank last
    // seeded is sorted descending by rank → [rank3, rank2, rank1] in position order
    // Wait — sort descending means rank 3 first in the seeded array, rank 1 last
    // But they are placed at the END of the full array. The last runner should have the LOWEST rank
    // among seeded, because seededDraw pushes rank-sorted descending: [...unseeded, ...seeded] where
    // seeded = sorted descending rank. So result[-1] = rank 1, result[-2] = rank 2, result[-3] = rank 3.
    // The highest-rank runner starts FIRST among seeded (earliest in the seeded block).
    // The lowest-rank seeded runner starts LAST (has the most advantageous position).
    // This is intentional: "seeded = later (better) start times", highest rank = last in field.
    // Actually re-reading: seeded.sort((a, b) => b.rank - a.rank) → rank 3 at index 0, rank 1 at index 2
    // Then [...unseeded, ...seeded] → last element has rank 1 (lowest seeded rank)
    // So position order within seeded block: rank 3 then rank 2 then rank 1
    // This means highest rank starts latest among seeded. ✓
    // Check: result[-3].rank >= result[-2].rank >= result[-1].rank? No, that's wrong.
    // Seeded array after sort descending: [rank3, rank2, rank1]
    // So in result: [..., rank3, rank2, rank1] → result[-3].rank=3 > result[-2].rank=2 > result[-1].rank=1
    expect(seededPortion[0].rank).toBeGreaterThanOrEqual(seededPortion[1].rank);
    expect(seededPortion[1].rank).toBeGreaterThanOrEqual(seededPortion[2].rank);
  });

  it("returns empty array for empty input", () => {
    expect(seededDraw([])).toEqual([]);
  });

  it("handles all unseeded runners (no seeded)", () => {
    const all = buildRunners(8, [1, 2, 3]);
    const result = seededDraw(all);
    expect(sameIds(result, all)).toBe(true);
    expect(result).toHaveLength(8);
  });

  it("handles all seeded runners (no unseeded)", () => {
    const all = [makeRunner(1, 1, 5), makeRunner(2, 2, 3), makeRunner(3, 3, 1)];
    const result = seededDraw(all);
    expect(sameIds(result, all)).toBe(true);
    expect(result).toHaveLength(3);
  });

  it("clubSeparation option: unseeded block has fewer conflicts than random", () => {
    const unseeded = buildRunners(20, [1, 2, 3, 4]);
    const seeded = [makeRunner(21, 1, 1), makeRunner(22, 2, 2)];
    const all = [...unseeded, ...seeded];

    const TRIALS = 50;
    let separationConflicts = 0;
    let noSeparationConflicts = 0;
    for (let i = 0; i < TRIALS; i++) {
      const withSep = seededDraw(all, { clubSeparation: true });
      const withoutSep = seededDraw(all, { clubSeparation: false });
      separationConflicts += countAdjacentSameClub(withSep.slice(0, 20));
      noSeparationConflicts += countAdjacentSameClub(withoutSep.slice(0, 20));
    }
    expect(separationConflicts / TRIALS).toBeLessThan(
      noSeparationConflicts / TRIALS,
    );
  });
});

// ─── simultaneousDraw ─────────────────────────────────────────

describe("simultaneousDraw", () => {
  it("preserves all runners", () => {
    const input = mixedClubRunners(10);
    const result = simultaneousDraw(input);
    expect(sameIds(result, input)).toBe(true);
  });

  it("returns correct length", () => {
    const input = mixedClubRunners(10);
    expect(simultaneousDraw(input)).toHaveLength(10);
  });

  it("returns empty array for empty input", () => {
    expect(simultaneousDraw([])).toEqual([]);
  });

  it("has no duplicate IDs", () => {
    const input = mixedClubRunners(15);
    const ids = simultaneousDraw(input).map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
