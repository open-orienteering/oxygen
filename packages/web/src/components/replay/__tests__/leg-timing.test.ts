import { describe, it, expect } from "vitest";
import type { ReplayData, ReplayCourse, ReplayRoute } from "@oxygen/shared";
import { buildRouteControlTimes } from "../leg-timing";

function ctrl(code: string, type: "start" | "control" | "finish" = "control") {
  return { code, type, lat: 0, lng: 0 };
}

// Two forks that share the start, control 204 and the merge at 130, but diverge
// in between (fork A → 87, fork B → 43). Mirrors leg 6 of Kotka-Jukola where
// Krivda (J602) and Kempe (J609) split after 204 and re-merge at 130.
const forkA: ReplayCourse = {
  id: "A",
  name: "J602",
  controls: [ctrl("S", "start"), ctrl("204"), ctrl("87"), ctrl("130"), ctrl("F", "finish")],
};
const forkB: ReplayCourse = {
  id: "B",
  name: "J609",
  controls: [ctrl("S", "start"), ctrl("204"), ctrl("43"), ctrl("130"), ctrl("F", "finish")],
};

function route(
  id: string,
  courseId: string | undefined,
  splits: { controlCode: string; timeMs: number }[],
): ReplayRoute {
  return {
    participantId: id,
    name: id,
    waypoints: [],
    interruptions: [],
    courseId,
    result: { status: "ok", time: 0, splitTimes: splits } as ReplayRoute["result"],
  };
}

function data(routes: ReplayRoute[]): ReplayData {
  return {
    title: "t",
    sourceType: "oxygen",
    map: {} as ReplayData["map"],
    courses: [forkA, forkB],
    routes,
    referenceTimeMs: 0,
  };
}

const splitsA = [
  { controlCode: "204", timeMs: 60_000 },
  { controlCode: "87", timeMs: 120_000 },
  { controlCode: "130", timeMs: 180_000 },
  { controlCode: "F", timeMs: 240_000 },
];
const splitsB = [
  { controlCode: "204", timeMs: 60_000 },
  { controlCode: "43", timeMs: 130_000 },
  { controlCode: "130", timeMs: 190_000 },
  { controlCode: "F", timeMs: 250_000 },
];

describe("buildRouteControlTimes", () => {
  it("indexes each runner against their OWN fork's controls", () => {
    const d = data([route("a", "A", splitsA), route("b", "B", splitsB)]);
    const raceStarts = new Map([["a", 1000], ["b", 1000]]);
    const times = buildRouteControlTimes(d, raceStarts);

    // index 0 = race start; subsequent = raceStart + that fork's split.
    expect(times.get("a")).toEqual([1000, 61_000, 121_000, 181_000, 241_000]);
    expect(times.get("b")).toEqual([1000, 61_000, 131_000, 191_000, 251_000]);
  });

  it("uses divergent controls at the forked index (the bug being fixed)", () => {
    const d = data([route("a", "A", splitsA), route("b", "B", splitsB)]);
    const times = buildRouteControlTimes(d, new Map([["a", 1000], ["b", 1000]]));
    // Leg starting at control 204 (index 1) ends at index 2, which is control
    // 87 for fork A but 43 for fork B — so the end times differ per runner.
    // Pre-fix, fork B's runner had no split for fork A's "87" → never capped.
    expect(times.get("a")![2]).toBe(121_000);
    expect(times.get("b")![2]).toBe(131_000);
    expect(times.get("a")![2]).not.toBe(times.get("b")![2]);
  });

  it("falls back to the first course when a route has no courseId", () => {
    const d = data([route("a", undefined, splitsA)]);
    const times = buildRouteControlTimes(d, new Map([["a", 1000]]));
    // Uses fork A (courses[0]); fork A control index 2 is "87".
    expect(times.get("a")).toEqual([1000, 61_000, 121_000, 181_000, 241_000]);
  });

  it("yields NaN for controls the runner has no split for", () => {
    const d = data([route("a", "A", [])]);
    const times = buildRouteControlTimes(d, new Map([["a", 1000]]))!.get("a")!;
    expect(times[0]).toBe(1000);
    expect(times.slice(1).every((t) => Number.isNaN(t))).toBe(true);
  });

  it("skips routes whose participant has no race start (no GPS)", () => {
    const d = data([route("a", "A", splitsA)]);
    const times = buildRouteControlTimes(d, new Map());
    expect(times.has("a")).toBe(false);
  });
});
