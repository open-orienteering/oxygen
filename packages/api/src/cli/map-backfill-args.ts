/** Pure argument parsing and output formatting for `map-backfill` (unit-tested). */

import type { BackfillItemResult, BackfillRun } from "../map-store/backfill.js";

export interface BackfillArgs {
  event: string | null;
  limit: number | undefined;
  dryRun: boolean;
}

export type ParsedArgs = { ok: true; value: BackfillArgs } | { ok: false; error: string };

export function parseBackfillArgs(argv: readonly string[]): ParsedArgs {
  const out: BackfillArgs = { event: null, limit: undefined, dryRun: false };
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
      case "--limit": {
        const v = next();
        const n = Number(v);
        if (!v || !Number.isInteger(n) || n <= 0) return { ok: false, error: "--limit needs a positive integer" };
        out.limit = n;
        break;
      }
      default:
        return { ok: false, error: `unknown argument: ${a}` };
    }
  }
  return { ok: true, value: out };
}

export function formatItemLine(r: BackfillItemResult, run: Pick<BackfillRun, "processed" | "total">): string {
  const head = `[${run.processed}/${run.total}] ${r.kind} #${r.id} ${r.name}`;
  if (r.outcome === "done") return `${head} → done ${r.documentHash?.slice(0, 12) ?? ""}${r.deduplicated ? " (already imported)" : ""}`;
  return `${head} → FAILED: ${r.error ?? "unknown error"}`;
}

export function formatSummary(run: BackfillRun): string {
  const secs = run.finishedAt ? ((run.finishedAt.getTime() - run.startedAt.getTime()) / 1000).toFixed(1) : "?";
  if (run.state === "failed") return `backfill aborted after ${run.processed}/${run.total}: ${run.error}`;
  if (run.dryRun) return `dry run: ${run.total} map(s) would be imported`;
  return `backfill ${run.state}: ${run.done} imported, ${run.failed} failed, ${run.total} total in ${secs} s`;
}
