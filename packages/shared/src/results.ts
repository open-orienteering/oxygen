/**
 * Result computation logic — pure functions for position and placement
 * calculations. Used by both server (API) and client (offline).
 */

import { RunnerStatus } from "./types.js";

// ─── Position calculation for receipts ──────────────────────

export interface ClassRunnerForPosition {
  name: string;
  clubId: number | null;
  startTime: number;
  finishTime: number;
  /**
   * Optional deciseconds to deduct from `finishTime - startTime` to
   * obtain the canonical running time. Set when the runner's course
   * contains NoTiming or BadNoTiming positions; otherwise omit (default 0).
   */
  runningTimeAdjustment?: number;
}

export interface PositionResult {
  rank: number;
  total: number;
  rankedRunners: Array<{ name: string; clubId: number | null; runningTime: number }>;
}

/**
 * Compute the position of a runner within their class, including self-injection
 * when the runner may not yet be persisted to the DB.
 *
 * Returns null if selfRunningTime <= 0 (no valid time).
 */
export function computePosition(
  runners: ClassRunnerForPosition[],
  selfName: string,
  selfRunningTime: number,
  selfClubId: number | null,
): PositionResult | null {
  if (selfRunningTime <= 0) return null;

  const withTimes = runners
    .filter((r) => r.finishTime > 0 && r.startTime > 0)
    .map((r) => ({
      name: r.name,
      clubId: r.clubId,
      runningTime: Math.max(
        0,
        r.finishTime - r.startTime - (r.runningTimeAdjustment ?? 0),
      ),
    }))
    .sort((a, b) => a.runningTime - b.runningTime);

  // If the current runner isn't in the DB results yet (applyResult may not
  // have persisted their status), include them so total count is correct.
  const selfIncluded = withTimes.some(
    (r) => r.name === selfName && r.runningTime === selfRunningTime,
  );
  if (!selfIncluded) {
    withTimes.push({ name: selfName, clubId: selfClubId, runningTime: selfRunningTime });
    withTimes.sort((a, b) => a.runningTime - b.runningTime);
  }

  const rank = withTimes.filter((r) => r.runningTime < selfRunningTime).length + 1;

  return {
    rank,
    total: withTimes.length,
    rankedRunners: withTimes,
  };
}

// ─── Class placements for result lists ──────────────────────

export interface RunnerForPlacement {
  id: number;
  status: number;
  startTime: number;
  finishTime: number;
  /** See {@link ClassRunnerForPosition.runningTimeAdjustment}. */
  runningTimeAdjustment?: number;
}

export interface PlacementResult {
  place: number;
  runningTime: number;
  timeBehind: number;
}

/**
 * Compute placements for runners within a single class.
 *
 * OK runners are ranked by running time (ascending). Equal times share
 * the same position (1, 1, 3 style). Non-OK runners get place 0.
 *
 * If `noTiming` is true the class has no ranking — every runner gets place 0
 * but running times are still computed.
 */
export function computeClassPlacements(
  runners: RunnerForPlacement[],
  noTiming: boolean,
): Map<number, PlacementResult> {
  const results = new Map<number, PlacementResult>();

  const adjustedRunningTime = (r: RunnerForPlacement): number => {
    if (r.finishTime <= 0 || r.startTime <= 0) return 0;
    return Math.max(
      0,
      r.finishTime - r.startTime - (r.runningTimeAdjustment ?? 0),
    );
  };

  const okRunners = runners
    .filter(
      (r) =>
        r.status === RunnerStatus.OK &&
        r.finishTime > 0 &&
        r.startTime > 0,
    )
    .map((r) => ({ ...r, runningTime: adjustedRunningTime(r) }))
    .sort((a, b) => a.runningTime - b.runningTime);

  const winnerTime = okRunners.length > 0 ? okRunners[0].runningTime : 0;

  let nextPlace = 1;
  for (let i = 0; i < okRunners.length; i++) {
    if (i > 0 && okRunners[i].runningTime > okRunners[i - 1].runningTime) {
      nextPlace = i + 1;
    }
    results.set(okRunners[i].id, {
      place: noTiming ? 0 : nextPlace,
      runningTime: okRunners[i].runningTime,
      timeBehind: okRunners[i].runningTime - winnerTime,
    });
  }

  for (const r of runners) {
    if (!results.has(r.id)) {
      results.set(r.id, {
        place: 0,
        runningTime: adjustedRunningTime(r),
        timeBehind: 0,
      });
    }
  }

  return results;
}
