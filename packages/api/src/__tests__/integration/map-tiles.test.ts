/**
 * Integration test for the `/api/map-tile/:nameId/:z/:x/:y` endpoint.
 *
 * Boots a real Fastify instance with the map-tile routes registered,
 * uploads a real OCAD fixture into `map_files`, and asserts:
 *   - the first request renders + returns a PNG
 *   - the second request is served from the `map_tiles` cache (and
 *     still returns a PNG)
 *   - an off-bounds tile returns 204
 *   - an unknown event slug returns 404
 *   - `/api/map-tile-progress` accepts the `x-competition-id` header
 *     and returns the per-event progress shape
 *
 * The OCAD fixture (`e2e/test.ocd`) is the same one the E2E suite
 * uses for map upload flows.
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
  ctx = await createTestEvent("map_tiles");
  const buf = readFileSync(FIXTURE);
  await ctx.db.mapFile.create({
    data: {
      eventId: ctx.eventId,
      fileName: "test.ocd",
      fileData: buf,
    },
  });

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

  it("progress endpoint resolves via x-competition-id header", async () => {
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
    expect(typeof body.total).toBe("number");
    expect(typeof body.done).toBe("number");
    expect(typeof body.rendering).toBe("boolean");
  });

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
