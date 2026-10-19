/**
 * Meridian-line (ISOM 601.x) clustering, shared by the import's stage 5
 * (`mapImport.analyseDocumentInput`) and the legacy `map-north.ts`
 * (docs/map-import.md §3.8). Club files often reuse 601.x for other line
 * symbols, so lines are grouped per symbol and only a group of many
 * near-parallel long lines counts as the drawn magnetic-north lines.
 */

/** Minimum parallel lines in a group to count as meridians. */
export const MERIDIAN_MIN_COUNT = 10;
/** Max angle standard deviation (degrees) of a meridian group. */
export const MERIDIAN_MAX_STDDEV_DEG = 0.7;
/** Lines shorter than this on paper are ticks or fragments, not meridians. */
export const MERIDIAN_MIN_LENGTH_MM = 5;

/** Fold an oriented line angle into [-90, 90] so both directions of one undirected line coincide. */
export function foldLineAngleDeg(angleDeg: number): number {
  let a = angleDeg;
  while (a > 90) a -= 180;
  while (a < -90) a += 180;
  return a;
}

/** Tilt of the line (x0, y0) → (x1, y1) from paper +Y, clockwise positive, folded to [-90, 90]. Paper coordinates y-up. */
export function lineTiltDeg(x0: number, y0: number, x1: number, y1: number): number {
  return foldLineAngleDeg((Math.atan2(x1 - x0, y1 - y0) * 180) / Math.PI);
}

export interface MeridianClusterOf<K> {
  key: K;
  count: number;
  /** Median tilt from paper +Y (the upper median for an even count). */
  medianTiltDeg: number;
  stddevDeg: number;
}

/**
 * The best meridian group: at least `MERIDIAN_MIN_COUNT` tilts with a
 * standard deviation of at most `MERIDIAN_MAX_STDDEV_DEG`; the largest
 * wins, ties keep the first group in iteration order.
 */
export function clusterMeridians<K>(groups: Iterable<[K, number[]]>): MeridianClusterOf<K> | null {
  let best: MeridianClusterOf<K> | null = null;
  for (const [key, angles] of groups) {
    if (angles.length < MERIDIAN_MIN_COUNT) continue;
    const mean = angles.reduce((s, a) => s + a, 0) / angles.length;
    const variance = angles.reduce((s, a) => s + (a - mean) * (a - mean), 0) / angles.length;
    const stddevDeg = Math.sqrt(variance);
    if (stddevDeg > MERIDIAN_MAX_STDDEV_DEG) continue;
    const sorted = [...angles].sort((a, b) => a - b);
    const cluster = { key, count: angles.length, medianTiltDeg: sorted[Math.floor(sorted.length / 2)], stddevDeg };
    if (!best || cluster.count > best.count) best = cluster;
  }
  return best;
}
