/**
 * Pure retry / backoff policy for map tile fetches.
 *
 * Distinguishes rate-limit (429) from other failures so callers can honour
 * Retry-After when present. Empty tiles are not failures — the server now
 * returns a 200 transparent PNG for those.
 */

export const TILE_RETRY_BACKOFF_MS = [2_000, 10_000, 30_000, 60_000] as const;

export type TileRetryEntry = {
  failures: number;
  nextRetryAt: number;
};

export type TileRetryDecision =
  | { action: "ready" }
  | { action: "wait"; nextRetryAt: number }
  | { action: "skip_permanent" };

/**
 * Parse a Retry-After header value (seconds or HTTP-date) into an absolute
 * timestamp. Returns null when the header is missing / unusable.
 */
export function parseRetryAfterMs(
  header: string | null | undefined,
  nowMs: number,
): number | null {
  if (header == null || header === "") return null;
  const asSeconds = Number(header);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return nowMs + asSeconds * 1000;
  }
  const asDate = Date.parse(header);
  if (!Number.isNaN(asDate)) return asDate;
  return null;
}

/** Backoff delay for the Nth failure (1-based). Caps at the last step. */
export function backoffMsForFailure(failures: number): number {
  const idx = Math.max(0, Math.min(failures - 1, TILE_RETRY_BACKOFF_MS.length - 1));
  return TILE_RETRY_BACKOFF_MS[idx]!;
}

export function nextRetryAtForFailure(
  failures: number,
  nowMs: number,
  retryAfterHeader?: string | null,
): number {
  const fromHeader = parseRetryAfterMs(retryAfterHeader, nowMs);
  if (fromHeader != null) return Math.max(fromHeader, nowMs);
  return nowMs + backoffMsForFailure(failures);
}

/**
 * Mutable book of per-key retry state. Lives across TileLayer re-renders.
 */
export class TileRetryBook {
  private readonly entries = new Map<string, TileRetryEntry>();

  /** Whether this key may be requested right now. */
  decision(key: string, nowMs: number): TileRetryDecision {
    const entry = this.entries.get(key);
    if (!entry) return { action: "ready" };
    if (nowMs < entry.nextRetryAt) {
      return { action: "wait", nextRetryAt: entry.nextRetryAt };
    }
    return { action: "ready" };
  }

  recordFailure(
    key: string,
    nowMs: number,
    opts: { retryAfterHeader?: string | null } = {},
  ): TileRetryEntry {
    const prev = this.entries.get(key);
    const failures = (prev?.failures ?? 0) + 1;
    const entry: TileRetryEntry = {
      failures,
      nextRetryAt: nextRetryAtForFailure(
        failures,
        nowMs,
        opts.retryAfterHeader,
      ),
    };
    this.entries.set(key, entry);
    return entry;
  }

  clear(key: string): void {
    this.entries.delete(key);
  }

  /** Failure count for a key, or 0 when never failed. */
  failures(key: string): number {
    return this.entries.get(key)?.failures ?? 0;
  }

  /** Earliest nextRetryAt among keys still waiting, or null. */
  earliestRetryAt(keys: Iterable<string>, nowMs: number): number | null {
    let earliest: number | null = null;
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (!entry) continue;
      if (entry.nextRetryAt <= nowMs) continue;
      if (earliest == null || entry.nextRetryAt < earliest) {
        earliest = entry.nextRetryAt;
      }
    }
    return earliest;
  }
}
