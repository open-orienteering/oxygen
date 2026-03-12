import Fastify from "fastify";
import cors from "@fastify/cors";
import {
  fastifyTRPCPlugin,
  type FastifyTRPCPluginOptions,
} from "@trpc/server/adapters/fastify";
import { appRouter, type AppRouter } from "./routers/index.js";
export type { AppRouter };
import { createContext } from "./trpc.js";
import { disconnectAll, getCompetitionClient, ensureLogoTable, getMainDbConnection, ensureClubDbTable, ensureMapFilesTable, ensureMapTilesTable, onCompetitionSwitch } from "./db.js";
import { tileBoundsWgs84, wgs84ToOcad, ocadBoundsToWgs84, type OcadCrs } from "./map-projection.js";
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
      const client = await getCompetitionClient();
      await ensureLogoTable(client);
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

  // Module-level cache for the pre-rendered map bitmap + CRS
  let cachedBitmap: { data: Buffer; width: number; height: number; scale: number } | null = null;
  let cachedOcadBounds: number[] | null = null;
  let cachedCrs: OcadCrs | null = null;

  // Invalidate cached bitmap when switching competitions
  onCompetitionSwitch(() => {
    cachedBitmap = null;
    cachedOcadBounds = null;
    cachedCrs = null;
  });

  async function getPreRenderedMap() {
    if (cachedBitmap && cachedCrs && cachedOcadBounds) {
      return { bitmap: cachedBitmap, crs: cachedCrs, ocadBounds: cachedOcadBounds };
    }

    const client = await getCompetitionClient();
    await ensureMapFilesTable(client);

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

    cachedCrs = ocadFile.getCrs();
    server.log.info(`OCAD CRS: code=${cachedCrs.code}, catalog=${cachedCrs.catalog}, easting=${cachedCrs.easting}, northing=${cachedCrs.northing}, scale=${cachedCrs.scale}`);
    cachedOcadBounds = ocadFile.getBounds();
    server.log.info(`OCAD bounds: ${JSON.stringify(cachedOcadBounds)}`);

    const [bMinX, bMinY, bMaxX, bMaxY] = cachedOcadBounds;
    const ocadW = bMaxX - bMinX;
    const ocadH = bMaxY - bMinY;

    // Pre-render the full SVG to a bitmap.
    // Cap total pixels to ~500M (2GB RGBA buffer) to avoid ERR_BUFFER_TOO_LARGE.
    const maxPixels = 500_000_000;
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
      background: "rgba(0,0,0,0)",
    });
    const rendered = resvg.render();

    cachedBitmap = {
      data: Buffer.from(rendered.pixels),
      width: rendered.width,
      height: rendered.height,
      scale: rendered.width / ocadW,
    };

    server.log.info(`Pre-rendered: ${cachedBitmap.width}x${cachedBitmap.height}, scale=${cachedBitmap.scale.toFixed(4)} px/unit`);

    return { bitmap: cachedBitmap, crs: cachedCrs, ocadBounds: cachedOcadBounds };
  }

  server.get<{
    Params: { z: string; x: string; y: string };
  }>("/api/map-tile/:z/:x/:y", async (req, reply) => {
    const z = parseInt(req.params.z, 10);
    const x = parseInt(req.params.x, 10);
    const y = parseInt(req.params.y, 10);

    if (isNaN(z) || isNaN(x) || isNaN(y)) {
      return reply.code(400).send({ error: "Invalid tile coordinates" });
    }

    // Check DB cache
    const client = await getCompetitionClient();
    await ensureMapTilesTable(client);

    const cached = await client.$queryRawUnsafe<{ TileData: Buffer }[]>(
      "SELECT TileData FROM oxygen_map_tiles WHERE Z=? AND X=? AND Y=?",
      z, x, y,
    );

    if (cached.length > 0) {
      return reply
        .header("Content-Type", "image/png")
        .header("Cache-Control", "public, max-age=604800")
        .send(Buffer.from(cached[0].TileData));
    }

    // Render tile
    try {
      const { bitmap, crs, ocadBounds } = await getPreRenderedMap();

      // Check if tile overlaps the map bounds (in WGS84)
      const tileBounds = tileBoundsWgs84(z, x, y);
      const mapWgs84 = ocadBoundsToWgs84(ocadBounds, crs);
      if (!mapWgs84) {
        return reply.code(204).send();
      }

      // Quick overlap check
      if (
        tileBounds.west > mapWgs84.east ||
        tileBounds.east < mapWgs84.west ||
        tileBounds.south > mapWgs84.north ||
        tileBounds.north < mapWgs84.south
      ) {
        return reply.code(204).send();
      }

      // Convert all 4 tile corners to OCAD coordinates
      const nw = wgs84ToOcad(tileBounds.north, tileBounds.west, crs);
      const ne = wgs84ToOcad(tileBounds.north, tileBounds.east, crs);
      const sw = wgs84ToOcad(tileBounds.south, tileBounds.west, crs);
      const se = wgs84ToOcad(tileBounds.south, tileBounds.east, crs);
      if (!nw || !ne || !sw || !se) {
        return reply.code(204).send();
      }

      const tileSize = 256;
      const { data: bitmapData, width: bmpW, height: bmpH, scale: pxPerUnit } = bitmap;
      const [bMinX, bMinY, bMaxX, bMaxY] = ocadBounds;

      // Convert OCAD coordinates to bitmap pixel coordinates
      // Bitmap X: (ocadX - bMinX) * pxPerUnit
      // Bitmap Y: (bMaxY - ocadY) * pxPerUnit  (Y inverted: top of bitmap = max OCAD Y)
      function ocadToBitmapPx(ocadX: number, ocadY: number) {
        return {
          bx: (ocadX - bMinX) * pxPerUnit,
          by: (bMaxY - ocadY) * pxPerUnit,
        };
      }

      const nwPx = ocadToBitmapPx(nw.x, nw.y);
      const nePx = ocadToBitmapPx(ne.x, ne.y);
      const swPx = ocadToBitmapPx(sw.x, sw.y);
      const sePx = ocadToBitmapPx(se.x, se.y);

      // Bilinear mapping: tile pixel (tx, ty) → bitmap pixel (bx, by)
      // Uses all 4 corners so adjacent tiles agree exactly at shared edges.
      // (0,0)→nwPx, (T,0)→nePx, (0,T)→swPx, (T,T)→sePx
      const tilePixels = Buffer.alloc(tileSize * tileSize * 4);
      let hasContent = false;

      for (let ty = 0; ty < tileSize; ty++) {
        const v = ty / tileSize;
        // Precompute the left and right edge bitmap positions for this row
        const leftBx  = nwPx.bx + (swPx.bx - nwPx.bx) * v;
        const leftBy  = nwPx.by + (swPx.by - nwPx.by) * v;
        const rightBx = nePx.bx + (sePx.bx - nePx.bx) * v;
        const rightBy = nePx.by + (sePx.by - nePx.by) * v;

        for (let tx = 0; tx < tileSize; tx++) {
          const u = tx / tileSize;
          const srcX = leftBx + (rightBx - leftBx) * u;
          const srcY = leftBy + (rightBy - leftBy) * u;

          // Bilinear interpolation
          const x0 = Math.floor(srcX);
          const y0 = Math.floor(srcY);
          const x1 = x0 + 1;
          const y1 = y0 + 1;

          if (x0 < 0 || y0 < 0 || x1 >= bmpW || y1 >= bmpH) {
            // Out of bounds — transparent
            continue;
          }

          const fx = srcX - x0;
          const fy = srcY - y0;
          const w00 = (1 - fx) * (1 - fy);
          const w10 = fx * (1 - fy);
          const w01 = (1 - fx) * fy;
          const w11 = fx * fy;

          const i00 = (y0 * bmpW + x0) * 4;
          const i10 = (y0 * bmpW + x1) * 4;
          const i01 = (y1 * bmpW + x0) * 4;
          const i11 = (y1 * bmpW + x1) * 4;

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

      if (!hasContent) {
        return reply.code(204).send();
      }

      // Encode tile as PNG using sharp
      const sharpMod = await import("sharp");
      const pngBuffer = await sharpMod.default(tilePixels, {
        raw: { width: tileSize, height: tileSize, channels: 4 },
      }).png().toBuffer();

      // Cache in DB
      try {
        await client.$executeRawUnsafe(
          "INSERT IGNORE INTO oxygen_map_tiles (Z, X, Y, TileData) VALUES (?, ?, ?, ?)",
          z, x, y, pngBuffer,
        );
      } catch {
        // Ignore duplicate key errors from race conditions
      }

      return reply
        .header("Content-Type", "image/png")
        .header("Cache-Control", "public, max-age=604800")
        .send(pngBuffer);
    } catch (err) {
      server.log.error({ err }, "Failed to render map tile");
      return reply.code(500).send({ error: "Failed to render tile" });
    }
  });

  // Graceful shutdown
  const shutdown = async () => {
    server.log.info("Shutting down...");
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
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

main();
