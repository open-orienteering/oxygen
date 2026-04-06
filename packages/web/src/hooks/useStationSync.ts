import { useEffect } from "react";
import { trpc } from "../lib/trpc";

/**
 * Pre-fetches and keeps all competition data warm for offline station use.
 * Call this from station pages (FinishStation, StartStation, Registration).
 *
 * Sets gcTime: Infinity so data survives indefinitely in IndexedDB —
 * critical for overnight offline (synced evening before, no internet on race day).
 *
 * Data is refreshed automatically by useExternalChanges polling when online.
 */
export function useStationSync(enabled: boolean) {
  const utils = trpc.useUtils();

  // Pre-fetch all critical data on mount
  useEffect(() => {
    if (!enabled) return;

    // Prefetch all competition data in parallel
    utils.competition.dashboard.prefetch(undefined, {
      staleTime: 60_000,
    });
    utils.competition.clubs.prefetch(undefined, {
      staleTime: 60_000,
    });
    utils.competition.getRegistrationConfig.prefetch(undefined, {
      staleTime: 60_000,
    });
    utils.runner.list.prefetch(undefined, {
      staleTime: 30_000,
    });
    utils.control.list.prefetch(undefined, {
      staleTime: 60_000,
    });
    // Runner DB for offline registration autocomplete (~9 MB, rarely changes)
    utils.eventor.runnerDbDump.prefetch(undefined, {
      staleTime: 10 * 60_000, // 10 min — only re-fetches if user stays on page
    });
  }, [enabled, utils]);

  // Keep queries with long gcTime so they survive in persisted cache
  // These queries run with gcTime: Infinity on station pages
  trpc.competition.dashboard.useQuery(undefined, {
    enabled,
    staleTime: 60_000,
    gcTime: Infinity,
  });
  trpc.competition.clubs.useQuery(undefined, {
    enabled,
    staleTime: 60_000,
    gcTime: Infinity,
  });
  trpc.competition.getRegistrationConfig.useQuery(undefined, {
    enabled,
    staleTime: 60_000,
    gcTime: Infinity,
  });
  trpc.runner.list.useQuery(undefined, {
    enabled,
    staleTime: 30_000,
    gcTime: Infinity,
  });
  trpc.control.list.useQuery(undefined, {
    enabled,
    staleTime: 60_000,
    gcTime: Infinity,
  });
  trpc.eventor.runnerDbDump.useQuery(undefined, {
    enabled,
    staleTime: 10 * 60_000,
    gcTime: Infinity,
  });
}
