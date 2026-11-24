/**
 * The persisted React Query cache belongs to ONE event at a time.
 *
 * Event-scoped tRPC procedures take `undefined` input, so their query keys do
 * not name the event: `[["runner","list"],{type:"query"}]` is the same key in
 * every event. Without scoping, event B briefly (or, offline, for good) showed
 * event A's runners, and an offline readout computed from them was queued
 * against B (review MC-04 / WEB-01 / SYNC-19; docs/system/offline-architecture.md
 * "Per-event query cache").
 *
 * The owner is a marker query inside the cache itself, so it is persisted and
 * restored together with the data it describes. Each event has its own
 * persisted blob; switching events flushes the old one, clears the queries
 * (never the mutation cache, which holds paused offline mutations) and
 * hydrates the new event's blob if there is one.
 */
import { dehydrate, hydrate, type QueryClient } from "@tanstack/react-query";
import type { PersistedClient, Persister } from "@tanstack/react-query-persist-client";

export const CACHE_OWNER_KEY = ["oxygen", "cacheOwner"] as const;

/** Which event the cached queries belong to; null = none claimed yet. */
export function cacheOwner(queryClient: QueryClient): string | null {
  return queryClient.getQueryData<string>(CACHE_OWNER_KEY) ?? null;
}

/** Owner recorded inside a persisted blob. */
export function ownerOfPersisted(client: PersistedClient | undefined): string | null {
  const q = client?.clientState.queries.find(
    (x) => JSON.stringify(x.queryKey) === JSON.stringify(CACHE_OWNER_KEY),
  );
  return typeof q?.state.data === "string" ? q.state.data : null;
}

/** Queries that belong to the user or the app, not to an event: kept across switches, never in an event's blob. */
function isUserKey(key: readonly unknown[]): boolean {
  const path = Array.isArray(key[0]) ? (key[0] as string[]).join(".") : "";
  return path.startsWith("users.");
}
const isMarker = (key: readonly unknown[]) => JSON.stringify(key) === JSON.stringify(CACHE_OWNER_KEY);
const isGlobalKey = (key: readonly unknown[]) => isUserKey(key) || isMarker(key);

let suspended = 0;
/** True while the cache is being swapped: the persister must not write a half-swapped snapshot. */
export function persistSuspended(): boolean {
  return suspended > 0;
}

let latestSwitch = 0;

/**
 * Make the cache belong to `nameId`. Idempotent. Resolves once the previous
 * event's data is flushed to its blob and the new event's blob (if any) is
 * loaded, so callers can await it before selecting the event. The LAST caller
 * wins: a switch overtaken by a later call (A to B to A) leaves the cache alone.
 */
export async function switchCacheScope(
  queryClient: QueryClient,
  nameId: string,
  persister: Persister,
  restoreFor: (nameId: string) => Promise<PersistedClient | undefined>,
): Promise<void> {
  const mine = ++latestSwitch;
  if (cacheOwner(queryClient) === nameId) return;
  await queryClient.cancelQueries({ predicate: (q) => !isGlobalKey(q.queryKey) });
  // Flush the outgoing event now so its latest data is in its blob before the swap.
  if (cacheOwner(queryClient)) {
    await persister.persistClient({
      timestamp: Date.now(),
      buster: "",
      clientState: dehydrate(queryClient, {
        shouldDehydrateMutation: () => true,
        shouldDehydrateQuery: (q) => !isUserKey(q.queryKey) && q.state.status === "success",
      }),
    });
  }
  if (latestSwitch !== mine) return;
  const blob = await restoreFor(nameId);
  if (latestSwitch !== mine) return;
  // From here on, synchronously, with persistence suspended: remove, hydrate,
  // claim. A write in between would file a half-swapped cache under the old
  // event's blob.
  suspended++;
  try {
    const cache = queryClient.getQueryCache();
    // A query a mounted component observes is reset in place, not removed:
    // removing it would leave the observer on a dead Query object that never
    // updates again. Unobserved ones are simply dropped.
    for (const q of cache.findAll({ predicate: (q) => !isGlobalKey(q.queryKey) })) {
      if (q.getObserversCount() > 0) q.reset();
      else cache.remove(q);
    }
    if (blob && ownerOfPersisted(blob) === nameId) {
      // Queries only: paused mutations are already live in the mutation cache.
      hydrate(queryClient, {
        mutations: [],
        queries: blob.clientState.queries.filter((q) => !isGlobalKey(q.queryKey)),
      });
    }
    // No observer holds the marker, so without this it is collected after the
    // default 24 h and every offline lookup would fail closed.
    queryClient.setQueryDefaults(CACHE_OWNER_KEY, { gcTime: Infinity, staleTime: Infinity });
    queryClient.setQueryData(CACHE_OWNER_KEY, nameId);
  } finally {
    suspended--;
  }
  // Mounted queries lost their data in the reset: fetch them for the new event.
  void queryClient.refetchQueries({ type: "active", predicate: (q) => !isGlobalKey(q.queryKey) && q.state.data === undefined });
}
