/**
 * Clock-skew detector.
 *
 * On each successful sync the client compares its wall clock to the server's
 * (`serverTimeMs` in the `events.push` response). If they differ by more than
 * the threshold, a persistent banner warns the operator that times recorded on
 * this device may be inaccurate. See docs/offline-architecture.md
 * § "Clock skew detection".
 *
 * Tiny external store so React can subscribe via `useSyncExternalStore`.
 */

export const CLOCK_SKEW_THRESHOLD_MS = 30_000;

let skewMs = 0;
const listeners = new Set<() => void>();

/**
 * Record skew = `localMs - serverTimeMs`. Network latency makes the server
 * time slightly stale on arrival, but that is negligible against the 30s
 * threshold, so we do not try to correct for it.
 */
export function recordClockSkew(serverTimeMs: number, localMs: number): void {
  const next = localMs - serverTimeMs;
  if (next === skewMs) return;
  skewMs = next;
  for (const l of listeners) l();
}

export function getClockSkewMs(): number {
  return skewMs;
}

export function subscribeClockSkew(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
