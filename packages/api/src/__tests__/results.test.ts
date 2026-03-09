import { describe, it, expect } from "vitest";
import { computeClassPlacements, computePosition, type RunnerForPlacement, type ClassRunnerForPosition } from "../results.js";
import { RunnerStatus } from "@oxygen/shared";

// ─── Fixtures ─────────────────────────────────────────────────

function makeRunner(
  id: number,
  status: number,
  startTime: number,
  finishTime: number,
): RunnerForPlacement {
  return { id, status, startTime, finishTime };
}

// Helpers to build typical ok/non-ok runners
const START = 32400 * 10; // 09:00:00

function okRunner(id: number, runningTimeDs: number): RunnerForPlacement {
  return makeRunner(id, RunnerStatus.OK, START, START + runningTimeDs);
}

function dnsRunner(id: number): RunnerForPlacement {
  return makeRunner(id, RunnerStatus.DNS, 0, 0);
}

function dnfRunner(id: number): RunnerForPlacement {
  return makeRunner(id, RunnerStatus.DNF, START, 0);
}

function mpRunner(id: number, runningTimeDs: number): RunnerForPlacement {
  return makeRunner(id, RunnerStatus.MissingPunch, START, START + runningTimeDs);
}

// ─── computeClassPlacements ───────────────────────────────────

describe("computeClassPlacements", () => {
  it("returns empty map for empty input", () => {
    const result = computeClassPlacements([], false);
    expect(result.size).toBe(0);
  });

  it("single OK runner gets place 1 and timeBehind 0", () => {
    const result = computeClassPlacements([okRunner(1, 600)], false);
    expect(result.get(1)).toMatchObject({ place: 1, timeBehind: 0 });
  });

  it("two OK runners: faster gets place 1, slower gets place 2", () => {
    const result = computeClassPlacements(
      [okRunner(1, 700), okRunner(2, 600)],
      false,
    );
    expect(result.get(2)!.place).toBe(1); // faster
    expect(result.get(1)!.place).toBe(2); // slower
  });

  it("tied runners share the same place (1, 1, 3 style)", () => {
    const result = computeClassPlacements(
      [okRunner(1, 600), okRunner(2, 600), okRunner(3, 700)],
      false,
    );
    expect(result.get(1)!.place).toBe(1);
    expect(result.get(2)!.place).toBe(1);
    expect(result.get(3)!.place).toBe(3); // 3rd, not 2nd
  });

  it("three-way tie: all get place 1", () => {
    const result = computeClassPlacements(
      [okRunner(1, 600), okRunner(2, 600), okRunner(3, 600)],
      false,
    );
    expect(result.get(1)!.place).toBe(1);
    expect(result.get(2)!.place).toBe(1);
    expect(result.get(3)!.place).toBe(1);
  });

  it("non-OK runners all get place 0", () => {
    const result = computeClassPlacements(
      [dnsRunner(1), dnfRunner(2), mpRunner(3, 500)],
      false,
    );
    expect(result.get(1)!.place).toBe(0);
    expect(result.get(2)!.place).toBe(0);
    expect(result.get(3)!.place).toBe(0);
  });

  it("mixed OK and non-OK: OK runners are placed, non-OK get place 0", () => {
    const result = computeClassPlacements(
      [okRunner(1, 600), dnsRunner(2), okRunner(3, 700)],
      false,
    );
    expect(result.get(1)!.place).toBe(1);
    expect(result.get(3)!.place).toBe(2);
    expect(result.get(2)!.place).toBe(0);
  });

  it("noTiming=true: all OK runners get place 0 but runningTime is still computed", () => {
    const result = computeClassPlacements(
      [okRunner(1, 600), okRunner(2, 700)],
      true,
    );
    expect(result.get(1)!.place).toBe(0);
    expect(result.get(2)!.place).toBe(0);
    expect(result.get(1)!.runningTime).toBe(600);
    expect(result.get(2)!.runningTime).toBe(700);
  });

  it("runner with finishTime=0 is not included in OK ranking", () => {
    const runnerWithoutFinish = makeRunner(
      1,
      RunnerStatus.OK,
      START,
      0, // no finish
    );
    const normalRunner = okRunner(2, 600);
    const result = computeClassPlacements([runnerWithoutFinish, normalRunner], false);
    expect(result.get(1)!.place).toBe(0);
    expect(result.get(2)!.place).toBe(1);
  });

  it("runner with startTime=0 is not included in OK ranking", () => {
    const runnerWithoutStart = makeRunner(
      1,
      RunnerStatus.OK,
      0, // no start
      START + 600,
    );
    const normalRunner = okRunner(2, 600);
    const result = computeClassPlacements([runnerWithoutStart, normalRunner], false);
    expect(result.get(1)!.place).toBe(0);
    expect(result.get(2)!.place).toBe(1);
  });

  it("every input runner ID appears in the output map", () => {
    const runners = [
      okRunner(1, 600),
      dnsRunner(2),
      dnfRunner(3),
      mpRunner(4, 500),
      okRunner(5, 700),
    ];
    const result = computeClassPlacements(runners, false);
    for (const r of runners) {
      expect(result.has(r.id)).toBe(true);
    }
  });

  it("timeBehind is correctly computed as runningTime minus winner time", () => {
    const result = computeClassPlacements(
      [okRunner(1, 700), okRunner(2, 600), okRunner(3, 800)],
      false,
    );
    const winner = result.get(2)!;
    const second = result.get(1)!;
    const third = result.get(3)!;
    expect(winner.timeBehind).toBe(0);
    expect(second.timeBehind).toBe(100);
    expect(third.timeBehind).toBe(200);
  });

  it("runningTime for non-OK runner with both times set is still computed", () => {
    // DNF runner who has a finish time (e.g., retired at the finish) should have runningTime
    const runner = makeRunner(1, RunnerStatus.DNF, START, START + 500);
    const result = computeClassPlacements([runner], false);
    expect(result.get(1)!.runningTime).toBe(500);
  });

  it("runningTime is 0 for DNS runner with no times", () => {
    const result = computeClassPlacements([dnsRunner(1)], false);
    expect(result.get(1)!.runningTime).toBe(0);
  });
});

// ─── computePosition ────────────────────────────────────────

describe("computePosition", () => {
  const START = 32400 * 10; // 09:00:00 in deciseconds

  function classRunner(name: string, runningTimeDs: number, clubId: number | null = 1): ClassRunnerForPosition {
    return { name, clubId, startTime: START, finishTime: START + runningTimeDs };
  }

  it("single runner gets rank 1 of 1", () => {
    const result = computePosition([classRunner("Alice", 600)], "Alice", 600, 1);
    expect(result).toMatchObject({ rank: 1, total: 1 });
  });

  it("two runners: faster is rank 1, slower is rank 2", () => {
    const runners = [classRunner("Alice", 600), classRunner("Bob", 700)];
    const result = computePosition(runners, "Bob", 700, 1);
    expect(result).toMatchObject({ rank: 2, total: 2 });
  });

  it("tied runners share rank 1", () => {
    const runners = [classRunner("Alice", 600), classRunner("Bob", 600)];
    const result = computePosition(runners, "Bob", 600, 1);
    expect(result).toMatchObject({ rank: 1, total: 2 });
  });

  it("injects self when not yet in DB results", () => {
    // Only Alice in DB, but Bob (self) is not yet persisted
    const runners = [classRunner("Alice", 600)];
    const result = computePosition(runners, "Bob", 700, 1);
    expect(result).toMatchObject({ rank: 2, total: 2 });
  });

  it("does not duplicate self when already in DB results", () => {
    const runners = [classRunner("Alice", 600), classRunner("Bob", 700)];
    const result = computePosition(runners, "Bob", 700, 1);
    expect(result).toMatchObject({ rank: 2, total: 2 });
  });

  it("excludes runners with startTime=0", () => {
    const runners = [
      classRunner("Alice", 600),
      { name: "NoStart", clubId: 1, startTime: 0, finishTime: START + 500 }, // no start
    ];
    const result = computePosition(runners, "Alice", 600, 1);
    // NoStart is excluded, only Alice counts
    expect(result).toMatchObject({ rank: 1, total: 1 });
  });

  it("excludes runners with finishTime=0", () => {
    const runners = [
      classRunner("Alice", 600),
      { name: "NoFinish", clubId: 1, startTime: START, finishTime: 0 }, // no finish
    ];
    const result = computePosition(runners, "Alice", 600, 1);
    expect(result).toMatchObject({ rank: 1, total: 1 });
  });

  it("returns null when selfRunningTime <= 0", () => {
    const result = computePosition([classRunner("Alice", 600)], "Alice", 0, 1);
    expect(result).toBeNull();
  });

  it("rankedRunners is sorted by running time", () => {
    const runners = [classRunner("Alice", 700), classRunner("Bob", 600), classRunner("Carol", 800)];
    const result = computePosition(runners, "Alice", 700, 1);
    expect(result!.rankedRunners.map((r) => r.name)).toEqual(["Bob", "Alice", "Carol"]);
  });

  it("returns all ranked runners (not limited to 5)", () => {
    const runners = Array.from({ length: 8 }, (_, i) => classRunner(`Runner${i}`, 600 + i * 100));
    const result = computePosition(runners, "Runner0", 600, 1);
    expect(result!.rankedRunners).toHaveLength(8);
  });
});
