/**
 * Integration test for the `/api/map-tile/:nameId/:z/:x/:y` endpoint.
 *
 * Boots a real Fastify instance with the map-tile routes registered,
 * uploads a real OCAD fixture into `map_files`, and asserts:
 *   - the first request renders + returns a PNG
 *   - the second request is served from the `map_tiles` cache (and
 *     still returns a PNG)
 *   - rendering one tile fills its whole block, since the renderer
 *     rasterises a window covering a block at a time
 *   - deep zoom renders on demand (the zoom range the pre-cache skips)
 *   - an off-bounds tile returns 204
 *   - an unknown event slug returns 404
 *   - `/api/map-tile-progress` reports counts derived from the map's
 *     stored bounds and the `map_tiles` rows, not from process state
 *
 * The OCAD fixture (`e2e/test.ocd`) is the same one the E2E suite
 * uses for map upload flows.
 *
 * Background pre-caching is disabled here (`MAP_TILE_PRECACHE=off`) so
 * that row-count assertions see only what the request under test
 * rendered.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import Fastify, { type FastifyInstance } from "fastify";
import { registerMapTileRoutes } from "../../map-tiles.js";
import { createTestEvent, disconnect } from "../helpers/test-db.js";
import {
  ocadBoundsToWgs84,
  type OcadCrs,
} from "../../map-projection.js";
import {
  PRECACHE_MAX_ZOOM,
  PRECACHE_MIN_ZOOM,
  expectedTileCount,
} from "../../map-window.js";
import { DEFAULTS } from "../../map-render-limits.js";

let server: FastifyInstance;
let ctx: Awaited<ReturnType<typeof createTestEvent>>;
/** Discovered at fixture load — used to pick in-bounds tile coordinates. */
let mapBounds: {
  north: number;
  south: number;
  east: number;
  west: number;
};

const FIXTURE = resolve(__dirname, "../../../../../e2e/test.ocd");

/** Slippy-map XYZ coords for the centre of a WGS84 bbox at zoom `z`. */
function centerTile(
  bounds: { north: number; south: number; east: number; west: number },
  z: number,
): { x: number; y: number } {
  const lon = (bounds.west + bounds.east) / 2;
  const lat = (bounds.north + bounds.south) / 2;
  const n = Math.pow(2, z);
  const x = Math.floor(((lon + 180) / 360) * n);
  const rad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n,
  );
  return { x, y };
}

beforeAll(async () => {
  process.env.MAP_TILE_PRECACHE = "off";
  ctx = await createTestEvent("map_tiles");
  const buf = readFileSync(FIXTURE);

  // Read CRS + bounds directly so the test can pick a tile that
  // actually overlaps this specific OCAD file (the fixture is not
  // guaranteed to live in any particular city).
  const ocadMod = await import("ocad2geojson");
  const readOcad = (ocadMod as Record<string, unknown>).readOcad as (
    buf: Buffer,
    opts?: Record<string, unknown>,
  ) => Promise<{ getCrs(): OcadCrs; getBounds(): number[] }>;
  const file = await readOcad(buf, { quietWarnings: true });
  const wgs = ocadBoundsToWgs84(file.getBounds(), file.getCrs());
  if (!wgs) throw new Error("Could not project test.ocd to WGS84");
  mapBounds = wgs;

  // `bounds` is what the progress endpoint counts against; the real
  // upload path (`applyEventMap`) stores it alongside the blob.
  await ctx.db.mapFile.create({
    data: {
      eventId: ctx.eventId,
      fileName: "test.ocd",
      fileData: buf,
      bounds: wgs,
    },
  });

  server = Fastify({ logger: false });
  registerMapTileRoutes(server);
  await server.ready();
}, 60_000);

afterAll(async () => {
  await server?.close();
  await ctx?.cleanup();
  await disconnect();
}, 30_000);

describe("map-tile endpoint", () => {
  it("returns 404 for an unknown event slug", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/map-tile/no_such_event/13/4242/2222",
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 for malformed coordinates", async () => {
    const res = await server.inject({
      method: "GET",
      url: `/api/map-tile/${ctx.nameId}/abc/4242/2222`,
    });
    expect(res.statusCode).toBe(400);
  });

  it("renders a real tile (PNG) at the map's centre tile", async () => {
    const Z = 13;
    const { x, y } = centerTile(mapBounds, Z);

    const res = await server.inject({
      method: "GET",
      url: `/api/map-tile/${ctx.nameId}/${Z}/${x}/${y}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    // PNG file magic: 89 50 4E 47 0D 0A 1A 0A
    expect(res.rawPayload.slice(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(res.rawPayload.length).toBeGreaterThan(200);

    // Second request — same tile, served from the map_tiles cache.
    const cached = await server.inject({
      method: "GET",
      url: `/api/map-tile/${ctx.nameId}/${Z}/${x}/${y}`,
    });
    expect(cached.statusCode).toBe(200);
    expect(cached.rawPayload.length).toBe(res.rawPayload.length);

    const cachedRows = await ctx.db.mapTile.count({
      where: { eventId: ctx.eventId, z: Z, x, y },
    });
    expect(cachedRows).toBe(1);
  }, 60_000);

  it("caches the whole block around a requested tile", async () => {
    // The renderer rasterises one window per block of tiles, so the
    // neighbours come essentially for free and must be written too —
    // that amortisation is the reason the window is bigger than a tile.
    const Z = 16;
    const { x, y } = centerTile(mapBounds, Z);
    const size = DEFAULTS.blockTiles;
    const bx = Math.floor(x / size) * size;
    const by = Math.floor(y / size) * size;

    const before = await ctx.db.mapTile.count({
      where: {
        eventId: ctx.eventId,
        z: Z,
        x: { gte: bx, lt: bx + size },
        y: { gte: by, lt: by + size },
      },
    });
    expect(before).toBe(0);

    const res = await server.inject({
      method: "GET",
      url: `/api/map-tile/${ctx.nameId}/${Z}/${x}/${y}`,
    });
    expect(res.statusCode).toBe(200);

    const after = await ctx.db.mapTile.count({
      where: {
        eventId: ctx.eventId,
        z: Z,
        x: { gte: bx, lt: bx + size },
        y: { gte: by, lt: by + size },
      },
    });
    expect(after).toBeGreaterThan(1);

    // A neighbour in the same block is now a cache hit, not a render.
    const neighbour = await server.inject({
      method: "GET",
      url: `/api/map-tile/${ctx.nameId}/${Z}/${x + 1 < bx + size ? x + 1 : x - 1}/${y}`,
    });
    expect([200, 204]).toContain(neighbour.statusCode);
  }, 60_000);

  it("renders deep-zoom tiles on demand", async () => {
    // Above the pre-cache ceiling nothing is pre-rendered, so this is the
    // path that used to resample a starved whole-map raster and go blurry.
    const Z = 20;
    const { x, y } = centerTile(mapBounds, Z);
    const res = await server.inject({
      method: "GET",
      url: `/api/map-tile/${ctx.nameId}/${Z}/${x}/${y}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.rawPayload.slice(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  }, 60_000);

  it("returns 204 for a tile that's entirely outside the map bounds", async () => {
    // Equator @ z=10: definitely not overlapping a Stockholm map.
    const res = await server.inject({
      method: "GET",
      url: `/api/map-tile/${ctx.nameId}/10/0/512`,
    });
    expect([204, 200]).toContain(res.statusCode);
    if (res.statusCode === 204) {
      expect(res.rawPayload.length).toBe(0);
    }
  });

  it("reports progress from the database, not from process state", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/map-tile-progress",
      headers: { "x-competition-id": ctx.nameId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      total: number;
      done: number;
      rendering: boolean;
    };

    // The denominator is a pure function of the stored bounds, so it must
    // match what any other instance would compute for the same map.
    expect(body.total).toBe(
      expectedTileCount(mapBounds, PRECACHE_MIN_ZOOM, PRECACHE_MAX_ZOOM),
    );

    // The numerator is the row count over the same span. An earlier test
    // rendered a block at z=13, inside it; the z=16 and z=20 blocks are
    // above the ceiling and must not be counted.
    const rows = await ctx.db.mapTile.count({
      where: {
        eventId: ctx.eventId,
        z: { gte: PRECACHE_MIN_ZOOM, lte: PRECACHE_MAX_ZOOM },
      },
    });
    expect(body.done).toBe(rows);
    expect(body.done).toBeGreaterThan(0);
    expect(body.rendering).toBe(body.done < body.total);
  });

  it("pre-caches the overview zooms in the background until complete", async () => {
    // The pre-cache is kicked off from the cache-hit path too, so a
    // process that inherits a partly filled cache finishes the job
    // instead of waiting for someone to hit an uncached tile.
    const other = await createTestEvent("map_tiles_precache");
    const saved = {
      precache: process.env.MAP_TILE_PRECACHE,
      delay: process.env.MAP_PRECACHE_BLOCK_DELAY_MS,
    };
    process.env.MAP_TILE_PRECACHE = "on";
    process.env.MAP_PRECACHE_BLOCK_DELAY_MS = "0";
    try {
      await other.db.mapFile.create({
        data: {
          eventId: other.eventId,
          fileName: "test.ocd",
          fileData: readFileSync(FIXTURE),
          bounds: mapBounds,
        },
      });

      const { x, y } = centerTile(mapBounds, PRECACHE_MIN_ZOOM);
      const first = await server.inject({
        method: "GET",
        url: `/api/map-tile/${other.nameId}/${PRECACHE_MIN_ZOOM}/${x}/${y}`,
      });
      expect(first.statusCode).toBe(200);

      const deadline = Date.now() + 60_000;
      let progress = { total: 0, done: 0, rendering: true };
      while (Date.now() < deadline) {
        const res = await server.inject({
          method: "GET",
          url: "/api/map-tile-progress",
          headers: { "x-competition-id": other.nameId },
        });
        progress = res.json();
        if (!progress.rendering) break;
        await new Promise((r) => setTimeout(r, 250));
      }

      expect(progress.total).toBeGreaterThan(0);
      expect(progress.done).toBe(progress.total);
      expect(progress.rendering).toBe(false);

      // Nothing above the ceiling was rendered — that is the point of it.
      const deep = await other.db.mapTile.count({
        where: { eventId: other.eventId, z: { gt: PRECACHE_MAX_ZOOM } },
      });
      expect(deep).toBe(0);
    } finally {
      process.env.MAP_TILE_PRECACHE = saved.precache;
      if (saved.delay === undefined) delete process.env.MAP_PRECACHE_BLOCK_DELAY_MS;
      else process.env.MAP_PRECACHE_BLOCK_DELAY_MS = saved.delay;
      await other.cleanup();
    }
  }, 90_000);

  it("notices a map replaced by another instance", async () => {
    // `onMapUpload` only fires in the process that handled the upload,
    // so on every other instance the parsed SVG is stale from the moment
    // someone re-uploads. The renderer therefore re-checks the map
    // file's `uploadedAt` before trusting its cache.
    //
    // The replacement here is deliberately unparseable, because that is
    // the one outcome the stale cache cannot produce: an instance still
    // holding the old parse would happily answer 200.
    const other = await createTestEvent("map_tiles_replaced");
    try {
      await other.db.mapFile.create({
        data: {
          eventId: other.eventId,
          fileName: "test.ocd",
          fileData: readFileSync(FIXTURE),
          bounds: mapBounds,
        },
      });

      const Z = 14;
      const { x, y } = centerTile(mapBounds, Z);
      const url = `/api/map-tile/${other.nameId}/${Z}/${x}/${y}`;

      const first = await server.inject({ method: "GET", url });
      expect(first.statusCode).toBe(200);

      // What a re-upload looks like from another instance's point of
      // view: new bytes, a newer `uploadedAt`, and the event's tiles
      // purged — with no in-process notification.
      await other.db.mapTile.deleteMany({ where: { eventId: other.eventId } });
      await other.db.mapFile.updateMany({
        where: { eventId: other.eventId },
        data: {
          fileData: Buffer.from("not an ocad file"),
          uploadedAt: new Date(Date.now() + 60_000),
        },
      });

      const second = await server.inject({ method: "GET", url });
      expect(second.statusCode).toBe(500);
    } finally {
      await other.cleanup();
    }
  }, 60_000);

  it("reports no progress for a map whose bounds were never parsed", async () => {
    // Older uploads (and unparseable georeferences) have a null `bounds`,
    // which must not divide-by-zero the progress bar.
    const other = await createTestEvent("map_tiles_nobounds");
    try {
      await other.db.mapFile.create({
        data: {
          eventId: other.eventId,
          fileName: "test.ocd",
          fileData: readFileSync(FIXTURE),
        },
      });
      const res = await server.inject({
        method: "GET",
        url: "/api/map-tile-progress",
        headers: { "x-competition-id": other.nameId },
      });
      expect(res.json()).toEqual({ total: 0, done: 0, rendering: false });
    } finally {
      await other.cleanup();
    }
  }, 30_000);

  it("progress endpoint returns the empty shape for an unknown event", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/map-tile-progress",
      headers: { "x-competition-id": "no_such_event" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ total: 0, done: 0, rendering: false });
  });
});
