import { useCallback, useSyncExternalStore } from "react";

/**
 * Module-level subscriber registry so multiple `useLocalStorage` hooks for
 * the same key inside a single tab stay in sync without round-tripping
 * through the `storage` event (which only fires on _other_ tabs).
 */
const listeners = new Map<string, Set<() => void>>();

function notify(key: string) {
  const set = listeners.get(key);
  if (!set) return;
  for (const cb of set) cb();
}

function subscribe(key: string, callback: () => void): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(callback);

  const onStorage = (e: StorageEvent) => {
    if (e.key === key) callback();
  };
  if (typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }

  return () => {
    set?.delete(callback);
    if (set && set.size === 0) listeners.delete(key);
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
}

function readValue<T>(key: string, defaultValue: T): T {
  if (typeof window === "undefined") return defaultValue;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return defaultValue;
    return JSON.parse(raw) as T;
  } catch {
    return defaultValue;
  }
}

/**
 * Reactive hook backed by `localStorage`. The value is JSON-serialized.
 * Multiple hooks for the same key in the same tab stay in sync (via the
 * module-level listener set), and cross-tab updates flow through the
 * browser's native `storage` event.
 */
export function useLocalStorage<T>(
  key: string,
  defaultValue: T,
): [T, (next: T | ((prev: T) => T)) => void] {
  const value = useSyncExternalStore(
    (cb) => subscribe(key, cb),
    () => readValue(key, defaultValue),
    () => defaultValue,
  );

  const setValue = useCallback(
    (next: T | ((prev: T) => T)) => {
      if (typeof window === "undefined") return;
      try {
        const prev = readValue(key, defaultValue);
        const resolved =
          typeof next === "function"
            ? (next as (prev: T) => T)(prev)
            : next;
        window.localStorage.setItem(key, JSON.stringify(resolved));
        notify(key);
      } catch {
        // localStorage can throw (quota, private mode). Silently ignore —
        // the UI state will simply not persist for this update.
      }
    },
    [key, defaultValue],
  );

  return [value, setValue];
}
