/**
 * Hybrid Logical Clock (HLC).
 *
 * Every journal entry is stamped with an HLC so that nodes whose wall clocks
 * disagree can still produce a consistent total ordering. See
 * `docs/offline-architecture.md` § "Hybrid logical clock (HLC)".
 *
 *   hlc = (physical_ms : 48 bits) || (logical : 16 bits)   — encoded as an 8-byte BIGINT
 *
 * `physical` is wall-clock milliseconds since the Unix epoch (fits in 48 bits
 * until the year ~10889). `logical` is a 16-bit counter (0..65535) that breaks
 * ties when two stamps land in the same physical millisecond.
 *
 * This module is pure: it never reads the clock itself. Callers pass the
 * current wall-clock `now` (e.g. `Date.now()`) so the logic stays testable and
 * identical on every tier (PWA, relay, cloud).
 *
 * NOTE: the *value* of HLC — skew-robust ordering once two peers gossip —
 * only materialises once a relay (or mesh) exists to exchange clocks. In the
 * cloud-hub topology (Phase 1) it behaves as a well-defined sort key derived
 * from each device's wall clock; the gossip benefit lands with the relay
 * (Phase 3). The encoding and storage column are introduced now so no second
 * migration is needed later.
 */

/** A decoded hybrid logical clock. */
export interface Hlc {
  /** Wall-clock milliseconds since the Unix epoch (48-bit range). */
  physical: number;
  /** Tie-break counter within a single physical millisecond (0..65535). */
  logical: number;
}

/** Number of low bits reserved for the logical counter. */
export const HLC_LOGICAL_BITS = 16n;
/** Mask selecting the logical counter from an encoded HLC. */
const HLC_LOGICAL_MASK = 0xffffn;
/** Maximum logical value before it overflows into the next physical ms. */
export const HLC_MAX_LOGICAL = 0xffff;

/** The zero clock — sorts before every real stamp. */
export const HLC_ZERO: Hlc = { physical: 0, logical: 0 };

/** Encode a decoded HLC into the single BIGINT stored on the wire and in the DB. */
export function encodeHlc(h: Hlc): bigint {
  return (BigInt(h.physical) << HLC_LOGICAL_BITS) | BigInt(h.logical);
}

/** Decode a stored BIGINT back into its physical/logical components. */
export function decodeHlc(v: bigint): Hlc {
  return {
    physical: Number(v >> HLC_LOGICAL_BITS),
    logical: Number(v & HLC_LOGICAL_MASK),
  };
}

/**
 * Total order on HLCs alone. Returns -1, 0, or 1.
 * Entry-level ordering additionally breaks `0` ties on `(stationId, id)` — see
 * `compareEntries` in `applyEvent.ts`; this function is HLC-only.
 */
export function compareHlc(a: Hlc, b: Hlc): -1 | 0 | 1 {
  if (a.physical !== b.physical) return a.physical < b.physical ? -1 : 1;
  if (a.logical !== b.logical) return a.logical < b.logical ? -1 : 1;
  return 0;
}

/**
 * Produce the stamp for a new local event.
 *
 *   physical = max(now, last.physical)
 *   - if physical advanced past last → logical resets to 0
 *   - if physical is unchanged       → logical bumps
 *   - if logical would overflow      → physical += 1, logical = 0
 *
 * The returned value is both the new event's stamp and the node's new local
 * clock (the next `tickHlc` continues from here).
 */
export function tickHlc(last: Hlc, now: number): Hlc {
  const physical = Math.max(now, last.physical);
  if (physical !== last.physical) {
    return { physical, logical: 0 };
  }
  const logical = last.logical + 1;
  if (logical > HLC_MAX_LOGICAL) {
    return { physical: last.physical + 1, logical: 0 };
  }
  return { physical, logical };
}

/**
 * Fold a received stamp into the local clock: `local = max(local, incoming)`.
 * The next `tickHlc` then bumps from the merged value, so a node that has
 * gossiped with a faster peer never mints a stamp behind what it has seen.
 */
export function receiveHlc(local: Hlc, incoming: Hlc): Hlc {
  return compareHlc(local, incoming) >= 0 ? local : incoming;
}
