import { useEffect, useState, useCallback } from "react";
import { useOnlineStatus } from "./useOnlineStatus";
import { usePageVisible } from "./usePageVisible";
import { getPendingCount } from "../lib/offline/events";
import { drainEventQueue, cleanupSyncedEvents } from "../lib/offline/sync";
import { trpc } from "../lib/trpc";
import { usePerformanceSensitive } from "../lib/performance-mode";

/**
 * Hook that manages the offline event queue:
 * - Tracks pending event count
 * - Auto-drains when connectivity is restored
 * - Invalidates React Query cache after successful drain
 *
 * @param competitionId - Optional filter for competition-specific events
 */
export function useEventQueue(competitionId?: string) {
  const isOnline = useOnlineStatus();
  const visible = usePageVisible();
  const performanceSensitive = usePerformanceSensitive();
  const pollingActive = visible && !performanceSensitive;
  const [pendingCount, setPendingCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const utils = trpc.useUtils();

  // Poll pending count. The 2s cadence is only useful while the user can
  // actually see the indicator change — when the tab is hidden, or a
  // performance-sensitive page like the replay viewer is mounted, we
  // refresh once and idle until polling resumes.
  useEffect(() => {
    const refresh = async () => {
      const filtered = await getPendingCount(competitionId);
      const total = await getPendingCount();
      if (total > 0) {
        console.log(`[event-queue] pending: ${filtered} (filtered by "${competitionId}"), ${total} (total)`);
      }
      setPendingCount(filtered);
    };
    refresh();
    if (!pollingActive) return;
    const interval = setInterval(refresh, 2000);
    return () => clearInterval(interval);
  }, [competitionId, pollingActive]);

  // Auto-drain when coming back online
  useEffect(() => {
    if (!isOnline || pendingCount === 0) return;

    let cancelled = false;

    const drain = async () => {
      setSyncing(true);
      try {
        const count = await drainEventQueue(competitionId);
        if (!cancelled && count > 0) {
          // Refresh pending count
          const remaining = await getPendingCount(competitionId);
          setPendingCount(remaining);

          // Invalidate relevant queries so UI refreshes with server data
          await utils.runner.list.invalidate();
          await utils.competition.dashboard.invalidate();
          await utils.lists.resultList.invalidate();
          await utils.race.recentActivity.invalidate();
        }
      } finally {
        if (!cancelled) setSyncing(false);
      }
    };

    drain();

    return () => { cancelled = true; };
  }, [isOnline, pendingCount > 0, competitionId, utils]);

  // Periodic cleanup of old synced events
  useEffect(() => {
    cleanupSyncedEvents();
    const interval = setInterval(cleanupSyncedEvents, 60 * 60 * 1000); // hourly
    return () => clearInterval(interval);
  }, []);

  const manualDrain = useCallback(async () => {
    setSyncing(true);
    try {
      await drainEventQueue(competitionId);
      const remaining = await getPendingCount(competitionId);
      setPendingCount(remaining);
      await utils.invalidate();
    } finally {
      setSyncing(false);
    }
  }, [competitionId, utils]);

  return {
    pendingCount,
    syncing,
    isOnline,
    manualDrain,
  };
}
