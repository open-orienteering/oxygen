import { useSyncExternalStore } from "react";

/**
 * Minimal feature-flag helper.
 *
 * The offline Dexie snapshot cache is gated by a single localStorage boolean
 * so the station read cutover can be exercised in development before it ships
 * (pivot Step 6 in docs/future-architecture.md). It is intentionally tiny —
 * not a per-competition system. Default OFF: station reads stay on
 * tRPC / React Query.
 */
const OFFLINE_PROJECTION_KEY = "oxygen-offline-projection";

const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

export function isOfflineProjectionEnabled(): boolean {
  try {
    return localStorage.getItem(OFFLINE_PROJECTION_KEY) === "1";
  } catch {
    return false;
  }
}

export function setOfflineProjectionEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(OFFLINE_PROJECTION_KEY, "1");
    else localStorage.removeItem(OFFLINE_PROJECTION_KEY);
  } catch {
    /* localStorage unavailable — flag stays off */
  }
  notify();
}

/** React hook — re-renders when the flag flips (incl. cross-tab via `storage`). */
export function useOfflineProjectionEnabled(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      const onStorage = (e: StorageEvent) => {
        if (e.key === OFFLINE_PROJECTION_KEY) cb();
      };
      window.addEventListener("storage", onStorage);
      return () => {
        listeners.delete(cb);
        window.removeEventListener("storage", onStorage);
      };
    },
    isOfflineProjectionEnabled,
    () => false,
  );
}

/**
 * Map pipeline of the viewer (docs/map-rendering.md §5.4 "Selecting the
 * layer"). Until B5 adds `events.map_pipeline`, the vector base layer is
 * opted into per browser: `localStorage["oxygen-map-pipeline"] = "vector"`.
 * Default `legacy` (tiles). B5 replaces this read and deletes the key.
 */
export type MapPipeline = "legacy" | "vector";

export const MAP_PIPELINE_KEY = "oxygen-map-pipeline";

export function readMapPipelineFlag(): MapPipeline {
  try {
    return localStorage.getItem(MAP_PIPELINE_KEY) === "vector" ? "vector" : "legacy";
  } catch {
    return "legacy";
  }
}

export function setMapPipelineFlag(pipeline: MapPipeline): void {
  try {
    if (pipeline === "vector") localStorage.setItem(MAP_PIPELINE_KEY, "vector");
    else localStorage.removeItem(MAP_PIPELINE_KEY);
  } catch {
    /* localStorage unavailable — flag stays legacy */
  }
  notify();
}

/** The pipeline a map actually uses: `vector` needs a pinned document, so a map without one stays on tiles. */
export function resolveMapPipeline(flag: MapPipeline, documentHash: string | null | undefined): MapPipeline {
  return flag === "vector" && documentHash ? "vector" : "legacy";
}

/** React hook — re-renders when the map pipeline flag flips (incl. cross-tab via `storage`). */
export function useMapPipelineFlag(): MapPipeline {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      const onStorage = (e: StorageEvent) => {
        if (e.key === MAP_PIPELINE_KEY) cb();
      };
      window.addEventListener("storage", onStorage);
      return () => {
        listeners.delete(cb);
        window.removeEventListener("storage", onStorage);
      };
    },
    readMapPipelineFlag,
    () => "legacy",
  );
}
