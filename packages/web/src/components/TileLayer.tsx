/**
 * Lightweight slippy-map tile renderer with smooth zoom transitions.
 *
 * Fetches tiles via a concurrency-capped queue (not bare `<img src>`) so
 * large maps do not storm Cloud Run into 429s, and so failed tiles are
 * retried with backoff instead of being blacklisted forever.
 */

import { useState, useMemo, useRef, useEffect, useCallback } from "react";
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
  tileVersion?: number;
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

export function TileLayer({
  viewport,
  containerWidth,
  containerHeight,
  tileUrlBase = "/api/map-tile",
  tileVersion,
}: Props) {
  const fetcherRef = useRef<TileFetcher | null>(null);
  if (!fetcherRef.current) fetcherRef.current = new TileFetcher();
  const retryBookRef = useRef(new TileRetryBook());
  const blobUrlsRef = useRef(new Map<string, string>());
  const [blobUrls, setBlobUrls] = useState(new Map<string, string>());
  const [tick, setTick] = useState(0);
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
    () => computeTiles(viewport, z, containerWidth, containerHeight, tileUrlBase, query),
    // tick forces recompute when a retry window opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewport, z, containerWidth, containerHeight, tileUrlBase, query, tick],
  );

  // Backdrop tiles from previous zoom — positioned for current viewport.
  const backdropTiles = useMemo(() => {
    if (backdropZ === null || backdropZ === z) return [];
    return computeTiles(viewport, backdropZ, containerWidth, containerHeight,
      tileUrlBase, query);
  }, [viewport, backdropZ, z, containerWidth, containerHeight, tileUrlBase, query, tick]);

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

  // Fetch desired tiles; abort ones that left the viewport.
  useEffect(() => {
    const fetcher = fetcherRef.current!;
    const retryBook = retryBookRef.current;
    const now = Date.now();
    const desired = new Map<string, TileInfo>();
    for (const t of [...tiles, ...backdropTiles]) desired.set(t.key, t);

    fetcher.cancelExcept(new Set(desired.keys()));

    // Drop blob URLs for tiles that are long gone (keep a small cache of
    // currently desired keys only — backdrop + current).
    for (const key of [...blobUrlsRef.current.keys()]) {
      if (!desired.has(key)) dropBlob(key);
    }

    const waitingKeys: string[] = [];
    for (const tile of desired.values()) {
      if (blobUrlsRef.current.has(tile.key)) continue;
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
            // Effect may have attached multiple .then handlers while the
            // same fetch was pending — only create one object URL.
            if (!blobUrlsRef.current.has(tile.key)) {
              publishBlob(tile.key, URL.createObjectURL(result.blob));
            }
            return;
          }
          if (result.aborted) return;
          retryBook.recordFailure(tile.key, Date.now(), {
            retryAfterHeader: result.retryAfter,
          });
          setTick((n) => n + 1);
        });
    }

    const nextAt = retryBook.earliestRetryAt(waitingKeys, now);
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (nextAt != null) {
      timer = setTimeout(() => setTick((n) => n + 1), Math.max(0, nextAt - now));
    }
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [tiles, backdropTiles, publishBlob, dropBlob]);

  // Revoke all blobs on unmount.
  useEffect(() => {
    return () => {
      for (const url of blobUrlsRef.current.values()) URL.revokeObjectURL(url);
      blobUrlsRef.current.clear();
      fetcherRef.current?.cancelExcept(new Set());
    };
  }, []);

  const allCurrentLoaded =
    tiles.length > 0 && tiles.every((t) => blobUrls.has(t.key));

  // Once all current tiles are loaded, mark this zoom as loaded and clear backdrop
  if (allCurrentLoaded) {
    everLoadedZRef.current.add(z);
    if (backdropZ !== null && backdropZ !== z) {
      lastFullyLoadedZRef.current = z;
    }
  }

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        pointerEvents: "none",
        color: "transparent",
      }}
    >
      {backdropTiles.map((tile) => {
        const src = blobUrls.get(tile.key);
        if (!src) return null;
        return (
          <img
            key={`bd-${tile.key}`}
            src={src}
            // Blob URLs hide which tile an <img> shows; expose the API URL
            // for tests and debugging.
            data-tile-url={tile.src}
            alt=""
            draggable={false}
            decoding="async"
            style={{
              position: "absolute",
              left: tile.x,
              top: tile.y,
              width: tile.width,
              height: tile.height,
              imageRendering: "auto",
            }}
          />
        );
      })}
      {tiles.map((tile) => {
        const src = blobUrls.get(tile.key);
        if (!src) return null;
        return (
          <img
            key={tile.key}
            src={src}
            data-tile-url={tile.src}
            alt=""
            draggable={false}
            decoding="async"
            style={{
              position: "absolute",
              left: tile.x,
              top: tile.y,
              width: tile.width,
              height: tile.height,
              imageRendering: "auto",
            }}
          />
        );
      })}
    </div>
  );
}
