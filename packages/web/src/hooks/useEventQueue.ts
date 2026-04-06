import { useEffect, useState, useCallback } from "react";
import { useOnlineStatus } from "./useOnlineStatus";
import { getPendingCount } from "../lib/offline/events";
import { drainEventQueue, cleanupSyncedEvents } from "../lib/offline/sync";
import { trpc } from "../lib/trpc";

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
  const [pendingCount, setPendingCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const utils = trpc.useUtils();

  // Poll pending count
  useEffect(() => {
    const refresh = () => getPendingCount(competitionId).then(setPendingCount);
    refresh();
    const interval = setInterval(refresh, 2000);
    return () => clearInterval(interval);
  }, [competitionId]);

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
