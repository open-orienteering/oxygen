import { useSyncExternalStore } from "react";

function subscribe(callback: () => void) {
  document.addEventListener("visibilitychange", callback);
  return () => {
    document.removeEventListener("visibilitychange", callback);
  };
}

function getSnapshot() {
  return document.visibilityState !== "hidden";
}

function getServerSnapshot() {
  return true;
}

/**
 * Reactive hook that tracks page visibility (Page Visibility API).
 * Returns `true` while the tab is visible, `false` when hidden / minimized.
 *
 * Use this to gate periodic polling so backgrounded tabs don't spend CPU
 * (and battery) on work the user can't see.
 */
export function usePageVisible(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
