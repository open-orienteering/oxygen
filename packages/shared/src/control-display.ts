/**
 * How a site is labelled (docs/course-layer.md §6.3, F32). One rule for the
 * API (labels, sheets, the IOF / Purple Pen export) and the web.
 */

/** Extract the first numeric code from a control's `codes` string. */
export function firstCode(codes: string): number {
  const head = codes.split(";")[0]?.trim();
  const n = parseInt(head ?? "", 10);
  return Number.isNaN(n) ? 0 : n;
}

/** Whether a row is a start or finish: its kind, else the legacy `status` 4 / 5. */
export function isStartOrFinish(c: { kind?: string | null; status?: string | null }): boolean {
  return c.kind === "start" || c.kind === "finish" || c.status === "start" || c.status === "finish";
}

/**
 * The label a site is shown by: a start or finish by its name — it has a unit
 * code since F32, but labels, sheets and the IOF / Purple Pen export keep
 * "Start 1" / "Mål 1" (user decision 2026-11-12) — else its first code, else
 * its name, else its seq.
 */
export function displayCode(c: {
  codes: string;
  name?: string | null;
  seq?: number | null;
  kind?: string | null;
  status?: string | null;
}): string {
  const first = c.codes.split(";")[0]?.trim() ?? "";
  const name = c.name ?? "";
  const seq = c.seq != null ? String(c.seq) : "";
  if (isStartOrFinish(c)) return name || first || seq;
  return first || name || seq;
}
