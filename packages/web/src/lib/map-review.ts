/**
 * Pure helpers of the import review screen (docs/map-symbols.md §8.7;
 * research 06 §5.1): row order, what a stored match means to the
 * reviewer, and the batch of decisions collected before `decide`.
 */

export interface ReviewMatchLike {
  canonicalId: string | null;
  method: string;
  state: "auto" | "suggested" | "unmatched";
  reviewed: boolean;
}

export interface ReviewRowLike {
  symbolIdx: number;
  code: string;
  objects: number;
  flags: readonly string[];
  match: ReviewMatchLike | null;
}

/**
 * What the document draws for a row, as the reviewer reads it:
 * `accepted` / `kept` are club decisions (`method: "explicit"`, §8.5),
 * `variant` is kept as source by design, `none` is a pre-matcher header.
 */
export type ReviewOutcome = "accepted" | "kept" | "suggested" | "auto" | "unmatched" | "variant" | "none";

export function rowOutcome(match: ReviewMatchLike | null): ReviewOutcome {
  if (!match) return "none";
  if (match.method === "explicit") return match.canonicalId ? "accepted" : "kept";
  if (match.state === "auto") return "auto";
  if (match.state === "suggested") return "suggested";
  return match.method === "variant" ? "variant" : "unmatched";
}

const byCode = (a: ReviewRowLike, b: ReviewRowLike) =>
  a.code.localeCompare(b.code, undefined, { numeric: true });

/** Used rows by object count (most used first, then code); unused rows apart, by code (06 §5.1). */
export function orderReviewRows<T extends ReviewRowLike>(rows: readonly T[]): { used: T[]; unused: T[] } {
  const used = rows.filter((r) => !r.flags.includes("unused"));
  const unused = rows.filter((r) => r.flags.includes("unused"));
  used.sort((a, b) => b.objects - a.objects || byCode(a, b));
  unused.sort(byCode);
  return { used, unused };
}

export type ReviewOutcomeCounts = Record<ReviewOutcome, number>;

export function summariseOutcomes(rows: readonly ReviewRowLike[]): ReviewOutcomeCounts {
  const counts: ReviewOutcomeCounts = { suggested: 0, accepted: 0, kept: 0, auto: 0, unmatched: 0, variant: 0, none: 0 };
  for (const r of rows) counts[rowOutcome(r.match)]++;
  return counts;
}

/** A decision on one row, as `mapImport.decide` takes it without the index (docs/map-import.md §2.2). */
export type PendingDecision = { accept: string } | { unmatch: true } | { reset: true };
export type PendingDecisions = ReadonlyMap<number, PendingDecision>;
export type ReviewDecisionInput =
  | { symbolIdx: number; accept: string }
  | { symbolIdx: number; unmatch: true }
  | { symbolIdx: number; reset: true };

/** True when `decision` would leave the row's club decision as it is. */
function restatesDecision(row: ReviewRowLike, decision: PendingDecision): boolean {
  const outcome = rowOutcome(row.match);
  if ("reset" in decision) return outcome !== "accepted" && outcome !== "kept";
  if ("unmatch" in decision) return outcome === "kept";
  return outcome === "accepted" && row.match?.canonicalId === decision.accept;
}

/**
 * Record (or with `null` clear) the pending decision of a row; a later
 * decision on the same row replaces the earlier one. A decision that
 * restates the row's existing club decision, or a reset of a row without
 * one, clears it instead: `decide` would write nothing new.
 */
export function setPending(pending: PendingDecisions, row: ReviewRowLike, decision: PendingDecision | null): PendingDecisions {
  const next = new Map(pending);
  if (decision === null || restatesDecision(row, decision)) next.delete(row.symbolIdx);
  else next.set(row.symbolIdx, decision);
  return next;
}

export function pendingToDecisions(pending: PendingDecisions): ReviewDecisionInput[] {
  return [...pending.entries()]
    .sort(([a], [b]) => a - b)
    .map(([symbolIdx, d]) => ({ symbolIdx, ...d }) as ReviewDecisionInput);
}

/** The candidate is what the document draws now. */
export function candidateIsCurrent(row: ReviewRowLike, canonicalId: string): boolean {
  return row.match?.canonicalId === canonicalId;
}

/**
 * Document previews reviewed from an event carry `?event=<nameId>` so the
 * route's event clause admits them; library previews are club-wide and
 * stay as given (docs/map-import.md §2.2, docs/map-storage.md §4.5).
 */
export function scopePreviewUrl(url: string | null, nameId: string | null): string | null {
  if (!url || !nameId || !url.startsWith("/api/map-documents/")) return url;
  return `${url}${url.includes("?") ? "&" : "?"}event=${encodeURIComponent(nameId)}`;
}

export function isJobPending(state: string): boolean {
  return state === "queued" || state === "running";
}

export function jobProgressPercent(progress: number): number {
  return Math.round(Math.min(1, Math.max(0, progress)) * 100);
}
