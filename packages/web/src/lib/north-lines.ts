/**
 * Drawn magnetic-north-line staleness, as reported by the API
 * (`meridianStalenessDeg` on `clubMap.list`, `course.mapMetadata` and the
 * map upload mutations). Positive = the lines lag behind today's magnetic
 * north. The threshold mirrors `MERIDIAN_STALE_WARN_DEG` in the API.
 */
export const MERIDIAN_STALE_WARN_DEG = 1.0;

export type NorthLinesState =
  | { kind: "none" }
  | { kind: "current"; degrees: string }
  | { kind: "stale"; degrees: string };

/** Absolute value, one decimal — what the UI shows. */
export function formatStalenessDeg(stalenessDeg: number): string {
  return Math.abs(stalenessDeg).toFixed(1);
}

export function isMeridianStale(stalenessDeg: number | null | undefined): boolean {
  return (
    stalenessDeg != null &&
    Number.isFinite(stalenessDeg) &&
    Math.abs(stalenessDeg) >= MERIDIAN_STALE_WARN_DEG
  );
}

export function northLinesState(
  stalenessDeg: number | null | undefined,
): NorthLinesState {
  if (stalenessDeg == null || !Number.isFinite(stalenessDeg)) {
    return { kind: "none" };
  }
  const degrees = formatStalenessDeg(stalenessDeg);
  return isMeridianStale(stalenessDeg)
    ? { kind: "stale", degrees }
    : { kind: "current", degrees };
}
