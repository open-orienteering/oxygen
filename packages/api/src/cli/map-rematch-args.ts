/**
 * Argument parsing and output formatting for `map-rematch` (unit-tested).
 * The flags are the retired backfill's (E5 removed `map-backfill`).
 */

import type { RematchItem, RematchItemResult, RematchRun } from "../map-store/rematch.js";

export interface RematchArgs {
  event: string | null;
  limit: number | undefined;
  dryRun: boolean;
}

export type ParsedArgs = { ok: true; value: RematchArgs } | { ok: false; error: string };

export function parseRematchArgs(argv: readonly string[]): ParsedArgs {
  const out: RematchArgs = { event: null, limit: undefined, dryRun: false };
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

/** A pin's current document, short; `-` for an unpinned row. */
const shortHash = (hash: string | null) => hash?.slice(0, 12) ?? "-";

export function formatPlanLine(item: RematchItem): string {
  return `  ${item.kind} ${item.name} ${shortHash(item.documentHash)} (${item.reason})`;
}

export function formatRematchLine(r: RematchItemResult, run: Pick<RematchRun, "processed" | "total">): string {
  const head = `[${run.processed}/${run.total}] ${r.kind} ${r.name} ${shortHash(r.documentHash)} (${r.reason})`;
  if (r.outcome === "done") return `${head} → ${r.newDocumentHash?.slice(0, 12) ?? ""}${r.newDocumentHash === r.documentHash ? " (unchanged)" : ""}`;
  return `${head} → FAILED: ${r.error ?? "unknown error"}`;
}

export function formatRematchSummary(run: RematchRun): string {
  if (run.dryRun) return `dry run: ${run.total} pin(s) would be re-matched`;
  const secs = run.finishedAt ? ((run.finishedAt.getTime() - run.startedAt.getTime()) / 1000).toFixed(1) : "?";
  return `re-match done: ${run.done} re-matched, ${run.failed} failed, ${run.total} total in ${secs} s`;
}
