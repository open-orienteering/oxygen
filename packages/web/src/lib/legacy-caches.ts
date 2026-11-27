/**
 * Cache Storage the service worker filled under routes it no longer has
 * (docs/map-storage.md §7.1). Workbox's generated worker cleans up only
 * its own precaches, so a runtime cache whose route is gone stays in every
 * installed client until it is deleted here. `map-tiles` held up to 2 000
 * PNG tiles (CacheFirst, `/api/map-tile/…`) until E4b removed the tile
 * layer. `trpc-api` (NetworkFirst, `/trpc/…`) and `api-misc`
 * (`/api/version`) went in package 9 (SYNC-16): a stale tRPC answer was
 * served as a fresh 200.
 */
export const LEGACY_CACHE_NAMES = ["map-tiles", "trpc-api", "api-misc"] as const;

/** Deletes the legacy caches; a missing Cache Storage or a refused delete is not an error. */
export async function dropLegacyCaches(
  storage: Pick<CacheStorage, "delete"> | undefined = typeof caches === "undefined" ? undefined : caches,
): Promise<void> {
  if (!storage) return;
  for (const name of LEGACY_CACHE_NAMES) {
    try {
      await storage.delete(name);
    } catch (err) {
      console.warn(`Could not delete the legacy cache "${name}"`, err);
    }
  }
}
