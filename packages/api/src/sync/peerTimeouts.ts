/**
 * Deadlines for node-to-node tRPC calls (SYNC-21). Without one, a peer
 * that accepts the connection and then goes silent (cloud restart,
 * half-open mobile link) blocks the shipper cycle or a checkout forever.
 * The deadline covers the whole call including the response body, so a
 * slow-but-alive transfer must fit in it: bulk reads get the longer one.
 */

/** Small calls: push, unshipped, ack, since, lease acquire/release/holder, settings. */
export const PEER_CALL_TIMEOUT_MS = 30_000;

/** Bulk reads: exportSnapshot, exportBlob, exportMapRows. */
export const PEER_TRANSFER_TIMEOUT_MS = 120_000;

export interface PeerTimeoutOptions {
  callTimeoutMs?: number;
  transferTimeoutMs?: number;
}

/** tRPC call option carrying an abort signal that fires after `ms`. */
export function peerSignal(ms: number): { signal: AbortSignal } {
  return { signal: AbortSignal.timeout(ms) };
}

/** True when `err` (or its cause chain) is the abort a `peerSignal` raises. */
export function isPeerTimeout(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && i < 5; i++) {
    const name = (e as { name?: string }).name;
    if (name === "TimeoutError" || name === "AbortError") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}
