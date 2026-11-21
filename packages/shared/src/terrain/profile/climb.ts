/**
 * Climb from a run of heights by hysteresis (docs/course-elevation.md §2).
 */

/** A rise counts once it exceeds this above the last low point, metres. */
export const CLIMB_THRESHOLD_M = 1;

/** One counted rise: indices into the heights, low then high. */
export interface Rise {
  from: number;
  to: number;
}

/**
 * The rises of `heights` (metres, in order): a rise starts at the first
 * height at least `thresholdM` above the last low and ends at the first at
 * least `thresholdM` below its high; a rise in progress at the end counts.
 * Nearly independent of how densely the heights were sampled.
 */
export function climbRises(heights: readonly number[], thresholdM: number = CLIMB_THRESHOLD_M): Rise[] {
  const rises: Rise[] = [];
  if (heights.length === 0) return rises;
  let low = 0, high = 0, rising = false;
  for (let i = 0; i < heights.length; i++) {
    const z = heights[i];
    if (rising) {
      if (z > heights[high]) high = i;
      else if (heights[high] - z >= thresholdM) {
        rises.push({ from: low, to: high });
        low = i;
        rising = false;
      }
    } else if (z < heights[low]) low = i;
    else if (z - heights[low] >= thresholdM) {
      high = i;
      rising = true;
    }
  }
  if (rising) rises.push({ from: low, to: high });
  return rises;
}

/** The climb over `heights`: the sum of its rises, `high − low` each. */
export function hysteresisClimb(heights: readonly number[], thresholdM: number = CLIMB_THRESHOLD_M): number {
  let climb = 0;
  for (const r of climbRises(heights, thresholdM)) climb += heights[r.to] - heights[r.from];
  return climb;
}

/** The descent: the same rule on the negated heights. */
export function hysteresisDescent(heights: readonly number[], thresholdM: number = CLIMB_THRESHOLD_M): number {
  return hysteresisClimb(heights.map((z) => -z), thresholdM);
}

/**
 * The climb of `heights` shared out over consecutive index ranges
 * `[bounds[k], bounds[k + 1]]` (a course's legs; a boundary sample belongs
 * to both): each rise gives a range the gain of its running maximum inside
 * the range, so the shares are never negative and sum to the climb.
 */
export function climbShares(heights: readonly number[], bounds: readonly number[], thresholdM: number = CLIMB_THRESHOLD_M): number[] {
  const shares = new Array<number>(Math.max(0, bounds.length - 1)).fill(0);
  for (const r of climbRises(heights, thresholdM)) {
    let k = 0;
    while (k < shares.length - 1 && bounds[k + 1] <= r.from) k++;
    let top = heights[r.from];
    for (let i = r.from + 1; i <= r.to; i++) {
      while (k < shares.length - 1 && bounds[k + 1] < i) k++;
      if (heights[i] > top) {
        shares[k] += heights[i] - top;
        top = heights[i];
      }
    }
  }
  return shares;
}
