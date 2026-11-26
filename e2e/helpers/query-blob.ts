import type { Page } from "@playwright/test";

/**
 * True when the persisted per-event query cache blob of `nameId`
 * (idb-keyval's default store, `packages/web/src/lib/offline/persister.ts`)
 * holds a successful query for `path` (e.g. "runner.list"). Poll this
 * instead of sleeping for the persister's throttle.
 */
export function blobHasQuery(page: Page, nameId: string, path: string): Promise<boolean> {
  return page.evaluate(
    async ({ nameId, path }) => {
      const db = await new Promise<IDBDatabase | null>((res) => {
        const r = indexedDB.open("keyval-store");
        r.onsuccess = () => res(r.result);
        r.onerror = () => res(null);
      });
      if (!db) return false;
      try {
        if (!db.objectStoreNames.contains("keyval")) return false;
        const store = db.transaction("keyval").objectStore("keyval");
        const keys = await new Promise<IDBValidKey[]>((res) => {
          const q = store.getAllKeys();
          q.onsuccess = () => res(q.result);
          q.onerror = () => res([]);
        });
        const key = keys.find((k) => String(k) === `oxygen-query-cache:${nameId}`);
        if (key === undefined) return false;
        const blob = await new Promise<unknown>((res) => {
          const q = db.transaction("keyval").objectStore("keyval").get(key);
          q.onsuccess = () => res(q.result);
          q.onerror = () => res(null);
        });
        const queries = (blob as { clientState?: { queries?: Array<{ queryKey: unknown[]; state: { status: string } }> } })
          ?.clientState?.queries ?? [];
        return queries.some(
          (q) => Array.isArray(q.queryKey[0]) && (q.queryKey[0] as string[]).join(".") === path && q.state.status === "success",
        );
      } finally {
        db.close();
      }
    },
    { nameId, path },
  );
}
