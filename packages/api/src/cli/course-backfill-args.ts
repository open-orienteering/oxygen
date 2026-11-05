/** Pure argument parsing and output formatting for `course-backfill-structure` (unit-tested). */

import type { StructureBackfillResult, StructureBackfillRun } from "../course-structure-backfill.js";

export interface CourseBackfillArgs {
  event: string | null;
  dryRun: boolean;
  /** Directory the JSON report is written to; null = none. */
  out: string | null;
}

export type ParsedCourseBackfillArgs = { ok: true; value: CourseBackfillArgs } | { ok: false; error: string };

export function parseCourseBackfillArgs(argv: readonly string[]): ParsedCourseBackfillArgs {
  const out: CourseBackfillArgs = { event: null, dryRun: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const flag = eq === -1 ? a : a.slice(0, eq);
    const inline = eq === -1 ? undefined : a.slice(eq + 1);
    const next = () => {
      if (inline !== undefined) return inline;
      i += 1;
      return argv[i];
    };
    switch (flag) {
      case "--dry-run":
        out.dryRun = true;
        break;
      case "--event": {
        const v = next();
        if (!v) return { ok: false, error: "--event needs an event nameId" };
        out.event = v;
        break;
      }
      case "--out": {
        const v = next();
        if (!v) return { ok: false, error: "--out needs a directory" };
        out.out = v;
        break;
      }
      default:
        return { ok: false, error: `unknown argument: ${a}` };
    }
  }
  return { ok: true, value: out };
}

export function formatCourseLine(r: StructureBackfillResult, n: number, total: number): string {
  const head = `[${n}/${total}] ${r.event} / ${r.name} (${r.source || "no geometry"})`;
  if (r.outcome === "failed") return `${head} → FAILED: ${r.error ?? "unknown error"}`;
  if (r.outcome === "skipped") return `${head} → skipped (already has a structure)`;
  const parts = [`${r.items} sites`];
  if (r.circleGapControls) parts.push(`${r.circleGapControls} circle cut(s)`);
  if (r.legGaps) parts.push(`${r.legGaps} leg gap(s)`);
  if (r.objects) parts.push(`${r.objects} object(s)`);
  const c = r.comparison;
  if (c) parts.push(`bbox Δ${c.bboxDeltaMm.toFixed(3)} mm, positions Δ${c.positionDeltaMm.toFixed(3)} mm, circles ${c.circles.same}/${c.circles.compared} same, legs ${c.legs.withGaps}/${c.legs.pieces} gapped`);
  return `${head} → filled: ${parts.join(", ")}${r.note ? ` [${r.note}]` : ""}`;
}

export function formatCourseSummary(run: StructureBackfillRun, dryRun: boolean): string {
  if (dryRun) return `dry run: ${run.total} course(s) without a structure`;
  return `structure backfill: ${run.filled} filled, ${run.skipped} skipped, ${run.failed} failed of ${run.total}`;
}
