import { useEffect } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { trpc } from "../lib/trpc";
import { offlineDb, type OxygenEvent } from "../lib/offline/db";
import { hydrateRunners, hydrateReference } from "../lib/offline/projection";

/**
 * Keep the Dexie snapshot cache for `competitionId` in sync as
 * **server snapshot + own-writes overlay**. Rebuilds whenever the tRPC
 * snapshot refetches (the existing polling drives that) or the pending
 * outbox changes.
 *
 * The three queries are shared with `useStationSync` via React Query's cache,
 * so this does not double-fetch. No-op when `enabled` is false (feature flag
 * off) — the projection is simply not maintained until the read cutover.
 */
export function useProjectionSync(competitionId: string, enabled: boolean): void {
  const { data: runners } = trpc.runner.list.useQuery(undefined, { enabled });
  const { data: dashboard } = trpc.competition.dashboard.useQuery(undefined, {
    enabled,
  });
  const { data: controls } = trpc.control.list.useQuery(undefined, { enabled });

  const pending = useLiveQuery(
    () =>
      enabled
        ? offlineDb.events
            .where("competitionId")
            .equals(competitionId)
            .filter((e) => e.status === "pending")
            .toArray()
        : Promise.resolve([] as OxygenEvent[]),
    [competitionId, enabled],
    [] as OxygenEvent[],
  );

  // Runner / punch / readout projection = snapshot + pending overlay.
  useEffect(() => {
    if (!enabled || !runners) return;
    void hydrateRunners(competitionId, runners, pending ?? []);
  }, [enabled, competitionId, runners, pending]);

  // Reference projection (classes / courses / controls) from snapshots.
  useEffect(() => {
    if (!enabled || !dashboard) return;
    void hydrateReference(
      competitionId,
      dashboard.classes,
      dashboard.courses,
      controls ?? [],
    );
  }, [enabled, competitionId, dashboard, controls]);
}
