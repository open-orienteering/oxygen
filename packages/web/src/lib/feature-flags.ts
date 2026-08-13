import { useSyncExternalStore } from "react";

/**
 * Minimal feature-flag helper.
 *
 * The offline Dexie snapshot cache is gated by a single localStorage boolean
 * so the station read cutover can be exercised in development before it ships
 * (pivot Step 6 in docs/future-architecture.md). It is intentionally tiny —
 * not a per-competition system. Default OFF: station reads stay on
 * tRPC / React Query.
 */
const OFFLINE_PROJECTION_KEY = "oxygen-offline-projection";

const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

export function isOfflineProjectionEnabled(): boolean {
  try {
    return localStorage.getItem(OFFLINE_PROJECTION_KEY) === "1";
  } catch {
    return false;
  }
}

export function setOfflineProjectionEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(OFFLINE_PROJECTION_KEY, "1");
    else localStorage.removeItem(OFFLINE_PROJECTION_KEY);
  } catch {
    /* localStorage unavailable — flag stays off */
  }
  notify();
}

/** React hook — re-renders when the flag flips (incl. cross-tab via `storage`). */
export function useOfflineProjectionEnabled(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      const onStorage = (e: StorageEvent) => {
        if (e.key === OFFLINE_PROJECTION_KEY) cb();
      };
      window.addEventListener("storage", onStorage);
      return () => {
        listeners.delete(cb);
        window.removeEventListener("storage", onStorage);
      };
    },
    isOfflineProjectionEnabled,
    () => false,
  );
}
