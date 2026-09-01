/**
 * Geometry for windowed map-tile rendering (see map-tiles.ts).
 *
 * Instead of rasterising a whole OCAD map into one bitmap and resampling
 * every tile from it, the renderer rasterises a *window* — the region a
 * small block of tiles covers — at the density those tiles actually need.
 * That keeps deep zoom sharp (the source is never coarser than the output)
 * and keeps peak memory proportional to a block rather than to the map.
 *
 * The window is expressed as a sub-rectangle of the SVG that ocad2geojson
 * emits. That SVG's root viewBox spans the OCAD bounds with the y axis
 * flipped (the generator negates y and translates by minY+maxY), so a
 * window is a plain viewBox rewrite — verified against the full-map render
 * in the spike that preceded this module.
 *
 * Tiles are rotated quads in OCAD space (projection convergence plus the
 * map's grivation), so a window covers the quad's axis-aligned bounding
 * box and the sampler in map-tiles.ts warps each tile out of it.
 */

import type { WGS84Bounds } from "./map-projection.js";

/**
 * Default zoom span the background pre-cache fills after a map upload.
 *
 * The ceiling is deliberately low. Tile counts quadruple per level — for
 * a typical sprint map, zooms 10-15 are 27 tiles while 16 and 17 add
 * another 198 — and since the windowed renderer produces a whole block
 * in a couple of hundred milliseconds, the deeper levels are cheaper to
 * render when someone actually zooms in than to render for everyone up
 * front. The pre-cache exists to make the *first view* instant, not to
 * materialise the whole pyramid.
 *
 * Overridable via `MAP_PRECACHE_MIN_ZOOM` / `MAP_PRECACHE_MAX_ZOOM`
 * (see map-render-limits.ts).
 */
export const PRECACHE_MIN_ZOOM = 10;
export const PRECACHE_MAX_ZOOM = 15;

export interface OcadPoint {
  x: number;
  y: number;
}

export interface OcadRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface OcadQuad {
  nw: OcadPoint;
  ne: OcadPoint;
  sw: OcadPoint;
  se: OcadPoint;
}

export interface ViewBox {
  minX: number;
  minY: number;
  width: number;
  height: number;
}

/**
 * Snap a tile index down to its block origin. Blocks sit on a global
 * lattice so requests for neighbouring tiles resolve to the same window
 * and render once instead of once per tile.
 */
export function blockOrigin(tileIndex: number, blockSize: number): number {
  return Math.floor(tileIndex / blockSize) * blockSize;
}

/** Block origins covering an inclusive tile span. */
export function blockRange(
  from: number,
  to: number,
  blockSize: number,
): number[] {
  const origins: number[] = [];
  for (
    let o = blockOrigin(from, blockSize);
    o <= blockOrigin(to, blockSize);
    o += blockSize
  ) {
    origins.push(o);
  }
  return origins;
}

export function boundsOfPoints(
  points: OcadPoint[],
  marginUnits = 0,
): OcadRect {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return {
    minX: Math.min(...xs) - marginUnits,
    minY: Math.min(...ys) - marginUnits,
    maxX: Math.max(...xs) + marginUnits,
    maxY: Math.max(...ys) + marginUnits,
  };
}

function distance(a: OcadPoint, b: OcadPoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Pixels per OCAD unit such that `outWidthPx` x `outHeightPx` output pixels
 * resolve the quad. Uses edge lengths rather than the bounding box so a
 * rotated block doesn't get rendered softer than an axis-aligned one, and
 * takes the denser of the two axes so neither direction is under-sampled.
 *
 * Returns 0 for a degenerate quad (all corners coincide), which callers
 * treat as "nothing to render here".
 */
export function quadDensity(
  quad: OcadQuad,
  outWidthPx: number,
  outHeightPx: number,
): number {
  const acrossUnits = Math.max(
    distance(quad.nw, quad.ne),
    distance(quad.sw, quad.se),
  );
  const downUnits = Math.max(
    distance(quad.nw, quad.sw),
    distance(quad.ne, quad.se),
  );
  if (acrossUnits <= 0 && downUnits <= 0) return 0;

  const densities: number[] = [];
  if (acrossUnits > 0) densities.push(outWidthPx / acrossUnits);
  if (downUnits > 0) densities.push(outHeightPx / downUnits);
  return Math.max(...densities);
}

/**
 * Reduce a density so the rendered window stays inside `maxPixels`. The
 * clamp is a backstop against a pathological projection producing an
 * enormous bounding box; in normal operation the requested density wins.
 */
export function clampDensity(
  rect: OcadRect,
  density: number,
  maxPixels: number,
): number {
  const wUnits = Math.max(rect.maxX - rect.minX, Number.EPSILON);
  const hUnits = Math.max(rect.maxY - rect.minY, Number.EPSILON);
  const pixels = wUnits * density * (hUnits * density);
  if (pixels <= maxPixels) return density;
  return Math.sqrt(maxPixels / (wUnits * hUnits));
}

export function windowPixelSize(
  rect: OcadRect,
  density: number,
): { width: number; height: number } {
  return {
    width: Math.max(1, Math.ceil((rect.maxX - rect.minX) * density)),
    height: Math.max(1, Math.ceil((rect.maxY - rect.minY) * density)),
  };
}

/**
 * The `viewBox` that renders `rect` out of the map SVG, or null if the
 * SVG's root viewBox doesn't span the OCAD bounds the way ocad2geojson
 * emits it. The null case is a guard: an upstream change to the generator
 * would otherwise shift every window silently, and the caller falls back
 * to rendering the whole map.
 */
export function windowViewBox(
  root: ViewBox,
  ocadBounds: number[],
  rect: OcadRect,
): string | null {
  const [bMinX, bMinY, bMaxX, bMaxY] = ocadBounds;
  const spansBounds =
    Math.abs(root.width - (bMaxX - bMinX)) <= 1 &&
    Math.abs(root.height - (bMaxY - bMinY)) <= 1;
  if (!spansBounds) return null;

  const x = root.minX + (rect.minX - bMinX);
  const y = root.minY + (bMaxY - rect.maxY);
  const width = rect.maxX - rect.minX;
  const height = rect.maxY - rect.minY;
  return `${x} ${y} ${width} ${height}`;
}

// ─── Slippy-tile math ───────────────────────────────────────

export function lonToTileX(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, z));
}

export function latToTileY(lat: number, z: number): number {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) *
      Math.pow(2, z),
  );
}

export interface TileRange {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** Inclusive tile range covering a WGS84 box at zoom `z`. */
export function tileRangeForBounds(b: WGS84Bounds, z: number): TileRange {
  return {
    x0: lonToTileX(b.west, z),
    x1: lonToTileX(b.east, z),
    y0: latToTileY(b.north, z),
    y1: latToTileY(b.south, z),
  };
}

/**
 * How many tiles the pre-cache will write for a map. Derived from the
 * map's WGS84 bounds alone, so any instance can compute the denominator
 * of the progress bar without holding render state.
 */
export function expectedTileCount(
  b: WGS84Bounds,
  minZoom = PRECACHE_MIN_ZOOM,
  maxZoom = PRECACHE_MAX_ZOOM,
): number {
  let total = 0;
  for (let z = minZoom; z <= maxZoom; z++) {
    const r = tileRangeForBounds(b, z);
    total += (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1);
  }
  return total;
}

/** Parse `viewBox="a b c d"` (space- or comma-separated) from an SVG root. */
export function parseViewBox(svg: string): ViewBox | null {
  const raw = /viewBox="([^"]+)"/.exec(svg)?.[1];
  if (!raw) return null;
  const parts = raw.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [minX, minY, width, height] = parts;
  return { minX, minY, width, height };
}

/** Replace the root `viewBox` of an SVG document string. */
export function withViewBox(svg: string, viewBox: string): string {
  const rootEnd = svg.indexOf(">");
  if (rootEnd < 0) return svg;
  const root = svg.slice(0, rootEnd + 1);
  return root.replace(/viewBox="[^"]*"/, `viewBox="${viewBox}"`) + svg.slice(rootEnd + 1);
}
