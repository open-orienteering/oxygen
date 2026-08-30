import { useMemo } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";
import { createUpdateActivator } from "../lib/app-update";

/**
 * How often to ask the browser whether a new bundle has been deployed.
 *
 * The browser only looks for a new service worker on navigation, so a tab
 * left open across a deploy would never notice one on its own.
 */
const CHECK_INTERVAL_MS = 60_000;

/**
 * Watch for a newly deployed web bundle.
 *
 * `bundleWaiting` turns true once a service worker has installed and is
 * waiting to take over. `activate` hands control to it and reloads, which
 * is what actually escapes the cached bundle — a plain reload does not.
 */
export function useServiceWorkerUpdate(): {
  bundleWaiting: boolean;
  activate: () => void;
} {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return;
      setInterval(() => {
        void registration.update();
      }, CHECK_INTERVAL_MS);
    },
  });

  // Activation with a hard-reload fallback: `updateServiceWorker(true)`
  // silently does nothing when the tab isn't SW-controlled or the waiting
  // worker is gone — see createUpdateActivator.
  const activate = useMemo(
    () =>
      createUpdateActivator({
        activate: () => {
          void updateServiceWorker(true);
        },
        reload: () => window.location.reload(),
      }),
    [updateServiceWorker],
  );

  return {
    bundleWaiting: needRefresh,
    activate,
  };
}
