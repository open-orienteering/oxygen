/** Argument parsing and output formatting for `map-rematch` (unit-tested). The flags are the backfill's. */

import type { RematchItem, RematchItemResult, RematchRun } from "../map-store/rematch.js";

export { parseBackfillArgs as parseRematchArgs } from "./map-backfill-args.js";

export function formatPlanLine(item: RematchItem): string {
  return `  ${item.kind} ${item.name} ${item.documentHash.slice(0, 12)} (${item.reason})`;
}

export function formatRematchLine(r: RematchItemResult, run: Pick<RematchRun, "processed" | "total">): string {
  const head = `[${run.processed}/${run.total}] ${r.kind} ${r.name} ${r.documentHash.slice(0, 12)} (${r.reason})`;
  if (r.outcome === "done") return `${head} → ${r.newDocumentHash?.slice(0, 12) ?? ""}${r.newDocumentHash === r.documentHash ? " (unchanged)" : ""}`;
  return `${head} → FAILED: ${r.error ?? "unknown error"}`;
}

export function formatRematchSummary(run: RematchRun): string {
  if (run.dryRun) return `dry run: ${run.total} pin(s) would be re-matched`;
  const secs = run.finishedAt ? ((run.finishedAt.getTime() - run.startedAt.getTime()) / 1000).toFixed(1) : "?";
  return `re-match done: ${run.done} re-matched, ${run.failed} failed, ${run.total} total in ${secs} s`;
}
