/**
 * Retry delay while the server is unreachable (package 9: SYNC-11 drain
 * retry, WEB-03 shell reconnect): 2 s, 4 s, 8 s, ... capped at 30 s.
 * `attempt` counts the failures so far, from 0.
 */
export const RETRY_BASE_MS = 2_000;
export const RETRY_MAX_MS = 30_000;

export function retryDelayMs(attempt: number): number {
  const n = Math.max(0, Math.floor(attempt));
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(n, 10));
}
