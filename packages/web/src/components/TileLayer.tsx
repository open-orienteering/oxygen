/**
 * Lightweight slippy-map tile renderer with smooth zoom transitions.
 *
 * Renders absolutely-positioned 256×256 PNG tiles from the server's
 * /api/map-tile/:z/:x/:y endpoint. Supports fractional zoom via CSS scaling.
 *
 * To prevent flickering during zoom transitions, tiles from the previous
 * integer zoom level are kept visible underneath until all new tiles load.
 */

import { useState, useMemo, useRef, useCallback } from "react";
import type { TileViewport } from "../lib/geo-utils";
import { lngToTileX, latToTileY } from "../lib/geo-utils";

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
}

function computeTiles(
  viewport: TileViewport,
  z: number,
  containerWidth: number,
  containerHeight: number,
  tileUrlBase: string,
  tileVersion: number | undefined,
  failedTiles: Set<string>,
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

      const key = `${z}/${wrappedX}/${ty}`;
      if (failedTiles.has(key)) continue;

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

      result.push({
        key,
        src: `${tileUrlBase}/${z}/${wrappedX}/${ty}${tileVersion ? `?v=${tileVersion}` : ""}`,
        x: left,
        y: top,
        width,
        height,
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
  const failedTiles = useRef(new Set<string>());
  const [loadedKeys, setLoadedKeys] = useState(new Set<string>());

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
    () => computeTiles(viewport, z, containerWidth, containerHeight, tileUrlBase, tileVersion, failedTiles.current),
    [viewport, z, containerWidth, containerHeight, tileUrlBase, tileVersion],
  );

  // Backdrop tiles from previous zoom — positioned for current viewport.
  // computeTiles handles the math: subZoomScale = 2^(viewport.zoom - backdropZ)
  // correctly positions old-zoom tiles at the current fractional zoom.
  const backdropTiles = useMemo(() => {
    if (backdropZ === null || backdropZ === z) return [];
    return computeTiles(viewport, backdropZ, containerWidth, containerHeight,
      tileUrlBase, tileVersion, failedTiles.current);
  }, [viewport, backdropZ, z, containerWidth, containerHeight, tileUrlBase, tileVersion]);

  const allCurrentLoaded = tiles.length > 0 && tiles.every(t => loadedKeys.has(t.key));

  // Once all current tiles are loaded, mark this zoom as loaded and clear backdrop
  if (allCurrentLoaded) {
    everLoadedZRef.current.add(z);
    if (backdropZ !== null && backdropZ !== z) {
      lastFullyLoadedZRef.current = z;
    }
  }

  const handleLoad = useCallback((key: string) => {
    setLoadedKeys(prev => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }, []);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        pointerEvents: "none",
        // Hide alt text and broken image icons for tiles that haven't loaded yet
        color: "transparent",
      }}
    >
      {/* Backdrop: previous zoom tiles — visible until all current tiles load */}
      {backdropTiles.map((tile) => (
        <img
          key={`bd-${tile.key}`}
          src={tile.src}
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
          onLoad={(e) => {
            const img = e.target as HTMLImageElement;
            if (img.naturalWidth === 0) { img.style.display = "none"; failedTiles.current.add(tile.key); }
            handleLoad(tile.key);
          }}
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = "none";
            failedTiles.current.add(tile.key);
            handleLoad(tile.key);
          }}
        />
      ))}
      {/* Current zoom tiles */}
      {tiles.map((tile) => (
        <img
          key={tile.key}
          src={tile.src}
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
          onLoad={(e) => {
            const img = e.target as HTMLImageElement;
            if (img.naturalWidth === 0) { img.style.display = "none"; failedTiles.current.add(tile.key); }
            handleLoad(tile.key);
          }}
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = "none";
            failedTiles.current.add(tile.key);
            handleLoad(tile.key);
          }}
        />
      ))}
    </div>
  );
}
