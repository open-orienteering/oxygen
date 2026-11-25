/**
 * Monotonic server-side hybrid logical clock.
 *
 * One clock per node process. Server-originated journal entries (see
 * `journalEmit.ts`) tick it on emit; the ingestion path (`events.push`) folds
 * every received stamp into it, so this node never mints a stamp behind
 * anything it has already seen — the HLC invariant that keeps the journal's
 * total order consistent across nodes with skewed wall clocks.
 *
 * The pure tick/fold logic lives in `@oxygen/shared/hlc.ts`; this module only
 * owns the process-wide mutable state. The clock is in memory, and a restart
 * starts it at zero: the next tick is ≥ everything this node emitted before
 * only while the wall clock has not stepped back, and entries ingested from
 * a peer with a faster clock sit above it. `seedServerClock` therefore folds
 * the journal's highest stamp in at startup (review SYNC-01), so a stamp
 * minted after a restart never sorts behind an entry already journaled.
 */

import { type Hlc, HLC_ZERO, tickHlc, receiveHlc, decodeHlc } from "@oxygen/shared";

let clock: Hlc = HLC_ZERO;

/** Mint the stamp for a new server-originated journal entry. */
export function nextServerHlc(now: number = Date.now()): Hlc {
  clock = tickHlc(clock, now);
  return clock;
}

/** Fold a received stamp into the node clock (`local = max(local, incoming)`). */
export function foldServerHlc(incoming: Hlc): void {
  clock = receiveHlc(clock, incoming);
}

/**
 * Fold the highest HLC already in this node's journal into the clock (call
 * once at startup). `null` (an empty journal) changes nothing.
 */
export function seedServerClock(maxEncodedHlc: bigint | null): void {
  if (maxEncodedHlc === null || maxEncodedHlc <= 0n) return;
  foldServerHlc(decodeHlc(maxEncodedHlc));
}

/** Test-only: reset the process clock to zero. */
export function _resetServerClock(): void {
  clock = HLC_ZERO;
}
