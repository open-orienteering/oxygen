import Fastify from "fastify";
import cors from "@fastify/cors";
import {
  fastifyTRPCPlugin,
  type FastifyTRPCPluginOptions,
} from "@trpc/server/adapters/fastify";
import { appRouter, type AppRouter } from "./routers/index.js";
export type { AppRouter };
import { createContext } from "./trpc.js";
import { disconnectAll, getCompetitionClient, ensureLogoTable, getMainDbConnection, ensureClubDbTable, ensureMapFilesTable, ensureMapTilesTable, onMapUpload } from "./db.js";
import { tileBoundsWgs84, wgs84ToOcad, ocadBoundsToWgs84, type OcadCrs } from "./map-projection.js";
import { liveResultsPusher, reconcileEnabledPushers } from "./liveresults.js";
import { registerBackupRoute } from "./backup.js";
import "dotenv/config";

const PORT = parseInt(process.env.PORT ?? "3002", 10);
const HOST = process.env.HOST ?? "0.0.0.0";

async function main() {
  const server = Fastify({
    logger: {
      level: "info",
      transport: {
        target: "pino-pretty",
        options: { translateTime: "HH:MM:ss Z", ignore: "pid,hostname" },
      },
    },
    bodyLimit: 50 * 1024 * 1024, // 50 MB — needed for OCAD map file uploads (base64)
    maxParamLength: 500, // tRPC httpBatchLink joins procedure names with commas in the URL path
  });

  // CORS for the frontend dev server
  await server.register(cors, {
    origin: ["http://localhost:5173", "http://localhost:4173", "http://localhost:8080"],
    credentials: true,
    allowedHeaders: ["content-type", "x-competition-id"],
  });

  // tRPC handler
  await server.register(fastifyTRPCPlugin, {
    prefix: "/trpc",
    trpcOptions: {
      router: appRouter,
      createContext,
    } satisfies FastifyTRPCPluginOptions<AppRouter>["trpcOptions"],
  });

  // Health check + version info
  const SERVER_START = new Date().toISOString();
  server.get("/health", async () => ({ status: "ok", startedAt: SERVER_START }));
  server.get("/api/version", async (_req, reply) => {
    return reply
      .header("Cache-Control", "no-store")
      .send({ startedAt: SERVER_START });
  });

  // ─── Competition database backup ──────────────────────────
  // GET /api/backup/competition?name=<NameId>
  // Streams a mysqldump of the competition database, prefixed with a
  // header that includes a commented INSERT for re-registering the
  // competition in MeOSMain after restore.
  registerBackupRoute(server);

  // ─── Club Logo endpoint ────────────────────────────────────
  // Serves PNG images — checks global oxygen_club_db (MeOSMain) first,
  // then falls back to per-competition oxygen_club_logo table.
  // GET /api/club-logo/:eventorId?variant=small|large
  server.get<{
    Params: { eventorId: string };
    Querystring: { variant?: string };
  }>("/api/club-logo/:eventorId", async (req, reply) => {
    const eventorId = parseInt(req.params.eventorId, 10);
    if (!eventorId || isNaN(eventorId)) {
      return reply.code(400).send({ error: "Invalid eventorId" });
    }
    const variant = req.query.variant === "large" ? "large" : "small";

    // 1. Try global oxygen_club_db in MeOSMain
    try {
      const mainConn = await getMainDbConnection();
      try {
        await ensureClubDbTable(mainConn);
        const [rows] = await mainConn.execute(
          `SELECT SmallLogoPng, LargeLogoPng FROM oxygen_club_db WHERE EventorId = ?`,
          [eventorId],
        );
        const arr = rows as Record<string, unknown>[];
        if (arr.length > 0) {
          const data = (variant === "large" && arr[0].LargeLogoPng
            ? arr[0].LargeLogoPng
            : arr[0].SmallLogoPng) as Buffer | null;
          if (data && Buffer.isBuffer(data) && data.length > 0) {
            return reply
              .header("Content-Type", "image/png")
              .header("Cache-Control", "public, max-age=86400")
              .send(data);
          }
        }
      } finally {
        await mainConn.end();
      }
    } catch {
      // Global table might not exist yet — fall through
    }

    // 2. Fall back to per-competition oxygen_club_logo
    try {
      const rawDbName = req.headers["x-competition-id"];
      const dbName = (Array.isArray(rawDbName) ? rawDbName[0] : rawDbName) ?? "";
      if (!dbName) return reply.code(404).send({ error: "No competition selected" });
      const client = await getCompetitionClient(dbName);
      await ensureLogoTable(client, dbName);
      const logo = await client.oxygen_club_logo.findUnique({
        where: { EventorId: eventorId },
      });

      if (!logo) {
        return reply.code(404).send({ error: "Logo not found" });
      }

      const data = variant === "large" && logo.LargePng
        ? logo.LargePng
        : logo.SmallPng;

      return reply
        .header("Content-Type", "image/png")
        .header("Cache-Control", "public, max-age=86400")
        .send(Buffer.from(data));
    } catch {
      return reply.code(404).send({ error: "Logo not found" });
    }
  });

  // ─── Map Tile endpoint ──────────────────────────────────────
  // Serves 256x256 PNG tiles of the OCAD map at slippy-map coordinates.
  // GET /api/map-tile/:z/:x/:y

  // Per-competition cache for the pre-rendered map bitmap + CRS
  type BitmapInfo = { data: Buffer; width: number; height: number; scale: number };
  type PreRenderedMap = { bitmap: BitmapInfo; crs: OcadCrs; ocadBounds: number[] };
  type MapCacheEntry = PreRenderedMap;

  const mapCache = new Map<string, MapCacheEntry>();
  const mapRenderInFlight = new Map<string, Promise<PreRenderedMap>>();

  // Tile pre-cache progress tracking — one entry per competition
  const tileCacheProgress = new Map<string, { total: number; done: number; rendering: boolean }>();

  // Invalidate cached bitmap for a specific competition when its map is re-uploaded
  onMapUpload((nameId: string) => {
    mapCache.delete(nameId);
    mapRenderInFlight.delete(nameId);
    tileCacheProgress.delete(nameId);
  });

  async function getPreRenderedMap(dbName: string): Promise<PreRenderedMap> {
    const cached = mapCache.get(dbName);
    if (cached) return cached;

    // Mutex: if a render is already in flight for this competition, wait for it
    const inFlight = mapRenderInFlight.get(dbName);
    if (inFlight) return inFlight;

    const promise = doPreRenderMap(dbName);
    mapRenderInFlight.set(dbName, promise);
    try {
      const result = await promise;
      mapCache.set(dbName, result);
      return result;
    } finally {
      mapRenderInFlight.delete(dbName);
    }
  }

  async function doPreRenderMap(dbName: string) {
    const client = await getCompetitionClient(dbName);
    await ensureMapFilesTable(client, dbName);

    const rows = await client.$queryRawUnsafe<{ FileData: Buffer }[]>(
      "SELECT FileData FROM oxygen_map_files ORDER BY Id DESC LIMIT 1",
    );
    if (rows.length === 0) throw new Error("No map file uploaded");

    const buffer = Buffer.from(rows[0].FileData);

    // Lazy-load OCAD + JSDOM
    const ocadMod = await import("ocad2geojson");
    const readOcad = (ocadMod as Record<string, unknown>).readOcad as (buf: Buffer, opts?: Record<string, unknown>) => Promise<{ getCrs(): OcadCrs; getBounds(): number[]; objects: unknown[]; symbols: unknown[]; colors: unknown[]; parameterStrings: Record<string, unknown[]> }>;
    const ocadToSvg = (ocadMod as Record<string, unknown>).ocadToSvg as (file: unknown, opts: Record<string, unknown>) => { outerHTML: string; getAttribute(name: string): string | null };

    const jsdomMod = await import("jsdom");
    const dom = new jsdomMod.JSDOM("<!DOCTYPE html><html><body></body></html>");
    const document = dom.window.document;

    const ocadFile = await readOcad(buffer, { quietWarnings: true });
    const svgElement = ocadToSvg(ocadFile, {
      document,
      generateSymbolElements: true,
      exportHidden: false,
    });

    const crs = ocadFile.getCrs();
    server.log.info(`OCAD CRS: code=${crs.code}, catalog=${crs.catalog}, easting=${crs.easting}, northing=${crs.northing}, scale=${crs.scale}`);
    const ocadBounds = ocadFile.getBounds();
    server.log.info(`OCAD bounds: ${JSON.stringify(ocadBounds)}`);

    const [bMinX, bMinY, bMaxX, bMaxY] = ocadBounds;
    const ocadW = bMaxX - bMinX;
    const ocadH = bMaxY - bMinY;

    // Pre-render the full SVG to a bitmap.
    // Cap total pixels to ~800M (3.2GB RGBA buffer). Node max-old-space-size is 4GB.
    const maxPixels = 800_000_000;
    const idealPxPerUnit = 1.0;
    const idealPixels = ocadW * idealPxPerUnit * ocadH * idealPxPerUnit;
    const pxPerUnit = idealPixels > maxPixels
      ? Math.sqrt(maxPixels / (ocadW * ocadH))
      : idealPxPerUnit;
    const bitmapW = Math.ceil(ocadW * pxPerUnit);
    const bitmapH = Math.ceil(ocadH * pxPerUnit);

    server.log.info(`Pre-rendering map: ${bitmapW}x${bitmapH} px (${(bitmapW * bitmapH * 4 / 1024 / 1024).toFixed(1)} MB)`);

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

    server.log.info(`Pre-rendered: ${bitmap.width}x${bitmap.height}, scale=${bitmap.scale.toFixed(4)} px/unit`);

    // Pre-cache tiles in background (don't block the first request)
    preCacheTiles(bitmap, crs, ocadBounds, dbName).catch((err) => {
      server.log.error({ err }, "Failed to pre-cache tiles");
    });

    return { bitmap, crs, ocadBounds };
  }

  /**
   * Render a single tile from the pre-rendered bitmap.
   * Returns the PNG buffer, or null if the tile has no content.
   */
  async function renderTile(
    z: number, x: number, y: number,
    bitmap: BitmapInfo,
    crs: OcadCrs,
    ocadBounds: number[],
  ): Promise<Buffer | null> {
    const tileBds = tileBoundsWgs84(z, x, y);
    const mapWgs84 = ocadBoundsToWgs84(ocadBounds, crs);
    if (!mapWgs84) return null;

    if (
      tileBds.west > mapWgs84.east || tileBds.east < mapWgs84.west ||
      tileBds.south > mapWgs84.north || tileBds.north < mapWgs84.south
    ) return null;

    const nw = wgs84ToOcad(tileBds.north, tileBds.west, crs);
    const ne = wgs84ToOcad(tileBds.north, tileBds.east, crs);
    const sw = wgs84ToOcad(tileBds.south, tileBds.west, crs);
    const se = wgs84ToOcad(tileBds.south, tileBds.east, crs);
    if (!nw || !ne || !sw || !se) return null;

    const tileSize = 256;
    const { data: bitmapData, width: bmpW, height: bmpH, scale: pxPerUnit } = bitmap;
    const [bMinX, , , bMaxY] = ocadBounds;

    function ocadToBitmapPx(ocadX: number, ocadY: number) {
      return { bx: (ocadX - bMinX) * pxPerUnit, by: (bMaxY - ocadY) * pxPerUnit };
    }

    const nwPx = ocadToBitmapPx(nw.x, nw.y);
    const nePx = ocadToBitmapPx(ne.x, ne.y);
    const swPx = ocadToBitmapPx(sw.x, sw.y);
    const sePx = ocadToBitmapPx(se.x, se.y);

    const tilePixels = Buffer.alloc(tileSize * tileSize * 4);
    let hasContent = false;

    // Sample at pixel centres (u, v ∈ [0.5/N, (N-0.5)/N]) rather than at
    // pixel corners (u, v ∈ [0, (N-1)/N]). With the previous mapping the
    // rightmost column of tile A sampled at u=255/256 of A's geographic
    // span while tile B's leftmost column sampled at u=0 of B's span, which
    // share a geographic edge — producing a 1-sample discontinuity that
    // renders as a hairline seam between adjacent tiles.
    for (let ty = 0; ty < tileSize; ty++) {
      const v = (ty + 0.5) / tileSize;
      const leftBx  = nwPx.bx + (swPx.bx - nwPx.bx) * v;
      const leftBy  = nwPx.by + (swPx.by - nwPx.by) * v;
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
            bitmapData[i00 + ch] * w00 + bitmapData[i10 + ch] * w10 +
            bitmapData[i01 + ch] * w01 + bitmapData[i11 + ch] * w11,
          );
        }
        if (tilePixels[dstOff + 3] > 0) hasContent = true;
      }
    }

    if (!hasContent) return null;

    const sharpMod = await import("sharp");
    return sharpMod.default(tilePixels, {
      raw: { width: tileSize, height: tileSize, channels: 4 },
    }).png().toBuffer();
  }

  /**
   * Pre-cache all tiles for zoom levels 10–16 that overlap the map bounds.
   * Runs in the background after the bitmap is first rendered.
   */
  async function preCacheTiles(
    bitmap: BitmapInfo,
    crs: OcadCrs,
    ocadBounds: number[],
    dbName: string,
  ) {
    const mapWgs84 = ocadBoundsToWgs84(ocadBounds, crs);
    if (!mapWgs84) return;

    const client = await getCompetitionClient(dbName);
    await ensureMapTilesTable(client, dbName);

    // Check how many tiles are already cached
    const countResult = await client.$queryRawUnsafe<{ cnt: bigint }[]>(
      "SELECT COUNT(*) as cnt FROM oxygen_map_tiles",
    );
    const existingCount = Number(countResult[0]?.cnt ?? 0);
    if (existingCount > 10) {
      server.log.info(`Tile cache already has ${existingCount} tiles, skipping pre-cache`);
      return;
    }

    // Count total tiles to generate for progress tracking
    let totalTiles = 0;
    for (let z = 10; z <= 17; z++) {
      const n = Math.pow(2, z);
      const minTileX = Math.floor(((mapWgs84.west + 180) / 360) * n);
      const maxTileX = Math.floor(((mapWgs84.east + 180) / 360) * n);
      const minTileY = Math.floor((1 - Math.log(Math.tan(mapWgs84.north * Math.PI / 180) + 1 / Math.cos(mapWgs84.north * Math.PI / 180)) / Math.PI) / 2 * n);
      const maxTileY = Math.floor((1 - Math.log(Math.tan(mapWgs84.south * Math.PI / 180) + 1 / Math.cos(mapWgs84.south * Math.PI / 180)) / Math.PI) / 2 * n);
      totalTiles += (maxTileX - minTileX + 1) * (maxTileY - minTileY + 1);
    }

    tileCacheProgress.set(dbName, { total: totalTiles, done: 0, rendering: true });

    let totalCached = 0;
    for (let z = 10; z <= 17; z++) {
      const n = Math.pow(2, z);
      const minTileX = Math.floor(((mapWgs84.west + 180) / 360) * n);
      const maxTileX = Math.floor(((mapWgs84.east + 180) / 360) * n);
      const minTileY = Math.floor((1 - Math.log(Math.tan(mapWgs84.north * Math.PI / 180) + 1 / Math.cos(mapWgs84.north * Math.PI / 180)) / Math.PI) / 2 * n);
      const maxTileY = Math.floor((1 - Math.log(Math.tan(mapWgs84.south * Math.PI / 180) + 1 / Math.cos(mapWgs84.south * Math.PI / 180)) / Math.PI) / 2 * n);

      for (let tx = minTileX; tx <= maxTileX; tx++) {
        for (let ty = minTileY; ty <= maxTileY; ty++) {
          try {
            const png = await renderTile(z, tx, ty, bitmap, crs, ocadBounds);
            if (png) {
              await client.$executeRawUnsafe(
                "INSERT IGNORE INTO oxygen_map_tiles (Z, X, Y, TileData) VALUES (?, ?, ?, ?)",
                z, tx, ty, png,
              );
              totalCached++;
            }
          } catch {
            // Skip failed tiles
          }
          const prog = tileCacheProgress.get(dbName);
          if (prog) prog.done++;
        }
      }
    }
    const prog = tileCacheProgress.get(dbName);
    if (prog) prog.rendering = false;
    server.log.info(`Pre-cached ${totalCached} tiles (zoom 10–17)`);
  }

  // Tile pre-cache progress endpoint (polled by frontend during map load)
  server.get("/api/map-tile-progress", async (req, reply) => {
    const rawDbName = req.headers["x-competition-id"];
    const dbName = (Array.isArray(rawDbName) ? rawDbName[0] : rawDbName) ?? "";
    return reply.send(tileCacheProgress.get(dbName) ?? { total: 0, done: 0, rendering: false });
  });

  // Path-based route — used by <img> tags (browsers can't add custom headers to img src)
  server.get<{
    Params: { nameId: string; z: string; x: string; y: string };
  }>("/api/map-tile/:nameId/:z/:x/:y", async (req, reply) => {
    const z = parseInt(req.params.z, 10);
    const x = parseInt(req.params.x, 10);
    const y = parseInt(req.params.y, 10);
    const dbName = req.params.nameId;

    if (isNaN(z) || isNaN(x) || isNaN(y) || !dbName) {
      return reply.code(400).send({ error: "Invalid tile request" });
    }

    const client = await getCompetitionClient(dbName);
    await ensureMapTilesTable(client, dbName);

    const cached = await client.$queryRawUnsafe<{ TileData: Buffer }[]>(
      "SELECT TileData FROM oxygen_map_tiles WHERE Z=? AND X=? AND Y=?", z, x, y,
    );
    if (cached.length > 0) {
      return reply.header("Content-Type", "image/png").header("Cache-Control", "public, max-age=604800").send(Buffer.from(cached[0].TileData));
    }

    try {
      const { bitmap, crs, ocadBounds } = await getPreRenderedMap(dbName);
      const pngBuffer = await renderTile(z, x, y, bitmap, crs, ocadBounds);
      if (!pngBuffer) return reply.header("Cache-Control", "public, max-age=604800").code(204).send();

      try { await client.$executeRawUnsafe("INSERT IGNORE INTO oxygen_map_tiles (Z, X, Y, TileData) VALUES (?, ?, ?, ?)", z, x, y, pngBuffer); } catch { /* race */ }
      return reply.header("Content-Type", "image/png").header("Cache-Control", "public, max-age=604800").send(pngBuffer);
    } catch (err) {
      server.log.error({ err }, "Failed to render map tile");
      return reply.code(500).send({ error: "Failed to render tile" });
    }
  });

  // Header-based route — backward compatibility for fetch()-based callers
  server.get<{
    Params: { z: string; x: string; y: string };
  }>("/api/map-tile/:z/:x/:y", async (req, reply) => {
    const z = parseInt(req.params.z, 10);
    const x = parseInt(req.params.x, 10);
    const y = parseInt(req.params.y, 10);
    const rawDbName = req.headers["x-competition-id"];
    const dbName = (Array.isArray(rawDbName) ? rawDbName[0] : rawDbName) ?? "";

    if (isNaN(z) || isNaN(x) || isNaN(y)) return reply.code(400).send({ error: "Invalid tile coordinates" });
    if (!dbName) return reply.code(400).send({ error: "No competition selected" });

    const client = await getCompetitionClient(dbName);
    await ensureMapTilesTable(client, dbName);

    const cached = await client.$queryRawUnsafe<{ TileData: Buffer }[]>(
      "SELECT TileData FROM oxygen_map_tiles WHERE Z=? AND X=? AND Y=?", z, x, y,
    );
    if (cached.length > 0) {
      return reply.header("Content-Type", "image/png").header("Cache-Control", "public, max-age=604800").send(Buffer.from(cached[0].TileData));
    }

    try {
      const { bitmap, crs, ocadBounds } = await getPreRenderedMap(dbName);
      const pngBuffer = await renderTile(z, x, y, bitmap, crs, ocadBounds);
      if (!pngBuffer) return reply.header("Cache-Control", "public, max-age=604800").code(204).send();

      try { await client.$executeRawUnsafe("INSERT IGNORE INTO oxygen_map_tiles (Z, X, Y, TileData) VALUES (?, ?, ?, ?)", z, x, y, pngBuffer); } catch { /* race */ }
      return reply.header("Content-Type", "image/png").header("Cache-Control", "public, max-age=604800").send(pngBuffer);
    } catch (err) {
      server.log.error({ err }, "Failed to render map tile");
      return reply.code(500).send({ error: "Failed to render tile" });
    }
  });

  // ─── Livelox tile proxy ───────────────────────────────────
  // Proxies map tile images from Livelox Azure blob storage to avoid CORS issues.
  // Only allows URLs from the expected Azure blob domain.
  server.get<{
    Querystring: { url: string };
  }>("/api/livelox-tile", async (req, reply) => {
    const { url } = req.query;
    if (!url || !url.startsWith("https://livelox.blob.core.windows.net/")) {
      return reply.code(400).send({ error: "Invalid or disallowed URL" });
    }
    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        return reply.code(resp.status).send({ error: "Upstream fetch failed" });
      }
      const buffer = Buffer.from(await resp.arrayBuffer());
      const contentType = resp.headers.get("content-type") ?? "image/png";
      return reply
        .header("Content-Type", contentType)
        .header("Cache-Control", "public, max-age=604800")
        .send(buffer);
    } catch (err) {
      server.log.error(err, "Livelox tile proxy error");
      return reply.code(502).send({ error: "Proxy fetch failed" });
    }
  });

  // Graceful shutdown
  const shutdown = async () => {
    server.log.info("Shutting down...");
    liveResultsPusher.stopAll();
    await disconnectAll();
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await server.listen({ port: PORT, host: HOST });
    server.log.info(`Oxygen API server running at http://${HOST}:${PORT}`);
    server.log.info(`tRPC endpoint: http://${HOST}:${PORT}/trpc`);

    // Re-arm LiveResults push timers for any competition that was enabled
    // before the previous restart. Runs in the background so it doesn't
    // delay readiness if the LiveResults database is slow to reach.
    void reconcileEnabledPushers()
      .then((res) => {
        if (res.started.length > 0) {
          server.log.info(
            { started: res.started, skipped: res.skipped.length, failed: res.failed },
            `Reconciled LiveResults pushers: started ${res.started.length}`,
          );
        }
        for (const f of res.failed) {
          server.log.warn({ nameId: f.nameId, error: f.error }, "LiveResults reconcile failed");
        }
      })
      .catch((err) => {
        server.log.error({ err }, "LiveResults reconcile threw");
      });
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

main();
