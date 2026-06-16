import type { ReplayData } from "@oxygen/shared";

/**
 * For each route, the absolute time (ms) at which the runner reached each of
 * THEIR OWN fork's controls.
 *
 *  - index 0 is the race start (the start triangle has no split time);
 *  - index `i >= 1` is `raceStart + split` at that fork control, or `NaN` when
 *    the runner has no recorded split for it.
 *
 * This is what makes legs mode fork-aware. Forked relay legs give each runner a
 * different control sequence (matched via `route.courseId`); indexing leg
 * boundaries against the runner's own fork — rather than a single reference
 * course — means each runner is advanced and capped at the controls *they*
 * actually ran. In legs mode the faster runner therefore freezes at their own
 * next control and waits for the slower one, instead of running past it.
 *
 * Non-forked events fall back to the single course, so behaviour is unchanged.
 */
export function buildRouteControlTimes(
  data: ReplayData,
  raceStarts: Map<string, number>,
): Map<string, number[]> {
  const result = new Map<string, number[]>();
  const courseById = new Map(data.courses.map((c) => [c.id, c]));
  const fallback = data.courses[0];

  for (const route of data.routes) {
    const start = raceStarts.get(route.participantId);
    if (start === undefined) continue;
    const fork =
      (route.courseId ? courseById.get(route.courseId) : undefined) ?? fallback;
    if (!fork) continue;

    const splits = route.result?.splitTimes;
    const times: number[] = [start];
    for (let i = 1; i < fork.controls.length; i++) {
      const code = fork.controls[i].code;
      const split = splits?.find((s) => s.controlCode === code);
      times.push(split ? start + split.timeMs : NaN);
    }
    result.set(route.participantId, times);
  }

  return result;
}
