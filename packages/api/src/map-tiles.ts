/**
 * Slippy-map tile renderer for OCAD maps.
 *
 * Two Fastify routes are exposed (registered via `registerMapTileRoutes`):
 *
 *   GET /api/map-tile/:nameId/:z/:x/:y
 *     Returns a 256×512 PNG tile for the event identified by `nameId`
 *     (the URL slug, matching `Event.nameId`). Top half = opaque full
 *     composite; bottom half = transparent ink layer (colours above
 *     lower purple). The viewer slices the halves so course purple can
 *     sit between them. Tiles are cached in `map_tiles`; a miss renders
 *     the block of tiles around the request and writes them all back.
 *
 *   GET /api/map-tile-progress
 *     Pre-cache progress for the event identified by the
 *     `x-competition-id` header, polled by the frontend during the
 *     "Generating tiles…" overlay. Both numbers come from the database
 *     (expected count from the map's WGS84 bounds, done from a row
 *     count), so any instance answers identically.
 *
 * Rendering works a *window* at a time. For a missing tile the renderer
 * takes the block of `blockTiles`² tiles it belongs to, rasterises just
 * the region those tiles cover — as a viewBox sub-rectangle of the map
 * SVG (see map-window.ts) — at a density derived from the tiles
 * themselves, then warps each tile out of that window. Two consequences
 * matter:
 *
 *   - Deep zoom stays sharp. The window is rendered denser than its
 *     tiles (`supersample`), so the sampler never reads a source coarser
 *     than its output. The previous design rasterised the entire map once
 *     at a fixed budget and resampled every tile from it, which went soft
 *     at high zoom on large maps and had to be starved further to fit a
 *     memory-capped container.
 *   - Any instance can render any tile of any event in a few hundred MB,
 *     so nothing forces a single process (see map-render-limits.ts).
 *
 * Tiles are rotated quads in OCAD space (projection convergence plus the
 * map's grivation), hence the bilinear warp rather than a straight crop.
 * Sampling happens at pixel centres (`u, v ∈ [(0.5)/N, (N-0.5)/N]`) so
 * adjacent tiles share their edge samples exactly and no hairline seam
 * appears between them.
 */

import type { FastifyInstance } from "fastify";
import { prisma, onMapUpload } from "./db.js";
import { assertRestAccess } from "./restGuard.js";
import {
  ocadBoundsToWgs84,
  tileBoundsWgs84,
  wgs84ToOcad,
  withGrivationCorrection,
  type OcadCrs,
  type WGS84Bounds,
} from "./map-projection.js";
import {
  blockOrigin,
  blockRange,
  boundsOfPoints,
  clampDensity,
  expectedTileCount,
  missingBlocks,
  parseViewBox,
  quadDensity,
  tileRangeForBounds,
  windowPixelSize,
  windowViewBox,
  withViewBox,
  type OcadQuad,
  type OcadRect,
  type ViewBox,
} from "./map-window.js";
import {
  Semaphore,
  blockTiles,
  evictForInsert,
  precacheBlockDelayMs,
  precacheEnabled,
  precacheMaxZoom,
  precacheMinZoom,
  renderConcurrency,
  supersample,
  svgCacheEvents,
  windowMaxPixels,
} from "./map-render-limits.js";
import {
  applyIofColorStack,
  filterNorthLineObjects,
  inkToColor,
  type StackOcadFile,
} from "./map-color-stack.js";
import { ensureEventMapRenderKey } from "./map-render-cache.js";
import type { ColorProfile, ColorStackOverrides } from "@oxygen/shared";

const TILE_SIZE = 256;

/**
 * Bumped when the on-wire tile format changes so browsers' week-long
 * cache cannot feed an old 256×256 PNG into the stacked-tile slicer.
 * Folded into `computeRenderKey` and the client `?f=` query.
 */
export const TILE_FORMAT = 2;

/** The parsed map: SVG documents plus the georeferencing to place them. */
interface MapSource {
  /** Opaque full composite (all colours after IOF stack rewrite). */
  svg: string;
  /** Transparent ink layer, or null when nothing sits above lower purple. */
  svgInk: string | null;
  rootViewBox: ViewBox;
  crs: OcadCrs;
  ocadBounds: number[];
  mapWgs84: WGS84Bounds;
  /** Content-keyed cache identity for this parse. */
  renderKey: string;
}

/** A rasterised region of the map, in OCAD coordinates. */
interface RenderedWindow {
  pixels: Buffer;
  width: number;
  height: number;
  rect: OcadRect;
  /** Achieved pixels per OCAD unit — read back from the raster, not assumed. */
  densityX: number;
  densityY: number;
}

// Per-renderKey parsed SVG (a few MB each).
const svgCache = new Map<string, MapSource>();
const svgLoadInFlight = new Map<string, Promise<MapSource>>();
// De-dupes concurrent renders of the same block: a viewport fetches ~20
// tiles at once, which is one or two blocks.
const blockInFlight = new Map<string, Promise<Map<string, Buffer>>>();

/**
 * 1×1 fully transparent PNG — returned for empty / out-of-map tiles
 * (was 204). RGBA(0,0,0,0); the previous constant here accidentally
 * encoded RGBA(255,0,0,127) and painted red bands around every map
 * (see docs/bugfix-red-empty-tiles.md). The integration test decodes
 * the pixel to keep this honest.
 */
const TRANSPARENT_TILE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=",
  "base64",
);

let renderGate: Semaphore | null = null;
function gate(): Semaphore {
  renderGate ??= new Semaphore(renderConcurrency());
  return renderGate;
}

/** Drop in-process caches for a render key (profile/rotation change). */
export function invalidateRenderKey(renderKey: string): void {
  svgCache.delete(renderKey);
  svgLoadInFlight.delete(renderKey);
  preCacheConsidered.delete(renderKey);
  for (const key of [...blockInFlight.keys()]) {
    if (key.startsWith(`${renderKey}:`)) blockInFlight.delete(key);
  }
}

/** Drop in-process caches for an event (map upload / replace). */
function invalidateEvent(eventId: bigint): void {
  // We don't know the old render key cheaply; clear entries that match
  // any currently-cached source for this event by wiping nothing event-
  // scoped. Upload paths call gcOrphanTiles + ensureEventMapRenderKey
  // which yields a fresh key; any stale svgCache entry for the old key
  // is orphaned and evicted by size. Also drop preCacheConsidered entries
  // wholesale when the map changes — cheapest correct approach.
  preCacheConsidered.clear();
  // Drop every svg cache entry: uploads are rare and the SVG is rebuilt
  // on the next tile miss. Safer than leaving a stale ink layer.
  svgCache.clear();
  svgLoadInFlight.clear();
  blockInFlight.clear();
  void eventId;
}

async function resolveEventId(nameId: string): Promise<bigint | null> {
  if (!nameId) return null;
  const row = await prisma().event.findUnique({
    where: { nameId },
    select: { id: true },
  });
  return row?.id ?? null;
}

const tileKey = (z: number, x: number, y: number) => `${z}/${x}/${y}`;

// ─── Map source ─────────────────────────────────────────────

/**
 * The parsed SVG for an event's current map, keyed by renderKey.
 */
async function getMapSource(eventId: bigint): Promise<MapSource> {
  const meta = await ensureEventMapRenderKey(prisma(), eventId);
  if (!meta) throw new Error("No map file uploaded");
  const { renderKey } = meta;

  const cached = svgCache.get(renderKey);
  if (cached) return cached;

  const inFlight = svgLoadInFlight.get(renderKey);
  if (inFlight) return inFlight;

  const promise = loadMapSource(eventId, meta);
  svgLoadInFlight.set(renderKey, promise);
  try {
    const source = await promise;
    evictForInsert(svgCache, svgCacheEvents());
    svgCache.set(renderKey, source);
    return source;
  } finally {
    svgLoadInFlight.delete(renderKey);
  }
}

async function loadMapSource(
  eventId: bigint,
  meta: {
    renderKey: string;
    rotationCorrection: number;
    colorProfile: ColorProfile;
    colorOverrides: ColorStackOverrides;
    northLinesBelow: boolean;
    scale: number | null;
  },
): Promise<MapSource> {
  const row = await prisma().mapFile.findFirst({
    where: { eventId },
    orderBy: { id: "desc" },
    select: { fileData: true, rotationCorrection: true },
  });
  if (!row) throw new Error("No map file uploaded");

  // Lazy-load OCAD + JSDOM so the dependencies don't add to API
  // cold-start latency for events that never look at a map.
  const ocadMod = await import("ocad2geojson");
  const readOcad = (ocadMod as Record<string, unknown>).readOcad as (
    buf: Buffer,
    opts?: Record<string, unknown>,
  ) => Promise<
    StackOcadFile & {
      objects?: Array<{ sym?: number }>;
      getCrs(): OcadCrs;
      getBounds(): number[];
    }
  >;
  const ocadToSvg = (ocadMod as Record<string, unknown>).ocadToSvg as (
    file: unknown,
    opts: Record<string, unknown>,
  ) => { outerHTML: string };

  const jsdomMod = await import("jsdom");
  const dom = new jsdomMod.JSDOM("<!DOCTYPE html><html><body></body></html>");

  const ocadFile = await readOcad(Buffer.from(row.fileData), {
    quietWarnings: true,
  });
  const stack = applyIofColorStack(ocadFile, {
    profile: meta.colorProfile,
    overrides: meta.colorOverrides,
    scale: meta.scale,
  });
  if (stack.warnings.length > 0) {
    console.warn(
      `[map-color-stack] event ${eventId}: ${stack.warnings.join("; ")}`,
    );
  }
  const inkTo = inkToColor(stack);

  const svg = ocadToSvg(ocadFile, {
    document: dom.window.document,
    generateSymbolElements: true,
    exportHidden: false,
  }).outerHTML;

  const inkObjects = meta.northLinesBelow
    ? filterNorthLineObjects(ocadFile.objects)
    : ocadFile.objects;
  const svgInk =
    inkTo == null
      ? null
      : ocadToSvg(ocadFile, {
          document: dom.window.document,
          generateSymbolElements: true,
          exportHidden: false,
          toColor: inkTo,
          fill: "transparent",
          ...(inkObjects ? { objects: inkObjects } : {}),
        }).outerHTML;

  // Apply the same north/grivation correction used when deriving
  // bounds / northOffset so tiles warp into true-north mercator.
  const crs = withGrivationCorrection(
    ocadFile.getCrs(),
    meta.rotationCorrection,
  );
  const ocadBounds = ocadFile.getBounds();
  const mapWgs84 = ocadBoundsToWgs84(ocadBounds, crs);
  if (!mapWgs84) throw new Error("Map has no usable georeference");

  const rootViewBox = parseViewBox(svg);
  if (!rootViewBox) throw new Error("Map SVG has no root viewBox");

  return {
    svg,
    svgInk,
    rootViewBox,
    crs,
    ocadBounds,
    mapWgs84,
    renderKey: meta.renderKey,
  };
}

// ─── Geometry ───────────────────────────────────────────────

/** The tile's four corners in OCAD coordinates, or null outside the map. */
function tileQuad(
  z: number,
  x: number,
  y: number,
  source: MapSource,
): OcadQuad | null {
  const t = tileBoundsWgs84(z, x, y);
  const m = source.mapWgs84;
  if (t.west > m.east || t.east < m.west || t.south > m.north || t.north < m.south) {
    return null;
  }
  const nw = wgs84ToOcad(t.north, t.west, source.crs);
  const ne = wgs84ToOcad(t.north, t.east, source.crs);
  const sw = wgs84ToOcad(t.south, t.west, source.crs);
  const se = wgs84ToOcad(t.south, t.east, source.crs);
  if (!nw || !ne || !sw || !se) return null;
  return { nw, ne, sw, se };
}

// ─── Rendering ──────────────────────────────────────────────

/**
 * Rasterise `rect` out of an SVG at `density` pixels per OCAD unit.
 * The density that comes back is measured from the produced image rather
 * than assumed, so the sampler is immune to the rasteriser's rounding.
 */
async function rasterise(
  svg: string,
  rootViewBox: ViewBox,
  ocadBounds: number[],
  rect: OcadRect,
  density: number,
  transparent: boolean,
): Promise<RenderedWindow | null> {
  const viewBox = windowViewBox(rootViewBox, ocadBounds, rect);
  if (!viewBox) {
    // The generator's root viewBox no longer spans the OCAD bounds, so the
    // window placement can't be trusted. Fail loudly instead of silently
    // serving tiles from the wrong part of the map.
    throw new Error(
      "Map SVG viewBox does not span the OCAD bounds; windowed rendering cannot place the window",
    );
  }

  const size = windowPixelSize(rect, density);
  const resvgMod = await import("@resvg/resvg-js");
  // renderAsync, not Resvg#render: rasterising runs on the libuv thread
  // pool instead of blocking the event loop. The renderer is called far
  // more often than the whole-map version it replaced — once per block
  // per zoom rather than once per map — so a synchronous render stalls
  // every other request in the process while tiles are being produced.
  const rendered = await resvgMod.renderAsync(withViewBox(svg, viewBox), {
    fitTo: { mode: "width" as const, value: size.width },
    ...(transparent ? {} : { background: "white" }),
  });

  if (rendered.width === 0 || rendered.height === 0) return null;
  return {
    pixels: Buffer.from(rendered.pixels),
    width: rendered.width,
    height: rendered.height,
    rect,
    densityX: rendered.width / (rect.maxX - rect.minX),
    densityY: rendered.height / (rect.maxY - rect.minY),
  };
}

/**
 * Warp one tile out of a rendered window with bilinear sampling.
 * When `premultiply` is true (transparent ink layer), samples in
 * premultiplied space so edges against transparent pixels do not
 * darken, then un-premultiplies. Returns a TILE_SIZE² RGBA buffer, or
 * null when the tile has no content at all.
 */
function sampleTileRgba(
  quad: OcadQuad,
  win: RenderedWindow,
  premultiply: boolean,
): Buffer | null {
  const toPx = (p: { x: number; y: number }) => ({
    bx: (p.x - win.rect.minX) * win.densityX,
    by: (win.rect.maxY - p.y) * win.densityY,
  });
  const nwPx = toPx(quad.nw);
  const nePx = toPx(quad.ne);
  const swPx = toPx(quad.sw);
  const sePx = toPx(quad.se);

  const out = Buffer.alloc(TILE_SIZE * TILE_SIZE * 4);
  let hasContent = false;

  for (let ty = 0; ty < TILE_SIZE; ty++) {
    const v = (ty + 0.5) / TILE_SIZE;
    const leftBx = nwPx.bx + (swPx.bx - nwPx.bx) * v;
    const leftBy = nwPx.by + (swPx.by - nwPx.by) * v;
    const rightBx = nePx.bx + (sePx.bx - nePx.bx) * v;
    const rightBy = nePx.by + (sePx.by - nePx.by) * v;

    for (let tx = 0; tx < TILE_SIZE; tx++) {
      const u = (tx + 0.5) / TILE_SIZE;
      const srcX = leftBx + (rightBx - leftBx) * u;
      const srcY = leftBy + (rightBy - leftBy) * u;

      const x0 = Math.floor(srcX);
      const y0 = Math.floor(srcY);
      if (x0 < 0 || y0 < 0 || x0 + 1 >= win.width || y0 + 1 >= win.height) continue;

      const fx = srcX - x0;
      const fy = srcY - y0;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      const i00 = (y0 * win.width + x0) * 4;
      const i10 = (y0 * win.width + (x0 + 1)) * 4;
      const i01 = ((y0 + 1) * win.width + x0) * 4;
      const i11 = ((y0 + 1) * win.width + (x0 + 1)) * 4;

      const dstOff = (ty * TILE_SIZE + tx) * 4;
      if (premultiply) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        const add = (i: number, w: number) => {
          const aa = win.pixels[i + 3] / 255;
          r += win.pixels[i] * aa * w;
          g += win.pixels[i + 1] * aa * w;
          b += win.pixels[i + 2] * aa * w;
          a += aa * w;
        };
        add(i00, w00);
        add(i10, w10);
        add(i01, w01);
        add(i11, w11);
        if (a > 0) {
          out[dstOff] = Math.round(r / a);
          out[dstOff + 1] = Math.round(g / a);
          out[dstOff + 2] = Math.round(b / a);
          out[dstOff + 3] = Math.round(a * 255);
          hasContent = true;
        }
      } else {
        for (let ch = 0; ch < 4; ch++) {
          out[dstOff + ch] = Math.round(
            win.pixels[i00 + ch] * w00 +
              win.pixels[i10 + ch] * w10 +
              win.pixels[i01 + ch] * w01 +
              win.pixels[i11 + ch] * w11,
          );
        }
        if (out[dstOff + 3] > 0) hasContent = true;
      }
    }
  }

  return hasContent ? out : null;
}

/** Pack composite (top) + ink (bottom) into one 256×512 PNG. */
async function packStackedTile(
  composite: Buffer,
  ink: Buffer | null,
): Promise<Buffer> {
  const stacked = Buffer.alloc(TILE_SIZE * TILE_SIZE * 2 * 4);
  composite.copy(stacked, 0);
  if (ink) ink.copy(stacked, TILE_SIZE * TILE_SIZE * 4);
  const sharpMod = await import("sharp");
  return sharpMod
    .default(stacked, {
      raw: { width: TILE_SIZE, height: TILE_SIZE * 2, channels: 4 },
    })
    .png()
    .toBuffer();
}

/**
 * Render every tile of one aligned block and persist them. Returns the
 * stacked PNGs keyed by `z/x/y`; tiles that fall outside the map are absent.
 */
async function renderBlockUncached(
  source: MapSource,
  z: number,
  bx: number,
  by: number,
  size: number,
  background: boolean,
): Promise<Map<string, Buffer>> {
  const quads = new Map<string, OcadQuad>();
  for (let x = bx; x < bx + size; x++) {
    for (let y = by; y < by + size; y++) {
      const quad = tileQuad(z, x, y, source);
      if (quad) quads.set(tileKey(z, x, y), quad);
    }
  }
  const result = new Map<string, Buffer>();
  if (quads.size === 0) return result;

  // Density comes from a single tile: every tile at a zoom level spans
  // very nearly the same ground distance, and using one keeps the figure
  // independent of how much of the block the map actually covers.
  const first = quads.values().next().value as OcadQuad;
  const tileDensity = quadDensity(first, TILE_SIZE, TILE_SIZE);
  if (tileDensity <= 0) return result;
  const wanted = tileDensity * supersample();

  // A margin of two source pixels keeps bilinear sampling of edge pixels
  // inside the window instead of clipping against its border.
  const corners = [...quads.values()].flatMap((q) => [q.nw, q.ne, q.sw, q.se]);
  const rect = boundsOfPoints(corners, 2 / wanted);
  const density = clampDensity(rect, wanted, windowMaxPixels());

  const win = await gate().run(
    () =>
      rasterise(
        source.svg,
        source.rootViewBox,
        source.ocadBounds,
        rect,
        density,
        false,
      ),
    { background },
  );
  if (!win) return result;

  let inkWin: RenderedWindow | null = null;
  if (source.svgInk) {
    inkWin = await gate().run(
      () =>
        rasterise(
          source.svgInk!,
          source.rootViewBox,
          source.ocadBounds,
          rect,
          density,
          true,
        ),
      { background },
    );
  }

  for (const [key, quad] of quads) {
    const composite = sampleTileRgba(quad, win, false);
    if (!composite) continue;
    const ink = inkWin ? sampleTileRgba(quad, inkWin, true) : null;
    result.set(key, await packStackedTile(composite, ink));
  }

  await persistTiles(source.renderKey, result);
  return result;
}

/** Render a block, joining an in-flight render of the same block. */
async function renderBlock(
  source: MapSource,
  z: number,
  x: number,
  y: number,
  background = false,
): Promise<Map<string, Buffer>> {
  const size = blockTiles();
  const bx = blockOrigin(x, size);
  const by = blockOrigin(y, size);
  const key = `${source.renderKey}:${z}:${bx}:${by}`;

  const inFlight = blockInFlight.get(key);
  if (inFlight) return inFlight;

  const promise = renderBlockUncached(source, z, bx, by, size, background);
  blockInFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    blockInFlight.delete(key);
  }
}

/**
 * Write tiles to the cache. `ON CONFLICT DO NOTHING` because another
 * instance (or the background pre-cache) may have rendered the same block
 * concurrently — the rows are identical either way.
 */
async function persistTiles(
  renderKey: string,
  tiles: Map<string, Buffer>,
): Promise<void> {
  if (tiles.size === 0) return;
  const values: unknown[] = [];
  const rows: string[] = [];
  let i = 1;
  for (const [key, png] of tiles) {
    const [z, x, y] = key.split("/").map(Number);
    rows.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++})`);
    values.push(renderKey, z, x, y, png);
  }
  try {
    await prisma().$executeRawUnsafe(
      `INSERT INTO oxygen.map_tiles (render_key, z, x, y, tile_data)
       VALUES ${rows.join(", ")}
       ON CONFLICT (render_key, z, x, y) DO NOTHING`,
      ...values,
    );
  } catch (err) {
    // A closed pool (test teardown, shutdown) must not fail the request:
    // the tiles were rendered and are being served, only caching is lost.
    console.warn("[map-tiles] tile cache write failed:", err);
  }
}

/**
 * Fill `map_tiles` for the pre-cache zoom span in the background, so the
 * first view after an upload is instant. Zoom levels whose tiles are all
 * present are skipped, so a restart resumes rather than redoing work,
 * and the loop bails out entirely once the database stops accepting
 * writes (shutdown, test teardown).
 *
 * Deliberately unhurried: it pauses between blocks so that foreground
 * tile requests — and everything else sharing the process — keep their
 * latency. Deep zooms are left out of the span entirely; see
 * PRECACHE_MAX_ZOOM.
 */
async function preCacheTiles(source: MapSource): Promise<void> {
  const db = prisma();
  const size = blockTiles();
  const delayMs = precacheBlockDelayMs();
  const maxZoom = precacheMaxZoom();
  const renderKey = source.renderKey;

  for (let z = precacheMinZoom(); z <= maxZoom; z++) {
    const range = tileRangeForBounds(source.mapWgs84, z);
    const expected = (range.x1 - range.x0 + 1) * (range.y1 - range.y0 + 1);
    const have = await db.mapTile.count({ where: { renderKey, z } });
    if (have >= expected) continue;

    for (const bx of blockRange(range.x0, range.x1, size)) {
      for (const by of blockRange(range.y0, range.y1, size)) {
        try {
          await renderBlock(source, z, bx, by, true);
        } catch (err) {
          const msg = String((err as Error)?.message ?? "");
          if (
            msg.includes("Response from the Engine was empty") ||
            msg.includes("Engine is not yet connected")
          ) {
            return;
          }
          console.error(
            `[map-tiles] precache failed at z=${z} block=${bx},${by}:`,
            err,
          );
        }
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }
  }
}

/**
 * How many blocks one work-stealing chunk renders. Two is enough to
 * make visible progress between 2 s polls without holding the progress
 * response open long enough for the client to time out.
 */
const CHUNK_BLOCKS = 2;

/** Serialises work-stealing chunks so overlapping polls don't pile up. */
const chunkInFlight = new Set<string>();

/**
 * Render up to `CHUNK_BLOCKS` still-missing blocks, inline.
 *
 * Cloud Run throttles CPU to near zero outside request handling, so the
 * detached `preCacheTiles` loop crawls once the burst of tile requests
 * that started it dies down — exactly the situation right after an
 * upload, when there is nothing left to request. Doing a bounded slice
 * of the same work *inside* the progress request puts it back on the
 * clock: each poll buys a couple of blocks, and a client sitting on the
 * "Generating tiles…" overlay drives the map to completion by itself.
 *
 * Returns the number of tiles written so the caller can fold them into
 * the progress figures it already read.
 */
async function preCacheChunk(eventId: bigint): Promise<number> {
  const meta = await ensureEventMapRenderKey(prisma(), eventId);
  if (!meta || !precacheEnabled() || chunkInFlight.has(meta.renderKey)) return 0;
  const { renderKey } = meta;
  chunkInFlight.add(renderKey);
  try {
    const bounds = parseBounds(meta.bounds);
    if (!bounds) return 0;

    const db = prisma();
    const size = blockTiles();
    const maxZoom = precacheMaxZoom();
    let written = 0;

    for (let z = precacheMinZoom(); z <= maxZoom; z++) {
      const range = tileRangeForBounds(bounds, z);
      const expected =
        (range.x1 - range.x0 + 1) * (range.y1 - range.y0 + 1);
      const have = await db.mapTile.count({ where: { renderKey, z } });
      if (have >= expected) continue;

      const rows = await db.mapTile.findMany({
        where: { renderKey, z },
        select: { x: true, y: true },
      });
      const present = new Set(rows.map((r) => `${r.x}/${r.y}`));
      const blocks = missingBlocks(range, size, present, CHUNK_BLOCKS);

      const source = await getMapSource(eventId);
      for (const { bx, by } of blocks) {
        try {
          const tiles = await renderBlock(source, z, bx, by, true);
          written += tiles.size;
        } catch (err) {
          console.error(
            `[map-tiles] chunk render failed at z=${z} block=${bx},${by}:`,
            err,
          );
        }
      }
      return written;
    }
    return written;
  } finally {
    chunkInFlight.delete(renderKey);
  }
}

// ─── Progress ───────────────────────────────────────────────

function parseBounds(raw: unknown): WGS84Bounds | null {
  const bounds = raw as WGS84Bounds | null;
  if (
    !bounds ||
    typeof bounds.north !== "number" ||
    typeof bounds.south !== "number" ||
    typeof bounds.east !== "number" ||
    typeof bounds.west !== "number"
  ) {
    return null;
  }
  return bounds;
}

/**
 * The map's WGS84 bounds as stored at upload. Reading them back beats
 * re-deriving them from the OCAD: it is one small query rather than a
 * parse, so the progress endpoint and the pre-cache check stay cheap.
 */
async function storedBounds(eventId: bigint): Promise<WGS84Bounds | null> {
  const meta = await ensureEventMapRenderKey(prisma(), eventId);
  return meta ? parseBounds(meta.bounds) : null;
}

/**
 * Pre-cache progress straight from the database. The denominator is a
 * function of the map's stored WGS84 bounds and the numerator is a row
 * count, so a request served by any instance reports the same figures —
 * unlike the in-process counter this replaced.
 */
async function tileProgress(
  eventId: bigint,
): Promise<{ total: number; done: number; rendering: boolean }> {
  const meta = await ensureEventMapRenderKey(prisma(), eventId);
  if (!meta) return { total: 0, done: 0, rendering: false };
  const bounds = parseBounds(meta.bounds);
  if (!bounds) return { total: 0, done: 0, rendering: false };

  const minZoom = precacheMinZoom();
  const maxZoom = precacheMaxZoom();
  const total = expectedTileCount(bounds, minZoom, maxZoom);
  const done = await prisma().mapTile.count({
    where: { renderKey: meta.renderKey, z: { gte: minZoom, lte: maxZoom } },
  });
  return { total, done: Math.min(done, total), rendering: done < total };
}

// ─── Routes ─────────────────────────────────────────────────

/**
 * Register the two `/api/map-tile*` Fastify routes and subscribe the
 * cache to `onMapUpload` invalidations. Call once during server boot.
 */
export function registerMapTileRoutes(server: FastifyInstance): void {
  onMapUpload(invalidateEvent);

  // Progress endpoint — polled by the frontend during the
  // "Generating tiles…" overlay. The event is identified by the
  // `x-competition-id` header so the call doesn't have to re-mint a
  // URL on every poll.
  //
  // The poll doubles as the pre-cache's engine: while rendering is
  // incomplete it renders a bounded chunk before answering (see
  // `preCacheChunk`), because a throttled Cloud Run instance gives the
  // detached background loop almost no CPU between requests.
  server.get("/api/map-tile-progress", async (req, reply) => {
    const rawDbName = req.headers["x-competition-id"];
    const nameId =
      (Array.isArray(rawDbName) ? rawDbName[0] : rawDbName) ?? "";
    if (nameId && !(await assertRestAccess(req, reply, { nameId, cap: "courses.view", allowKiosk: true }))) {
      return;
    }
    const eventId = await resolveEventId(nameId);
    if (eventId === null) {
      return reply.send({ total: 0, done: 0, rendering: false });
    }
    const progress = await tileProgress(eventId);
    if (!progress.rendering) return reply.send(progress);

    await preCacheChunk(eventId);
    return reply.send(await tileProgress(eventId));
  });

  server.get<{
    Params: { nameId: string; z: string; x: string; y: string };
  }>(
    "/api/map-tile/:nameId/:z/:x/:y",
    async (req, reply) => {
      const z = parseInt(req.params.z, 10);
      const x = parseInt(req.params.x, 10);
      const y = parseInt(req.params.y, 10);
      const nameId = req.params.nameId;

      if (
        !Number.isFinite(z) ||
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        !nameId
      ) {
        return reply.code(400).send({ error: "Invalid tile request" });
      }

      if (!(await assertRestAccess(req, reply, { nameId, cap: "courses.view", allowKiosk: true }))) {
        return;
      }

      const eventId = await resolveEventId(nameId);
      if (eventId === null) {
        return reply.code(404).send({ error: "Unknown event" });
      }

      const meta = await ensureEventMapRenderKey(prisma(), eventId);
      if (!meta) {
        return reply.code(404).send({ error: "No map file uploaded" });
      }

      const cached = await prisma().mapTile.findUnique({
        where: {
          renderKey_z_x_y: { renderKey: meta.renderKey, z, x, y },
        },
        select: { tileData: true },
      });
      if (cached) {
        kickOffPreCache(eventId);
        return reply
          .header("Content-Type", "image/png")
          .header("Cache-Control", "public, max-age=604800")
          .send(Buffer.from(cached.tileData));
      }

      try {
        const source = await getMapSource(eventId);
        const rendered = await renderBlock(source, z, x, y);
        const png = rendered.get(tileKey(z, x, y));
        if (!png) {
          // Outside the map, or an empty tile — return a transparent PNG
          // (not 204) so the client's <img>/fetch path treats it as a
          // normal load. Caching the answer for a week keeps browsers
          // from re-asking.
          return reply
            .header("Content-Type", "image/png")
            .header("Cache-Control", "public, max-age=604800")
            .send(TRANSPARENT_TILE_PNG);
        }

        // Fill the overview zooms in the background so the next viewer's
        // first paint is instant.
        kickOffPreCache(eventId);

        return reply
          .header("Content-Type", "image/png")
          .header("Cache-Control", "public, max-age=604800")
          .send(png);
      } catch (err) {
        server.log.error({ err }, "Failed to render map tile");
        return reply.code(500).send({ error: "Failed to render tile" });
      }
    },
  );
}

/**
 * Render keys this process has already considered for pre-caching,
 * whether or not it went on to render anything. Requests arrive in
 * viewport-sized bursts, so without this the completeness check below
 * would run twenty times over.
 */
const preCacheConsidered = new Set<string>();

/**
 * Start the background pre-cache if this event's render key still needs it.
 */
async function maybePreCache(eventId: bigint): Promise<void> {
  if (!precacheEnabled()) return;
  const meta = await ensureEventMapRenderKey(prisma(), eventId);
  if (!meta) return;
  if (preCacheConsidered.has(meta.renderKey)) return;
  preCacheConsidered.add(meta.renderKey);

  const bounds = parseBounds(meta.bounds);
  if (!bounds) return;

  const minZoom = precacheMinZoom();
  const maxZoom = precacheMaxZoom();
  const done = await prisma().mapTile.count({
    where: {
      renderKey: meta.renderKey,
      z: { gte: minZoom, lte: maxZoom },
    },
  });
  if (done >= expectedTileCount(bounds, minZoom, maxZoom)) return;

  const source = await getMapSource(eventId);
  await preCacheTiles(source);
}

function kickOffPreCache(eventId: bigint): void {
  void maybePreCache(eventId).catch((err) =>
    console.error("[map-tiles] pre-cache failed:", err),
  );
}
