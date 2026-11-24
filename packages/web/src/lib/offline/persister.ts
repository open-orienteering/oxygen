import { get, set, del } from "idb-keyval";
import type { PersistedClient, Persister } from "@tanstack/react-query-persist-client";
import { activeEventNameId } from "../trpc";
import type { QueryClient } from "@tanstack/react-query";
import { ownerOfPersisted, persistSuspended, switchCacheScope } from "./cache-scope";

const LEGACY_KEY = "oxygen-query-cache";
const PREFIX = "oxygen-query-cache:";
const GLOBAL = "_global";

export const blobKey = (owner: string | null) => `${PREFIX}${owner ?? GLOBAL}`;

const LAST_KEY = `${PREFIX}last-owner`;

export interface KeyValueStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
}

const idbStore: KeyValueStore = {
  get: (k) => get(k),
  set: (k, v) => set(k, v),
  del: (k) => del(k),
};

/**
 * IndexedDB-backed persister for TanStack Query, one blob per event.
 *
 * A write goes under the owner recorded in the cache being written (not the
 * URL), so a write racing an event switch cannot put A's data under B. A
 * restore reads the blob of the event the URL names. The single-key cache of
 * earlier versions has no owner and is dropped; stations re-warm online once.
 */
export function createIdbPersister(
  store: KeyValueStore = idbStore,
  currentEvent: () => string | null = activeEventNameId,
): Persister {
  return {
    persistClient: async (client: PersistedClient) => {
      if (persistSuspended()) return;
      const owner = ownerOfPersisted(client);
      await store.set(blobKey(owner), client);
      // Pages outside an event (the selector) restore whatever was persisted last:
      // it carries the freshest shared queries (event list, session) and its own
      // owner marker, so an event page still switches away from it.
      if (owner) await store.set(LAST_KEY, owner);
    },
    restoreClient: async () => {
      void store.del(LEGACY_KEY).catch(() => {});
      const event = currentEvent() ?? ((await store.get(LAST_KEY)) as string | undefined) ?? null;
      return (await store.get(blobKey(event))) as PersistedClient | undefined;
    },
    removeClient: async () => {
      await store.del(blobKey(currentEvent()));
    },
  };
}

export const queryCachePersister = createIdbPersister();

/** Blob of one event, for `switchCacheScope`. */
export const restoreBlobFor = (nameId: string) => idbStore.get(blobKey(nameId));


/** Make the live cache belong to this event (flush the old one, load this one's). */
export function ensureEventCache(queryClient: QueryClient, nameId: string): Promise<void> {
  return switchCacheScope(queryClient, nameId, queryCachePersister, restoreBlobFor);
}
