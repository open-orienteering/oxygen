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
 * owns the process-wide mutable state. In-memory is sufficient: HLC physical
 * time is anchored to the wall clock, so after a restart the next tick is
 * already ≥ everything this node emitted before (barring a backwards wall
 * clock step, which the fold-on-receive path re-corrects on first contact).
 */

import { type Hlc, HLC_ZERO, tickHlc, receiveHlc } from "@oxygen/shared";

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

/** Test-only: reset the process clock to zero. */
export function _resetServerClock(): void {
  clock = HLC_ZERO;
}
