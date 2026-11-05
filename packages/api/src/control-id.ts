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
