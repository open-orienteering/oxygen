/**
 * Performance-mode lock — pauses shell-side background pollers while a
 * heavyweight page (e.g. track replay) is mounted.
 *
 * Web Workers don't help here: the network/IndexedDB part of these polls
 * is already off-main, the bottleneck is the React commits that follow on
 * the main thread. Pausing the polls outright is what the replay's RAF
 * loop actually needs to stay smooth.
 *
 * The state lives in module scope (not React context) so that performance-
 * sensitive consumers and the polling components don't have to share a
 * provider tree. Multiple components can hold locks concurrently —
 * pollers stay paused as long as at least one lock is active.
 */

import { useEffect, useSyncExternalStore } from "react";

let count = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const cb of listeners) cb();
}

/**
 * Acquire a performance-sensitive lock. Returns a disposer that releases
 * the lock; idempotent (safe to call multiple times).
 */
export function acquirePerformanceLock(): () => void {
  count++;
  notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    count--;
    notify();
  };
}

function getSnapshot(): boolean {
  return count > 0;
}

function getServerSnapshot(): boolean {
  return false;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * Reactive boolean that flips while ANY component holds a performance lock.
 * Pollers gate their work on this so a backgrounded replay or other heavy
 * page doesn't get jittered by side activity.
 */
export function usePerformanceSensitive(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Hold a performance lock for the lifetime of the calling component.
 * Pass `active=false` to opt out without unmounting.
 */
export function usePerformanceLock(active = true): void {
  useEffect(() => {
    if (!active) return;
    return acquirePerformanceLock();
  }, [active]);
}
