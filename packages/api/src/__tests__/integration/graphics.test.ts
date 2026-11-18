/**
 * The graphics library (J2, docs/course-maps.md "Data model" and "API"):
 *   - upload keeps a PNG that fits byte for byte and records its pixel size
 *   - a PNG over 4096 px is stored resampled to 4096 on its longer side
 *   - `graphics.list` answers the size and fills a NULL size once (the backfill)
 *   - `saveToClub` copies the size
 *   - `thumb.png` (PNG and SVG): ≤ 256 px, aspect kept, immutable cache
 *   - the three graphic routes answer the event's kiosk key (user 2026-11-18, Q2)
 */
import { randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerCourseMapRoutes } from "../../course-maps/routes.js";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";

const suffix = randomBytes(4).toString("hex");
const KIOSK = `kiosk-graphics-${suffix}`;
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><rect width="40" height="20" fill="#c00"/></svg>');

let ctx: TestEventContext;
let caller: ReturnType<typeof makeCaller>;
let server: FastifyInstance;
let previousAuthMode: string | undefined;
const clubIds: bigint[] = [];

const png = (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 4, background: { r: 0, g: 160, b: 0, alpha: 0.5 } } }).png().toBuffer();
const upload = async (name: string, data: Buffer) => caller.graphics.upload({ name, scope: "event", fileDataBase64: data.toString("base64") });
const get = (url: string, headers: Record<string, string> = {}) => server.inject({ method: "GET", url, headers });

beforeAll(async () => {
  ctx = await createTestEvent("graphics");
  await ctx.db.event.update({ where: { id: ctx.eventId }, data: { kioskKey: KIOSK } });
  ctx.event.kioskKey = KIOSK;
  caller = makeCaller(ctx.event);
  server = Fastify({ logger: false });
  registerCourseMapRoutes(server);
  await server.ready();
}, 60_000);

afterAll(async () => {
  if (previousAuthMode === undefined) delete process.env.AUTH_MODE;
  else process.env.AUTH_MODE = previousAuthMode;
  await server?.close();
  await ctx?.db.graphic.deleteMany({ where: { id: { in: clubIds } } });
  await ctx?.cleanup();
  await disconnect();
});

describe("graphics library sizes (J2)", () => {
  it("stores a PNG that fits as uploaded, with its pixel size", async () => {
    const data = await png(40, 20);
    const row = await upload("door", data);
    expect(row).toMatchObject({ mime: "image/png", sizeBytes: data.byteLength, widthPx: 40, heightPx: 20, club: false });
    const held = await ctx.db.graphic.findUniqueOrThrow({ where: { id: BigInt(row.id) } });
    expect(Buffer.from(held.data).equals(data)).toBe(true);
  });

  it("resamples a PNG over 4096 px to 4096 on its longer side", async () => {
    const row = await upload("wide", await png(6000, 1500));
    expect([row.widthPx, row.heightPx]).toEqual([4096, 1024]);
    const held = await ctx.db.graphic.findUniqueOrThrow({ where: { id: BigInt(row.id) } });
    const meta = await sharp(Buffer.from(held.data)).metadata();
    expect([meta.width, meta.height, meta.hasAlpha]).toEqual([4096, 1024, true]);
    expect(held.sizeBytes).toBe(held.data.byteLength);
  }, 60_000);

  it("records an SVG at its viewBox scaled to 4096 px", async () => {
    const row = await upload("svg", SVG);
    expect([row.widthPx, row.heightPx]).toEqual([4096, 2048]);
  });

  it("fills a NULL size the first time the list reads it", async () => {
    const id = (await ctx.db.graphic.create({ data: { eventId: ctx.eventId, name: "old.svg", mime: "image/svg+xml", data: SVG, sizeBytes: SVG.length } })).id;
    expect((await ctx.db.graphic.findUniqueOrThrow({ where: { id } })).widthPx).toBeNull();
    const listed = (await caller.graphics.list()).find((g) => g.id === Number(id));
    expect([listed?.widthPx, listed?.heightPx]).toEqual([4096, 2048]);
    const held = await ctx.db.graphic.findUniqueOrThrow({ where: { id } });
    expect([held.widthPx, held.heightPx]).toEqual([4096, 2048]);
  });

  it("copies the size into the club library", async () => {
    const row = await upload("door2", await png(30, 60));
    const copy = await caller.graphics.saveToClub({ id: row.id });
    clubIds.push(BigInt(copy.id));
    expect(copy).toMatchObject({ club: true, widthPx: 30, heightPx: 60 });
  });
});

describe("thumb.png (J2)", () => {
  it("answers a PNG at most 256 px, aspect kept, immutable", async () => {
    const row = await upload("big", await png(1024, 512));
    const res = await get(`/api/maps/${ctx.nameId}/graphics/${row.id}/thumb.png`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["cache-control"]).toContain("immutable");
    const meta = await sharp(res.rawPayload).metadata();
    expect([meta.width, meta.height, meta.hasAlpha]).toEqual([256, 128, true]);
  });

  it("never enlarges a small PNG", async () => {
    const row = await upload("small", await png(40, 20));
    const meta = await sharp((await get(`/api/maps/${ctx.nameId}/graphics/${row.id}/thumb.png`)).rawPayload).metadata();
    expect([meta.width, meta.height]).toEqual([40, 20]);
  });

  it("rasterises an SVG", async () => {
    const row = await upload("svg-thumb", SVG);
    const res = await get(`/api/maps/${ctx.nameId}/graphics/${row.id}/thumb.png`);
    expect(res.statusCode).toBe(200);
    const meta = await sharp(res.rawPayload).metadata();
    expect([meta.width, meta.height]).toEqual([256, 128]);
  }, 60_000);

  it("answers 400 and 404 for bad and unknown ids", async () => {
    expect((await get(`/api/maps/${ctx.nameId}/graphics/x/thumb.png`)).statusCode).toBe(400);
    expect((await get(`/api/maps/${ctx.nameId}/graphics/999999999/thumb.png`)).statusCode).toBe(404);
  });
});

describe("the event's kiosk key reads graphics (Q2)", () => {
  it("serves the bytes, print.png and thumb.png to the kiosk key, and 401 without", async () => {
    const row = await upload("kiosk", await png(8, 4));
    previousAuthMode = process.env.AUTH_MODE;
    process.env.AUTH_MODE = "proxy";
    try {
      for (const path of ["", "/print.png", "/thumb.png"]) {
        const url = `/api/maps/${ctx.nameId}/graphics/${row.id}${path}`;
        expect((await get(url, { "x-kiosk-key": KIOSK })).statusCode).toBe(200);
        expect((await get(`${url}?k=${KIOSK}`)).statusCode).toBe(200);
        expect((await get(url)).statusCode).toBe(401);
        expect((await get(url, { "x-kiosk-key": "wrong" })).statusCode).toBe(401);
      }
    } finally {
      if (previousAuthMode === undefined) delete process.env.AUTH_MODE;
      else process.env.AUTH_MODE = previousAuthMode;
    }
  });
});
