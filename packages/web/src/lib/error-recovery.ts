/**
 * Error-boundary helpers (WEB-15).
 *
 * A page that throws while rendering is contained by the nearest boundary,
 * so the shell's header, tabs and card notifications stay. A failed lazy
 * chunk cannot be recovered in place: `React.lazy` keeps the rejected
 * import, so "Try again" would throw the same error. Only a reload loads
 * it, and the reload is bounded so a device that cannot fetch the chunk
 * does not loop.
 */

const CHUNK_ERROR = /failed to fetch dynamically imported module|importing a module script failed|error loading dynamically imported module|loading chunk [\w-]+ failed|unable to preload css/i;

export function isChunkLoadError(err: unknown): boolean {
  if (!err) return false;
  const message = err instanceof Error ? err.message : String((err as { message?: unknown }).message ?? err);
  return CHUNK_ERROR.test(message) || (err as { name?: unknown }).name === "ChunkLoadError";
}

const CHUNK_RELOAD_KEY = "oxygen.chunkReloads";
const CHUNK_RELOAD_WINDOW_MS = 5 * 60_000;
const CHUNK_RELOAD_MAX = 2;

type KV = Pick<Storage, "getItem" | "setItem">;

/** At most two chunk reloads per five minutes per tab; counts the one it allows. */
export function canReloadForChunk(storage: KV | null, now = Date.now()): boolean {
  if (!storage) return true;
  try {
    const raw = storage.getItem(CHUNK_RELOAD_KEY);
    const times = (raw ? (JSON.parse(raw) as unknown[]) : [])
      .filter((t): t is number => typeof t === "number" && now - t < CHUNK_RELOAD_WINDOW_MS);
    if (times.length >= CHUNK_RELOAD_MAX) return false;
    storage.setItem(CHUNK_RELOAD_KEY, JSON.stringify([...times, now]));
    return true;
  } catch {
    return true;
  }
}

/** A boundary showing an error resets when its key (the route, the card) changes. */
export function shouldResetBoundary(prevKey: unknown, nextKey: unknown, hasError: boolean): boolean {
  return hasError && prevKey !== nextKey;
}
