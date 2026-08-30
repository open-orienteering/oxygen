/**
 * Slippy-map tile renderer for OCAD maps.
 *
 * Two Fastify routes are exposed (registered via `registerMapTileRoutes`):
 *
 *   GET /api/map-tile/:nameId/:z/:x/:y
 *     Returns a 256×256 PNG tile for the event identified by `nameId`
 *     (the URL slug, matching `Event.nameId`). Tiles are pre-rendered
 *     into `map_tiles` once a map upload lands; this endpoint serves
 *     cached tiles when available, and renders on-demand (writing back
 *     to the cache) on the first miss for a tile.
 *
 *   GET /api/map-tile-progress
 *     Returns the current pre-cache progress for the event identified
 *     by the `x-competition-id` header. Polled by the frontend during
 *     the "Generating tiles…" overlay so the operator sees real
 *     progress instead of an indefinite spinner.
 *
 * Internally:
 *   - The full OCAD file (BLOB in `map_files`) is rasterised to one
 *     large bitmap on first request (cached in-process per event).
 *     Each tile is then resampled from that bitmap with bilinear
 *     interpolation so adjacent tiles share their geographic edges
 *     pixel-perfectly (the +0.5 centre-sample is what kills seams).
 *   - After the first render we kick off `preCacheTiles()` in the
 *     background to fill `map_tiles` for zoom levels 10–17 over the
 *     map's WGS84 footprint.
 *   - `onMapUpload(eventId)` (fired from `course.uploadMap`)
 *     invalidates the in-process bitmap and tile-cache progress.
 *
 * MeOS-compat / migration note: legacy router used a per-competition
 * MySQL database with raw `INSERT IGNORE`. The new schema folds
 * everything into the shared `oxygen` schema in Postgres with
 * `ON CONFLICT (event_id, z, x, y) DO NOTHING`.
 */

import type { FastifyInstance } from "fastify";
import { prisma, onMapUpload } from "./db.js";
import { assertRestAccess } from "./restGuard.js";
import {
  ocadBoundsToWgs84,
  tileBoundsWgs84,
  wgs84ToOcad,
  type OcadCrs,
} from "./map-projection.js";

interface BitmapInfo {
  data: Buffer;
  width: number;
  height: number;
  /** Bitmap pixels per OCAD unit (hundredths of mm). */
  scale: number;
}

interface PreRenderedMap {
  bitmap: BitmapInfo;
  crs: OcadCrs;
  ocadBounds: number[];
}

interface TileProgress {
  total: number;
  done: number;
  rendering: boolean;
}

// Per-event in-process state. Keyed by `event.id` (bigserial).
const mapCache = new Map<bigint, PreRenderedMap>();
const mapRenderInFlight = new Map<bigint, Promise<PreRenderedMap>>();
const tileCacheProgress = new Map<bigint, TileProgress>();

/**
 * Drop in-memory state for `eventId` — called whenever a new map is
 * uploaded so the next tile request re-rasters the latest file.
 */
function invalidate(eventId: bigint): void {
  mapCache.delete(eventId);
  mapRenderInFlight.delete(eventId);
  tileCacheProgress.delete(eventId);
}

async function resolveEventId(nameId: string): Promise<bigint | null> {
  if (!nameId) return null;
  const row = await prisma().event.findUnique({
    where: { nameId },
    select: { id: true },
  });
  return row?.id ?? null;
}

/**
 * Return the pre-rendered bitmap + CRS for `eventId`, rasterising the
 * OCAD file lazily on first request. A second concurrent request for
 * the same event awaits the in-flight render instead of starting a
 * duplicate raster job (the in-flight map can cost 100s of MB +
 * several seconds).
 */
async function getPreRenderedMap(eventId: bigint): Promise<PreRenderedMap> {
  const cached = mapCache.get(eventId);
  if (cached) return cached;

  const inFlight = mapRenderInFlight.get(eventId);
  if (inFlight) return inFlight;

  const promise = doPreRenderMap(eventId);
  mapRenderInFlight.set(eventId, promise);
  try {
    const result = await promise;
    mapCache.set(eventId, result);
    return result;
  } finally {
    mapRenderInFlight.delete(eventId);
  }
}

/**
 * Actually load + rasterise the OCAD file for `eventId`. Caps the
 * raster at ~800M pixels (~3.2 GB RGBA in memory) — Node's default
 * old-space cap is 4 GB. After rendering, kick off `preCacheTiles` in
 * the background so the first viewer pays nothing for subsequent
 * tiles.
 */
async function doPreRenderMap(eventId: bigint): Promise<PreRenderedMap> {
  const db = prisma();
  const row = await db.mapFile.findFirst({
    where: { eventId },
    orderBy: { id: "desc" },
    select: { fileData: true },
  });
  if (!row) throw new Error("No map file uploaded");

  const buffer = Buffer.from(row.fileData);

  // Lazy-load OCAD + JSDOM so the dependencies don't add to API
  // cold-start latency for events that never look at a map.
  const ocadMod = await import("ocad2geojson");
  const readOcad = (ocadMod as Record<string, unknown>).readOcad as (
    buf: Buffer,
    opts?: Record<string, unknown>,
  ) => Promise<{
    getCrs(): OcadCrs;
    getBounds(): number[];
    objects: unknown[];
    symbols: unknown[];
    colors: unknown[];
    parameterStrings: Record<string, unknown[]>;
  }>;
  const ocadToSvg = (ocadMod as Record<string, unknown>).ocadToSvg as (
    file: unknown,
    opts: Record<string, unknown>,
  ) => { outerHTML: string };

  const jsdomMod = await import("jsdom");
  const dom = new jsdomMod.JSDOM(
    "<!DOCTYPE html><html><body></body></html>",
  );
  const document = dom.window.document;

  const ocadFile = await readOcad(buffer, { quietWarnings: true });
  const svgElement = ocadToSvg(ocadFile, {
    document,
    generateSymbolElements: true,
    exportHidden: false,
  });

  const crs = ocadFile.getCrs();
  const ocadBounds = ocadFile.getBounds();

  const [bMinX, bMinY, bMaxX, bMaxY] = ocadBounds;
  const ocadW = bMaxX - bMinX;
  const ocadH = bMaxY - bMinY;

  const maxPixels = 800_000_000;
  const idealPxPerUnit = 1.0;
  const idealPixels = ocadW * idealPxPerUnit * ocadH * idealPxPerUnit;
  const pxPerUnit =
    idealPixels > maxPixels
      ? Math.sqrt(maxPixels / (ocadW * ocadH))
      : idealPxPerUnit;
  const bitmapW = Math.ceil(ocadW * pxPerUnit);
  const bitmapH = Math.ceil(ocadH * pxPerUnit);

  const resvgMod = await import("@resvg/resvg-js");
  const resvg = new resvgMod.Resvg(svgElement.outerHTML, {
    fitTo: { mode: "width" as const, value: bitmapW },
    background: "white",
  });
  const rendered = resvg.render();

  const bitmap: BitmapInfo = {
    data: Buffer.from(rendered.pixels),
    width: rendered.width,
    height: rendered.height,
    scale: rendered.width / ocadW,
  };

  // Pre-cache tiles in background — don't block the first request.
  preCacheTiles(eventId, bitmap, crs, ocadBounds).catch((err) => {
    console.error("[map-tiles] preCacheTiles failed:", err);
  });

  return { bitmap, crs, ocadBounds };
}

/**
 * Render a single tile from the pre-rendered bitmap. Returns the PNG
 * bytes, or `null` if the tile doesn't overlap the map's bounds at
 * all (caller turns this into a 204).
 *
 * Sampling happens at pixel centres (`u, v ∈ [(0.5)/N, (N-0.5)/N]`)
 * — the legacy +0.5 fix that makes adjacent tiles share the exact
 * same geographic edge sample, eliminating the 1-pixel hairline you
 * see when neighbours sample at corners.
 */
async function renderTile(
  z: number,
  x: number,
  y: number,
  bitmap: BitmapInfo,
  crs: OcadCrs,
  ocadBounds: number[],
): Promise<Buffer | null> {
  const tileBds = tileBoundsWgs84(z, x, y);
  const mapWgs84 = ocadBoundsToWgs84(ocadBounds, crs);
  if (!mapWgs84) return null;

  // Quick AABB rejection in WGS84.
  if (
    tileBds.west > mapWgs84.east ||
    tileBds.east < mapWgs84.west ||
    tileBds.south > mapWgs84.north ||
    tileBds.north < mapWgs84.south
  ) {
    return null;
  }

  const nw = wgs84ToOcad(tileBds.north, tileBds.west, crs);
  const ne = wgs84ToOcad(tileBds.north, tileBds.east, crs);
  const sw = wgs84ToOcad(tileBds.south, tileBds.west, crs);
  const se = wgs84ToOcad(tileBds.south, tileBds.east, crs);
  if (!nw || !ne || !sw || !se) return null;

  const tileSize = 256;
  const {
    data: bitmapData,
    width: bmpW,
    height: bmpH,
    scale: pxPerUnit,
  } = bitmap;
  const [bMinX, , , bMaxY] = ocadBounds;

  const ocadToBitmapPx = (ocadX: number, ocadY: number) => ({
    bx: (ocadX - bMinX) * pxPerUnit,
    by: (bMaxY - ocadY) * pxPerUnit,
  });

  const nwPx = ocadToBitmapPx(nw.x, nw.y);
  const nePx = ocadToBitmapPx(ne.x, ne.y);
  const swPx = ocadToBitmapPx(sw.x, sw.y);
  const sePx = ocadToBitmapPx(se.x, se.y);

  const tilePixels = Buffer.alloc(tileSize * tileSize * 4);
  let hasContent = false;

  for (let ty = 0; ty < tileSize; ty++) {
    const v = (ty + 0.5) / tileSize;
    const leftBx = nwPx.bx + (swPx.bx - nwPx.bx) * v;
    const leftBy = nwPx.by + (swPx.by - nwPx.by) * v;
    const rightBx = nePx.bx + (sePx.bx - nePx.bx) * v;
    const rightBy = nePx.by + (sePx.by - nePx.by) * v;

    for (let tx = 0; tx < tileSize; tx++) {
      const u = (tx + 0.5) / tileSize;
      const srcX = leftBx + (rightBx - leftBx) * u;
      const srcY = leftBy + (rightBy - leftBy) * u;

      const x0 = Math.floor(srcX);
      const y0 = Math.floor(srcY);
      if (x0 < 0 || y0 < 0 || x0 + 1 >= bmpW || y0 + 1 >= bmpH) continue;

      const fx = srcX - x0;
      const fy = srcY - y0;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      const i00 = (y0 * bmpW + x0) * 4;
      const i10 = (y0 * bmpW + (x0 + 1)) * 4;
      const i01 = ((y0 + 1) * bmpW + x0) * 4;
      const i11 = ((y0 + 1) * bmpW + (x0 + 1)) * 4;

      const dstOff = (ty * tileSize + tx) * 4;
      for (let ch = 0; ch < 4; ch++) {
        tilePixels[dstOff + ch] = Math.round(
          bitmapData[i00 + ch] * w00 +
            bitmapData[i10 + ch] * w10 +
            bitmapData[i01 + ch] * w01 +
            bitmapData[i11 + ch] * w11,
        );
      }
      if (tilePixels[dstOff + 3] > 0) hasContent = true;
    }
  }

  if (!hasContent) return null;

  const sharpMod = await import("sharp");
  return sharpMod
    .default(tilePixels, {
      raw: { width: tileSize, height: tileSize, channels: 4 },
    })
    .png()
    .toBuffer();
}

/**
 * Render every overlapping tile for zoom levels 10–17 in the
 * background. Idempotent: skips entirely if the cache already has
 * more than 10 tiles for this event (a previously-completed pre-cache
 * is a strong "we already did this" signal). Per-event progress is
 * exposed via `/api/map-tile-progress`.
 */
async function preCacheTiles(
  eventId: bigint,
  bitmap: BitmapInfo,
  crs: OcadCrs,
  ocadBounds: number[],
): Promise<void> {
  const mapWgs84 = ocadBoundsToWgs84(ocadBounds, crs);
  if (!mapWgs84) return;

  const db = prisma();
  const existingCount = await db.mapTile.count({ where: { eventId } });
  if (existingCount > 10) return;

  const lonToTileX = (lon: number, z: number) =>
    Math.floor(((lon + 180) / 360) * Math.pow(2, z));
  const latToTileY = (lat: number, z: number) => {
    const rad = (lat * Math.PI) / 180;
    return Math.floor(
      ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) *
        Math.pow(2, z),
    );
  };

  let totalTiles = 0;
  for (let z = 10; z <= 17; z++) {
    const minTileX = lonToTileX(mapWgs84.west, z);
    const maxTileX = lonToTileX(mapWgs84.east, z);
    const minTileY = latToTileY(mapWgs84.north, z);
    const maxTileY = latToTileY(mapWgs84.south, z);
    totalTiles += (maxTileX - minTileX + 1) * (maxTileY - minTileY + 1);
  }
  tileCacheProgress.set(eventId, {
    total: totalTiles,
    done: 0,
    rendering: true,
  });

  for (let z = 10; z <= 17; z++) {
    const minTileX = lonToTileX(mapWgs84.west, z);
    const maxTileX = lonToTileX(mapWgs84.east, z);
    const minTileY = latToTileY(mapWgs84.north, z);
    const maxTileY = latToTileY(mapWgs84.south, z);

    for (let tx = minTileX; tx <= maxTileX; tx++) {
      for (let ty = minTileY; ty <= maxTileY; ty++) {
        try {
          const png = await renderTile(z, tx, ty, bitmap, crs, ocadBounds);
          if (png) {
            // ON CONFLICT DO NOTHING — a concurrent on-demand render of
            // the same tile may have written ahead of us.
            await db.$executeRawUnsafe(
              `INSERT INTO oxygen.map_tiles (event_id, z, x, y, tile_data)
               VALUES ($1::bigint, $2, $3, $4, $5)
               ON CONFLICT (event_id, z, x, y) DO NOTHING`,
              eventId,
              z,
              tx,
              ty,
              png,
            );
          }
        } catch (err) {
          // The Prisma client may have closed (test teardown, server
          // shutdown). "Response from the Engine was empty" / "Engine
          // is not yet connected" both mean the pool is gone — bail
          // out of the entire pre-cache loop instead of spamming the
          // log with per-tile failures.
          const msg = String((err as Error)?.message ?? "");
          if (
            msg.includes("Response from the Engine was empty") ||
            msg.includes("Engine is not yet connected")
          ) {
            const prog = tileCacheProgress.get(eventId);
            if (prog) prog.rendering = false;
            return;
          }
          console.error(
            `[map-tiles] precache failed at z=${z} x=${tx} y=${ty}:`,
            err,
          );
        }
        const prog = tileCacheProgress.get(eventId);
        if (prog) prog.done++;
      }
    }
  }
  const prog = tileCacheProgress.get(eventId);
  if (prog) prog.rendering = false;
}

/**
 * Register the two `/api/map-tile*` Fastify routes and subscribe the
 * cache to `onMapUpload` invalidations. Call once during server boot.
 */
export function registerMapTileRoutes(server: FastifyInstance): void {
  onMapUpload(invalidate);

  // Progress endpoint — polled by the frontend during the
  // "Generating tiles…" overlay. The event is identified by the
  // `x-competition-id` header so the call doesn't have to re-mint a
  // URL on every poll.
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
    return reply.send(
      tileCacheProgress.get(eventId) ?? {
        total: 0,
        done: 0,
        rendering: false,
      },
    );
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

      const cached = await prisma().mapTile.findUnique({
        where: { eventId_z_x_y: { eventId, z, x, y } },
        select: { tileData: true },
      });
      if (cached) {
        return reply
          .header("Content-Type", "image/png")
          .header("Cache-Control", "public, max-age=604800")
          .send(Buffer.from(cached.tileData));
      }

      try {
        const { bitmap, crs, ocadBounds } = await getPreRenderedMap(eventId);
        const png = await renderTile(z, x, y, bitmap, crs, ocadBounds);
        if (!png) {
          // Tile falls outside the map — cache the "empty" response
          // for a week so the browser stops asking.
          return reply
            .header("Cache-Control", "public, max-age=604800")
            .code(204)
            .send();
        }
        // Best-effort cache write — race with the background
        // pre-cacher is benign because of ON CONFLICT DO NOTHING.
        try {
          await prisma().$executeRawUnsafe(
            `INSERT INTO oxygen.map_tiles (event_id, z, x, y, tile_data)
             VALUES ($1::bigint, $2, $3, $4, $5)
             ON CONFLICT (event_id, z, x, y) DO NOTHING`,
            eventId,
            z,
            x,
            y,
            png,
          );
        } catch (err) {
          server.log.warn({ err }, "tile cache write failed");
        }
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
