/** Public control ids (the id space every control-facing endpoint uses). */

/** Extract the first numeric code from a control's `codes` string. */
export function firstCode(codes: string): number {
  const head = codes.split(";")[0]?.trim();
  const n = parseInt(head ?? "", 10);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * User-facing id for a control: first code, falling back to seq.
 * Every endpoint that exposes control ids to the web app (control.list,
 * course.controlCoordinates, …) must use the same ID space — the MapPanel
 * filters compare them directly.
 */
export function publicControlId(c: { codes: string; seq: number }): number {
  return firstCode(c.codes) || c.seq;
}

/** The display rule lives in `@oxygen/shared` (one rule for the API and the web, F32). */
export { displayCode, isStartOrFinish } from "@oxygen/shared";

/**
 * The code ranges a start or finish takes when created without one
 * (course-layer.md §6.3, F32; user decision 2026-11-12): non-control units
 * use codes below 10 — 1 is clear, 2 is normally check — so 3–10, then
 * 11–30, below the usual control codes (31 and up).
 */
export const START_FINISH_CODE_RANGES: readonly (readonly [number, number])[] = [
  [3, 10],
  [11, 30],
];

/**
 * The lowest code of `START_FINISH_CODE_RANGES` not in `used` (the event's
 * held codes: every live row's numeric codes and the seq of every live row
 * without a numeric code), or null when all are held.
 */
export function lowestFreeStartCode(used: ReadonlySet<number>): number | null {
  for (const [lo, hi] of START_FINISH_CODE_RANGES) {
    for (let n = lo; n <= hi; n++) if (!used.has(n)) return n;
  }
  return null;
}
