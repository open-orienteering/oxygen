import { useSyncExternalStore } from "react";

/**
 * Reactive hook that tracks whether a CSS media query matches the current
 * viewport. Internally uses `window.matchMedia` + `useSyncExternalStore` so
 * SSR-like environments without `window` get a stable `false` snapshot.
 *
 * Usage:
 *   const isWide = useMediaQuery("(min-width: 2200px)");
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = (callback: () => void): (() => void) => {
    if (typeof window === "undefined" || !window.matchMedia) {
      return () => {};
    }
    const mql = window.matchMedia(query);
    // Older Safari uses addListener/removeListener; modern browsers use
    // addEventListener/removeEventListener. Prefer the standard API but
    // fall back so we don't lose reactivity in any supported runtime.
    if (mql.addEventListener) {
      mql.addEventListener("change", callback);
      return () => mql.removeEventListener("change", callback);
    }
    mql.addListener(callback);
    return () => mql.removeListener(callback);
  };

  const getSnapshot = (): boolean => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  };

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
