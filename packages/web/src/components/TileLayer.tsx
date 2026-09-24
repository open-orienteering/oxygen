/**
 * Lightweight slippy-map tile renderer with smooth zoom transitions.
 *
 * Fetches tiles via a concurrency-capped queue (not bare `<img src>`) so
 * large maps do not storm Cloud Run into 429s, and so failed tiles are
 * retried with backoff instead of being blacklisted forever.
 *
 * Tiles are 256×512 PNGs (composite top, ink bottom). `half` selects
 * which half to display; two TileLayers sharing a `TileBlobCacheProvider`
 * fetch each stacked PNG once.
 */

import {
  createContext,
  useState,
  useMemo,
  useRef,
  useEffect,
  useCallback,
  useContext,
  type MutableRefObject,
  type ReactNode,
} from "react";
import type { TileViewport } from "../lib/geo-utils";
import { lngToTileX, latToTileY } from "../lib/geo-utils";
import { kioskKeyFromUrl, tileQueryString } from "../lib/kiosk-key";
import { TileFetcher } from "../lib/tile-fetcher";
import { TileRetryBook } from "../lib/tile-retry";

interface Props {
  viewport: TileViewport;
  containerWidth: number;
  containerHeight: number;
  tileUrlBase?: string;
  /** Cache-busting version (e.g. map upload timestamp) */
  tileVersion?: number | string;
  /** Which half of the stacked 256×512 tile to show. Default "top". */
  half?: "top" | "bottom";
  /** Stacking order relative to sibling overlays. */
  zIndex?: number;
  /**
   * Render from the shared blob cache without fetching or cancelling.
   * Used by the placement loupe so it never fights the main map's queue.
   */
  passive?: boolean;
  /** Optional test id on the outer container. */
  "data-testid"?: string;
}

interface TileInfo {
  key: string;
  src: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Distance² from viewport centre in tile units — fetch priority. */
  priority: number;
}

interface TileBlobCache {
  blobUrls: Map<string, string>;
  blobUrlsRef: MutableRefObject<Map<string, string>>;
  publishBlob: (key: string, url: string) => void;
  dropBlob: (key: string) => void;
  fetcher: TileFetcher;
  retryBook: TileRetryBook;
  bump: () => void;
  tick: number;
}

const TileBlobCacheContext = createContext<TileBlobCache | null>(null);

/**
 * Share one fetch/blob cache across the composite and ink TileLayers so
 * each stacked PNG is requested once.
 */
export function TileBlobCacheProvider({ children }: { children: ReactNode }) {
  const fetcherRef = useRef<TileFetcher | null>(null);
  if (!fetcherRef.current) fetcherRef.current = new TileFetcher();
  const retryBookRef = useRef(new TileRetryBook());
  const blobUrlsRef = useRef(new Map<string, string>());
  const [blobUrls, setBlobUrls] = useState(new Map<string, string>());
  const [tick, setTick] = useState(0);

  const publishBlob = useCallback((key: string, url: string) => {
    const prev = blobUrlsRef.current.get(key);
    if (prev && prev !== url) URL.revokeObjectURL(prev);
    blobUrlsRef.current.set(key, url);
    setBlobUrls(new Map(blobUrlsRef.current));
  }, []);

  const dropBlob = useCallback((key: string) => {
    const prev = blobUrlsRef.current.get(key);
    if (prev) {
      URL.revokeObjectURL(prev);
      blobUrlsRef.current.delete(key);
      setBlobUrls(new Map(blobUrlsRef.current));
    }
  }, []);

  useEffect(() => {
    return () => {
      for (const url of blobUrlsRef.current.values()) URL.revokeObjectURL(url);
      blobUrlsRef.current.clear();
      fetcherRef.current?.cancelExcept(new Set());
    };
  }, []);

  const value = useMemo<TileBlobCache>(
    () => ({
      blobUrls,
      blobUrlsRef,
      publishBlob,
      dropBlob,
      fetcher: fetcherRef.current!,
      retryBook: retryBookRef.current,
      bump: () => setTick((n) => n + 1),
      tick,
    }),
    [blobUrls, publishBlob, dropBlob, tick],
  );

  return (
    <TileBlobCacheContext.Provider value={value}>
      {children}
    </TileBlobCacheContext.Provider>
  );
}

function useTileBlobCache(): TileBlobCache {
  const shared = useContext(TileBlobCacheContext);
  // Fallback for a lone TileLayer (e.g. tests) — private cache.
  const localFetcher = useRef<TileFetcher | null>(null);
  if (!localFetcher.current) localFetcher.current = new TileFetcher();
  const localRetry = useRef(new TileRetryBook());
  const localBlobs = useRef(new Map<string, string>());
  const [localUrls, setLocalUrls] = useState(new Map<string, string>());
  const [localTick, setLocalTick] = useState(0);
  const publishBlob = useCallback((key: string, url: string) => {
    const prev = localBlobs.current.get(key);
    if (prev && prev !== url) URL.revokeObjectURL(prev);
    localBlobs.current.set(key, url);
    setLocalUrls(new Map(localBlobs.current));
  }, []);
  const dropBlob = useCallback((key: string) => {
    const prev = localBlobs.current.get(key);
    if (prev) {
      URL.revokeObjectURL(prev);
      localBlobs.current.delete(key);
      setLocalUrls(new Map(localBlobs.current));
    }
  }, []);
  useEffect(() => {
    if (shared) return;
    return () => {
      for (const url of localBlobs.current.values()) URL.revokeObjectURL(url);
      localBlobs.current.clear();
      localFetcher.current?.cancelExcept(new Set());
    };
  }, [shared]);
  if (shared) return shared;
  return {
    blobUrls: localUrls,
    blobUrlsRef: localBlobs,
    publishBlob,
    dropBlob,
    fetcher: localFetcher.current,
    retryBook: localRetry.current,
    bump: () => setLocalTick((n) => n + 1),
    tick: localTick,
  };
}

/** Identity for React/load/error state; event and map version are significant. */
// eslint-disable-next-line react-refresh/only-export-components -- pure URL key helper co-located with the tile layer that uses it; only costs full-reload HMR for this file
export function tileRequestKey(
  tileUrlBase: string,
  query: string,
  z: number,
  x: number,
  y: number,
): string {
  return `${tileUrlBase}${query}|${z}/${x}/${y}`;
}

function computeTiles(
  viewport: TileViewport,
  z: number,
  containerWidth: number,
  containerHeight: number,
  tileUrlBase: string,
  query: string,
): TileInfo[] {
  if (containerWidth === 0 || containerHeight === 0) return [];

  const maxTile = Math.pow(2, z);
  const subZoomScale = Math.pow(2, viewport.zoom - z);
  const tileDisplaySize = 256 * subZoomScale;

  const centerTileX = lngToTileX(viewport.centerLng, z);
  const centerTileY = latToTileY(viewport.centerLat, z);

  const halfTilesX = Math.ceil(containerWidth / tileDisplaySize / 2) + 1;
  const halfTilesY = Math.ceil(containerHeight / tileDisplaySize / 2) + 1;

  const minTileX = Math.floor(centerTileX - halfTilesX);
  const maxTileX = Math.ceil(centerTileX + halfTilesX);
  const minTileY = Math.floor(centerTileY - halfTilesY);
  const maxTileY = Math.ceil(centerTileY + halfTilesY);

  const result: TileInfo[] = [];
  for (let tx = minTileX; tx <= maxTileX; tx++) {
    for (let ty = minTileY; ty <= maxTileY; ty++) {
      if (ty < 0 || ty >= maxTile) continue;
      const wrappedX = ((tx % maxTile) + maxTile) % maxTile;

      const key = tileRequestKey(tileUrlBase, query, z, wrappedX, ty);

      // Snap tile placement to integer pixel boundaries so adjacent tiles
      // share an exact pixel column/row. At fractional zoom levels both the
      // position and tileDisplaySize are non-integer, which causes the browser
      // to anti-alias each tile edge against the container background and
      // produces visible white hairlines between neighbouring tiles.
      // floor(left) + ceil(right) - floor(left) guarantees coverage with no
      // gaps and at most one pixel of overlap between neighbours.
      const x0 = (tx - centerTileX) * tileDisplaySize + containerWidth / 2;
      const y0 = (ty - centerTileY) * tileDisplaySize + containerHeight / 2;
      const left = Math.floor(x0);
      const top = Math.floor(y0);
      const width = Math.ceil(x0 + tileDisplaySize) - left;
      const height = Math.ceil(y0 + tileDisplaySize) - top;
      const priority =
        (tx + 0.5 - centerTileX) ** 2 + (ty + 0.5 - centerTileY) ** 2;

      result.push({
        key,
        src: `${tileUrlBase}/${z}/${wrappedX}/${ty}${query}`,
        x: left,
        y: top,
        width,
        height,
        priority,
      });
    }
  }
  return result;
}

function TileHalfImage({
  src,
  tileSrc,
  tile,
  half,
}: {
  src: string;
  tileSrc: string;
  tile: TileInfo;
  half: "top" | "bottom";
}) {
  // Stacked PNG is 256×512; show one half via overflow clip + offset.
  // The wrapper is tile.width × tile.height; the img is twice as tall so
  // half="bottom" shifts it up by one tile height.
  return (
    <div
      style={{
        position: "absolute",
        left: tile.x,
        top: tile.y,
        width: tile.width,
        height: tile.height,
        overflow: "hidden",
      }}
    >
      <img
        src={src}
        data-tile-url={tileSrc}
        data-tile-half={half}
        alt=""
        draggable={false}
        decoding="async"
        style={{
          position: "absolute",
          left: 0,
          top: half === "bottom" ? -tile.height : 0,
          width: tile.width,
          height: tile.height * 2,
          imageRendering: "auto",
        }}
      />
    </div>
  );
}

export function TileLayer({
  viewport,
  containerWidth,
  containerHeight,
  tileUrlBase = "/api/map-tile",
  tileVersion,
  half = "top",
  zIndex,
  passive = false,
  "data-testid": testId,
}: Props) {
  const cache = useTileBlobCache();
  const query = useMemo(
    () => tileQueryString(tileVersion, kioskKeyFromUrl()),
    [tileVersion],
  );

  const z = Math.ceil(viewport.zoom);

  // Track previous integer zoom for backdrop tiles.
  // Only use a backdrop from a zoom level where tiles actually loaded
  // (prevents blurry scaled-up tiles on initial fitBounds zoom jump).
  const prevZRef = useRef(z);
  const lastFullyLoadedZRef = useRef<number | null>(null);
  const everLoadedZRef = useRef(new Set<number>());

  // Detect zoom level change during render
  if (z !== prevZRef.current) {
    // Only use previous zoom as backdrop if tiles were actually loaded at that level
    if (everLoadedZRef.current.has(prevZRef.current)) {
      lastFullyLoadedZRef.current = prevZRef.current;
    }
    prevZRef.current = z;
  }

  const backdropZ = lastFullyLoadedZRef.current;

  // Current zoom tiles
  const tiles = useMemo(
    () =>
      computeTiles(
        viewport,
        z,
        containerWidth,
        containerHeight,
        tileUrlBase,
        query,
      ),
    // tick forces recompute when a retry window opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewport, z, containerWidth, containerHeight, tileUrlBase, query, cache.tick],
  );

  // Backdrop tiles from previous zoom — positioned for current viewport.
  // Only the composite (top) half uses a backdrop; ink on a backdrop
  // zoom would sit under purple inconsistently.
  const backdropTiles = useMemo(() => {
    if (half !== "top") return [];
    if (backdropZ === null || backdropZ === z) return [];
    return computeTiles(
      viewport,
      backdropZ,
      containerWidth,
      containerHeight,
      tileUrlBase,
      query,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    viewport,
    backdropZ,
    z,
    containerWidth,
    containerHeight,
    tileUrlBase,
    query,
    cache.tick,
    half,
  ]);

  // Fetch desired tiles; abort ones that left the viewport.
  // Only the top half drives fetching so the ink layer does not double
  // the queue when both share a cache. Passive layers skip entirely.
  useEffect(() => {
    if (passive) return;
    if (half !== "top" && cache) {
      // Ink layer: still need to fetch if used alone, but when shared the
      // top half owns the queue. Mirror desired keys so blobs stay warm.
    }
    const fetcher = cache.fetcher;
    const retryBook = cache.retryBook;
    const now = Date.now();
    const desired = new Map<string, TileInfo>();
    for (const t of [...tiles, ...backdropTiles]) desired.set(t.key, t);

    // Only cancel/fetch from the composite layer so two layers sharing a
    // cache do not fight over the queue.
    if (half !== "top") return;

    fetcher.cancelExcept(new Set(desired.keys()));

    for (const key of [...cache.blobUrlsRef.current.keys()]) {
      if (!desired.has(key)) cache.dropBlob(key);
    }

    const waitingKeys: string[] = [];
    for (const tile of desired.values()) {
      if (cache.blobUrlsRef.current.has(tile.key)) continue;
      const decision = retryBook.decision(tile.key, now);
      if (decision.action === "wait") {
        waitingKeys.push(tile.key);
        continue;
      }
      const failures = retryBook.failures(tile.key);
      const url =
        failures > 0
          ? `${tile.src}${tile.src.includes("?") ? "&" : "?"}r=${failures}`
          : tile.src;

      void fetcher
        .enqueue({ key: tile.key, url, priority: tile.priority })
        .then((result) => {
          if (result.ok) {
            retryBook.clear(tile.key);
            if (!cache.blobUrlsRef.current.has(tile.key)) {
              cache.publishBlob(tile.key, URL.createObjectURL(result.blob));
            }
            return;
          }
          if (result.aborted) return;
          retryBook.recordFailure(tile.key, Date.now(), {
            retryAfterHeader: result.retryAfter,
          });
          cache.bump();
        });
    }

    const nextAt = retryBook.earliestRetryAt(waitingKeys, now);
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (nextAt != null) {
      timer = setTimeout(() => cache.bump(), Math.max(0, nextAt - now));
    }
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [tiles, backdropTiles, cache, half, passive]);

  const allCurrentLoaded =
    tiles.length > 0 && tiles.every((t) => cache.blobUrls.has(t.key));

  // Once all current tiles are loaded, mark this zoom as loaded and clear backdrop
  if (half === "top" && allCurrentLoaded) {
    everLoadedZRef.current.add(z);
    if (backdropZ !== null && backdropZ !== z) {
      lastFullyLoadedZRef.current = z;
    }
  }

  return (
    <div
      data-testid={testId}
      data-tile-half={half}
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        pointerEvents: "none",
        color: "transparent",
        zIndex,
      }}
    >
      {backdropTiles.map((tile) => {
        const src = cache.blobUrls.get(tile.key);
        if (!src) return null;
        return (
          <TileHalfImage
            key={`bd-${tile.key}`}
            src={src}
            tileSrc={tile.src}
            tile={tile}
            half={half}
          />
        );
      })}
      {tiles.map((tile) => {
        const src = cache.blobUrls.get(tile.key);
        if (!src) return null;
        return (
          <TileHalfImage
            key={tile.key}
            src={src}
            tileSrc={tile.src}
            tile={tile}
            half={half}
          />
        );
      })}
    </div>
  );
}
