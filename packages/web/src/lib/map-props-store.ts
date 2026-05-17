import { useLayoutEffect, useSyncExternalStore } from "react";
import type { MapPanelPublicProps } from "../components/MapPanel";

/**
 * Tiny vanilla store for the props that drive the shell-owned persistent
 * `<MapPanel>`. Pages publish their map configuration via `useMapState` and
 * the shell consumes it via `useMapPanelProps`. By living outside the
 * routed page tree, the MapPanel stays mounted across navigations — its
 * Leaflet-substitute setup (tile poller, ResizeObserver, viewport math)
 * runs once per session instead of on every route change.
 *
 * No new dependency: built on `useSyncExternalStore`.
 */

let current: MapPanelPublicProps | null = null;
const listeners = new Set<() => void>();

function setMapProps(next: MapPanelPublicProps | null) {
  // Pages create a fresh props object on every render (JSX prop spread).
  // We still want every notification to reach the shell — React.memo on
  // the MapPanel then short-circuits the heavy work when shallow-equal.
  // A reference compare here would be a no-op in practice; we run the
  // notification unconditionally.
  current = next;
  for (const l of listeners) l();
}

/**
 * Publish the current page's map configuration. Pass `null` while the
 * caller does NOT want to drive the pane (e.g. on narrow viewports, or
 * while the user has collapsed the pane — the caller decides).
 *
 * Uses layout effects so the store is consistent with React state before
 * the next paint. On navigation, the outgoing page's cleanup fires
 * synchronously before the incoming page's setup, but React batches the
 * resulting renders into a single store update from the shell's
 * perspective — no intermediate blank flash.
 */
export function useMapState(props: MapPanelPublicProps | null): void {
  useLayoutEffect(() => {
    setMapProps(props);
  });
  useLayoutEffect(() => () => setMapProps(null), []);
}

/**
 * Subscribe to the active map configuration. The shell calls this in a
 * leaf component so a store change re-renders only that small subtree,
 * not the whole route tree.
 */
export function useMapPanelProps(): MapPanelPublicProps | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => current,
    () => null,
  );
}
