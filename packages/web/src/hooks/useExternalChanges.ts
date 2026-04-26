import { useEffect, useRef } from "react";
import { trpc } from "../lib/trpc";
import { usePageVisible } from "./usePageVisible";
import { usePerformanceSensitive } from "../lib/performance-mode";

/**
 * Mapping from oCounter table columns to the tRPC router keys
 * that should be invalidated when that counter changes.
 */
const COUNTER_TO_ROUTERS: Record<string, string[]> = {
  oRunner: ["runner", "lists", "competition"],
  oClass: ["class", "lists", "competition"],
  oCourse: ["course", "competition"],
  oControl: ["control", "course"],
  oClub: ["club", "competition"],
  oCard: ["cardReadout"],
  oPunch: ["cardReadout", "lists", "runner"],
  oTeam: ["competition"],
  oEvent: ["competition"],
};

type CounterState = Record<string, number>;

const POLL_INTERVAL_MS = 5_000;

/**
 * Poll oCounter to detect external changes (e.g. from MeOS) and
 * invalidate the corresponding TanStack Query caches so the UI
 * stays fresh without manual refresh.
 *
 * @param enabled - Only poll when a competition is selected (default: true)
 */
export function useExternalChanges(enabled = true) {
  const utils = trpc.useUtils();
  const prevCounters = useRef<CounterState | null>(null);
  const visible = usePageVisible();
  const performanceSensitive = usePerformanceSensitive();
  const active = enabled && visible && !performanceSensitive;

  const { data, refetch } = trpc.competition.counterState.useQuery(undefined, {
    enabled,
    refetchInterval: active ? POLL_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
    staleTime: 0,
  });

  // Catch up immediately whenever polling resumes (tab becomes visible
  // again, performance-sensitive page unmounts, ...) so we don't wait up
  // to POLL_INTERVAL_MS to detect anything that changed while paused.
  useEffect(() => {
    if (active) {
      refetch();
    }
  }, [active, refetch]);

  useEffect(() => {
    if (!data) return;

    const current: CounterState = data;
    const prev = prevCounters.current;

    if (prev) {
      const routersToInvalidate = new Set<string>();

      for (const [table, value] of Object.entries(current)) {
        if (prev[table] !== undefined && prev[table] !== value) {
          const routers = COUNTER_TO_ROUTERS[table];
          if (routers) {
            for (const r of routers) {
              routersToInvalidate.add(r);
            }
          }
        }
      }

      if (routersToInvalidate.size > 0) {
        for (const routerKey of routersToInvalidate) {
          const router = (utils as any)[routerKey];
          if (router && typeof (router as { invalidate?: () => void }).invalidate === "function") {
            (router as { invalidate: () => void }).invalidate();
          }
        }
      }
    }

    prevCounters.current = { ...current };
  }, [data, utils]);
}
