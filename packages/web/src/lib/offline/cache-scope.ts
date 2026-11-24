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

/**
 * Make the cache belong to `nameId`. Idempotent. Resolves once the previous
 * event's data is flushed to its blob and the new event's blob (if any) is
 * loaded, so callers can await it before selecting the event.
 */
export async function switchCacheScope(
  queryClient: QueryClient,
  nameId: string,
  persister: Persister,
  restoreFor: (nameId: string) => Promise<PersistedClient | undefined>,
): Promise<void> {
  if (cacheOwner(queryClient) === nameId) return;
  await queryClient.cancelQueries();
  // Flush the outgoing event now: the provider's persist is throttled, and its
  // next write after the swap would otherwise land under the new owner.
  if (cacheOwner(queryClient)) {
    await persister.persistClient({
      timestamp: Date.now(),
      buster: "",
      clientState: dehydrate(queryClient, { shouldDehydrateMutation: () => true }),
    });
  }
  const blob = await restoreFor(nameId);
  // From here on, synchronously: clear, hydrate, claim. A persist that fires in
  // between must never see a half-swapped cache.
  if (cacheOwner(queryClient) === nameId) return; // lost a race with another switch
  queryClient.getQueryCache().clear();
  if (blob && ownerOfPersisted(blob) === nameId) {
    // Queries only: paused mutations are already live in the mutation cache.
    hydrate(queryClient, { mutations: [], queries: blob.clientState.queries });
  }
  queryClient.setQueryData(CACHE_OWNER_KEY, nameId);
}
