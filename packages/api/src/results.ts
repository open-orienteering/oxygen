import { RunnerStatus } from "@oxygen/shared";

export interface RunnerForPlacement {
  id: number;
  status: number;
  startTime: number;
  finishTime: number;
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
 * but running times are still computed so callers can choose to show or hide them.
 */
export function computeClassPlacements(
  runners: RunnerForPlacement[],
  noTiming: boolean,
): Map<number, PlacementResult> {
  const results = new Map<number, PlacementResult>();

  const okRunners = runners
    .filter(
      (r) =>
        r.status === RunnerStatus.OK &&
        r.finishTime > 0 &&
        r.startTime > 0,
    )
    .map((r) => ({ ...r, runningTime: r.finishTime - r.startTime }))
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
      const runningTime =
        r.finishTime > 0 && r.startTime > 0
          ? r.finishTime - r.startTime
          : 0;
      results.set(r.id, { place: 0, runningTime, timeBehind: 0 });
    }
  }

  return results;
}
