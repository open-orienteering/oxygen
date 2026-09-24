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
 *   - an off-bounds tile returns a 200 transparent PNG
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
import {
  RENDER_BUSY_RETRY_AFTER_S,
  registerMapTileRoutes,
} from "../../map-tiles.js";
import { createTestEvent, disconnect } from "../helpers/test-db.js";
import { ensureEventMapRenderKey, gcOrphanTiles } from "../../map-render-cache.js";
import { makeCaller } from "../helpers/caller.js";
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

async function eventRenderKey(eventId: bigint): Promise<string> {
  const meta = await ensureEventMapRenderKey(ctx.db, eventId);
  if (!meta?.renderKey) throw new Error("missing renderKey");
  return meta.renderKey;
}

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
    // Stacked tile: composite (top) + ink (bottom) = 256×512.
    const { default: sharp } = await import("sharp");
    const meta = await sharp(res.rawPayload).metadata();
    expect(meta.width).toBe(256);
    expect(meta.height).toBe(512);
    // Ink half (bottom) must carry some opaque pixels — black paths /
    // blue north lines from the fixture colour stack.
    const ink = await sharp(res.rawPayload)
      .extract({ left: 0, top: 256, width: 256, height: 256 })
      .ensureAlpha()
      .raw()
      .toBuffer();
    let opaque = 0;
    for (let i = 3; i < ink.length; i += 4) {
      if (ink[i]! > 0) opaque += 1;
    }
    expect(opaque).toBeGreaterThan(100);

    // Second request — same tile, served from the map_tiles cache.
    const cached = await server.inject({
      method: "GET",
      url: `/api/map-tile/${ctx.nameId}/${Z}/${x}/${y}`,
    });
    expect(cached.statusCode).toBe(200);
    expect(cached.rawPayload.length).toBe(res.rawPayload.length);

    const cachedRows = await ctx.db.mapTile.count({
      where: { renderKey: await eventRenderKey(ctx.eventId), z: Z, x, y },
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

    const renderKey = await eventRenderKey(ctx.eventId);
    const before = await ctx.db.mapTile.count({
      where: {
        renderKey,
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
        renderKey,
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

  it("refuses with 503 + Retry-After when the render queue is full, then serves the tile on retry", async () => {
    // Cloud Run holds a request for up to 300 s. With an unbounded queue a
    // cold viewport queued far past that and every tile 504'd (September
    // 2026). With the bound, surplus requests get an immediate 503 and the
    // client's retry book comes back after Retry-After.
    const savedQueue = process.env.MAP_RENDER_MAX_QUEUE;
    process.env.MAP_RENDER_MAX_QUEUE = "0";
    try {
      // Distinct, never-rendered blocks: the first `renderConcurrency`
      // take the permits, the surplus must be refused rather than queued.
      const Z = 18;
      const { x, y } = centerTile(mapBounds, Z);
      const size = DEFAULTS.blockTiles;
      // Four blocks hugging the map centre so they all intersect the map
      // (a block entirely off-map is answered without touching the gate).
      const blocks = [
        { x, y },
        { x: x - size, y },
        { x, y: y - size },
        { x: x - size, y: y - size },
      ];
      const results = await Promise.all(
        blocks.map((b) =>
          server.inject({
            method: "GET",
            url: `/api/map-tile/${ctx.nameId}/${Z}/${b.x}/${b.y}`,
          }),
        ),
      );
      const statuses = results.map((r) => r.statusCode);
      expect(statuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(
        DEFAULTS.renderConcurrency,
      );
      const refused = results.filter((r) => r.statusCode === 503);
      expect(refused.length).toBeGreaterThanOrEqual(1);
      expect(statuses.filter((s) => s !== 200 && s !== 503)).toEqual([]);
      for (const r of refused) {
        expect(Number(r.headers["retry-after"])).toBe(RENDER_BUSY_RETRY_AFTER_S);
        expect(r.headers["cache-control"]).toBe("no-store");
        expect(r.json()).toMatchObject({ error: "Map renderer busy" });
      }

      // Once the queue drains the same tile renders normally.
      const retry = await server.inject({
        method: "GET",
        url: `/api/map-tile/${ctx.nameId}/${Z}/${blocks.at(-1)!.x}/${blocks.at(-1)!.y}`,
      });
      expect(retry.statusCode).toBe(200);
      expect(retry.headers["content-type"]).toBe("image/png");
    } finally {
      if (savedQueue === undefined) delete process.env.MAP_RENDER_MAX_QUEUE;
      else process.env.MAP_RENDER_MAX_QUEUE = savedQueue;
    }
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

  it("returns a transparent PNG for a tile that's entirely outside the map bounds", async () => {
    // Equator @ z=10: definitely not overlapping a Stockholm map.
    const res = await server.inject({
      method: "GET",
      url: `/api/map-tile/${ctx.nameId}/10/0/512`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.rawPayload.slice(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    // Decode the actual pixel: it must be fully transparent. A previous
    // version of the placeholder constant accidentally encoded
    // RGBA(255,0,0,127) and painted red bands around every map.
    const { inflateSync } = await import("node:zlib");
    const png = res.rawPayload;
    let pos = 8;
    let pixel: Buffer | null = null;
    while (pos < png.length) {
      const len = png.readUInt32BE(pos);
      const type = png.subarray(pos + 4, pos + 8).toString("ascii");
      if (type === "IHDR") {
        expect(png.readUInt32BE(pos + 8)).toBe(1); // width
        expect(png.readUInt32BE(pos + 12)).toBe(1); // height
      }
      if (type === "IDAT") {
        const raw = inflateSync(png.subarray(pos + 8, pos + 8 + len));
        pixel = raw.subarray(1, 5); // skip scanline filter byte
      }
      pos += 12 + len;
    }
    expect(pixel).not.toBeNull();
    expect(Array.from(pixel!)).toEqual([0, 0, 0, 0]);
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
        renderKey: await eventRenderKey(ctx.eventId),
        z: { gte: PRECACHE_MIN_ZOOM, lte: PRECACHE_MAX_ZOOM },
      },
    });
    expect(body.done).toBe(rows);
    expect(body.done).toBeGreaterThan(0);
    expect(body.rendering).toBe(body.done < body.total);
  });

  it("advances the pre-cache from the progress poll alone", async () => {
    // Cloud Run throttles CPU outside request handling, so the detached
    // background loop stalls once tile requests stop. The progress
    // endpoint therefore renders a bounded chunk itself. Proven here by
    // never requesting a tile: nothing calls `kickOffPreCache`, so any
    // progress at all can only have come from the poll.
    const other = await createTestEvent("map_tiles_chunk");
    const saved = process.env.MAP_TILE_PRECACHE;
    process.env.MAP_TILE_PRECACHE = "on";
    try {
      await other.db.mapFile.create({
        data: {
          eventId: other.eventId,
          fileName: "test.ocd",
          fileData: readFileSync(FIXTURE),
          bounds: mapBounds,
        },
      });

      const poll = async () => {
        const res = await server.inject({
          method: "GET",
          url: "/api/map-tile-progress",
          headers: { "x-competition-id": other.nameId },
        });
        expect(res.statusCode).toBe(200);
        return res.json() as {
          total: number;
          done: number;
          rendering: boolean;
        };
      };

      const first = await poll();
      expect(first.total).toBeGreaterThan(0);
      expect(first.done).toBeGreaterThan(0);
      expect(first.rendering).toBe(true);

      // Each poll picks up where the last left off rather than redoing
      // the same block.
      const second = await poll();
      expect(second.done).toBeGreaterThan(first.done);
    } finally {
      process.env.MAP_TILE_PRECACHE = saved;
      await other.cleanup();
    }
  }, 90_000);

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
      const caller = makeCaller(other.event);
      await caller.course.uploadMap({
        fileName: "test.ocd",
        fileDataBase64: readFileSync(FIXTURE).toString("base64"),
      });
      // Unique stack settings so this event's render_key does not share
      // deep-zoom tiles rendered earlier by the suite's primary event.
      await caller.course.setMapColorStack({
        overrides: { above: [424242] },
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
        where: {
          renderKey: (await ensureEventMapRenderKey(other.db, other.eventId))!
            .renderKey,
          z: { gt: PRECACHE_MAX_ZOOM },
        },
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
      // view: new bytes, a newer `uploadedAt`, and the old render_key
      // cleared — with no in-process notification.
      const oldKey = (await ensureEventMapRenderKey(other.db, other.eventId))!
        .renderKey;
      await other.db.mapTile.deleteMany({ where: { renderKey: oldKey } });
      await other.db.mapFile.updateMany({
        where: { eventId: other.eventId },
        data: {
          fileData: Buffer.from("not an ocad file"),
          fileHash: null,
          renderKey: null,
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

  it("two events with the same map blob share tile rows", async () => {
    const a = await createTestEvent("map_tiles_share_a");
    const b = await createTestEvent("map_tiles_share_b");
    try {
      const buf = readFileSync(FIXTURE);
      const callerA = makeCaller(a.event);
      const callerB = makeCaller(b.event);
      await callerA.course.uploadMap({
        fileName: "test.ocd",
        fileDataBase64: buf.toString("base64"),
      });
      await callerB.course.uploadMap({
        fileName: "test.ocd",
        fileDataBase64: buf.toString("base64"),
      });
      const keyA = (await ensureEventMapRenderKey(a.db, a.eventId))!.renderKey;
      const keyB = (await ensureEventMapRenderKey(b.db, b.eventId))!.renderKey;
      expect(keyA).toBe(keyB);

      const Z = 13;
      const { x, y } = centerTile(mapBounds, Z);
      const first = await server.inject({
        method: "GET",
        url: `/api/map-tile/${a.nameId}/${Z}/${x}/${y}`,
      });
      expect(first.statusCode).toBe(200);
      const rowsAfterA = await a.db.mapTile.count({
        where: { renderKey: keyA, z: Z, x, y },
      });
      expect(rowsAfterA).toBe(1);

      const second = await server.inject({
        method: "GET",
        url: `/api/map-tile/${b.nameId}/${Z}/${x}/${y}`,
      });
      expect(second.statusCode).toBe(200);
      expect(second.rawPayload.length).toBe(first.rawPayload.length);
      // Still one row — B hit A's cache.
      expect(
        await a.db.mapTile.count({ where: { renderKey: keyA, z: Z, x, y } }),
      ).toBe(1);
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  }, 90_000);

  it("changing colour profile yields a new key; GC drops unreferenced tiles", async () => {
    const ev = await createTestEvent("map_tiles_profile");
    try {
      const caller = makeCaller(ev.event);
      await caller.course.uploadMap({
        fileName: "test.ocd",
        fileDataBase64: readFileSync(FIXTURE).toString("base64"),
      });
      // Mint a unique key so the suite's primary event (same blob + auto)
      // does not keep the old key alive after we switch profile.
      await caller.course.setMapColorStack({
        overrides: { above: [777001] },
      });
      const oldKey = (await ensureEventMapRenderKey(ev.db, ev.eventId))!
        .renderKey;
      const Z = 13;
      const { x, y } = centerTile(mapBounds, Z);
      await server.inject({
        method: "GET",
        url: `/api/map-tile/${ev.nameId}/${Z}/${x}/${y}`,
      });
      expect(
        await ev.db.mapTile.count({ where: { renderKey: oldKey, z: Z, x, y } }),
      ).toBe(1);

      const result = await caller.course.setMapColorStack({ profile: "issprom" });
      expect(result.renderKey).not.toBe(oldKey);
      await gcOrphanTiles(ev.db);
      expect(
        await ev.db.mapTile.count({ where: { renderKey: oldKey } }),
      ).toBe(0);

      const meta = await caller.course.mapMetadata();
      expect(meta?.renderKey).toBe(result.renderKey);
      expect(meta?.colorProfile).toBe("issprom");
      expect(meta?.cutRotationDeg).toBeDefined();
    } finally {
      await ev.cleanup();
    }
  }, 90_000);

  it("club-library map keeps tiles after the event drops the map", async () => {
    const clubCaller = makeCaller(null);
    const uploaded = await clubCaller.clubMap.upload({
      fileName: "test.ocd",
      fileDataBase64: readFileSync(FIXTURE).toString("base64"),
    });
    const ev = await createTestEvent("map_tiles_club_keep");
    try {
      const caller = makeCaller(ev.event);
      await caller.course.useClubMap({ clubMapId: uploaded.id });
      const key = (await ensureEventMapRenderKey(ev.db, ev.eventId))!.renderKey;
      const Z = 13;
      const { x, y } = centerTile(mapBounds, Z);
      await server.inject({
        method: "GET",
        url: `/api/map-tile/${ev.nameId}/${Z}/${x}/${y}`,
      });
      expect(
        await ev.db.mapTile.count({ where: { renderKey: key, z: Z, x, y } }),
      ).toBe(1);

      await ev.cleanup();
      await gcOrphanTiles(ev.db);
      // Club library still references the key → tiles survive.
      expect(
        await ev.db.mapTile.count({ where: { renderKey: key, z: Z, x, y } }),
      ).toBe(1);
    } finally {
      await clubCaller.clubMap.remove({ id: uploaded.id });
      await gcOrphanTiles(ev.db);
    }
  }, 90_000);
});
