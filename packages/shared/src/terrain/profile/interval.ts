/**
 * The contour interval a person confirms (docs/course-elevation.md §0.43): above 0, at most 100 m, at most two
 * decimals. One rule for the API's refusal and the editor's input.
 */

export const MAX_CONTOUR_INTERVAL_M = 100;

/** Whether `m` is a value a map's interval may be confirmed to. */
export function validContourInterval(m: number): boolean {
  return Number.isFinite(m) && m > 0 && m <= MAX_CONTOUR_INTERVAL_M && Math.abs(m * 100 - Math.round(m * 100)) < 1e-6;
}

/** A value as typed (a comma is a decimal point): the interval, or null when it is not a usable one. */
export function parseContourInterval(text: string | number): number | null {
  const m = typeof text === "number" ? text : Number(text.trim().replace(",", "."));
  return text !== "" && validContourInterval(m) ? m : null;
}
