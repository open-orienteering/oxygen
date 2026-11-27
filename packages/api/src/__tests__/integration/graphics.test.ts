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
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

  it("marks bytes that cannot be sized 0 × 0 once and answers no size; the version is stable after", async () => {
    const id = (await ctx.db.graphic.create({ data: { eventId: ctx.eventId, name: "broken.png", mime: "image/png", data: Buffer.from("not a png"), sizeBytes: 9 } })).id;
    const listed = (await caller.graphics.list()).find((g) => g.id === Number(id));
    expect([listed?.widthPx, listed?.heightPx]).toEqual([null, null]);
    const held = await ctx.db.graphic.findUniqueOrThrow({ where: { id } });
    expect([held.widthPx, held.heightPx]).toEqual([0, 0]);
    const again = (await caller.graphics.list()).find((g) => g.id === Number(id));
    expect(again?.version).toBe(listed?.version);
  });

  it("the migration's SQL backfill sizes a PNG from its IHDR", async () => {
    const data = await png(37, 11);
    const id = (await ctx.db.graphic.create({ data: { eventId: ctx.eventId, name: "old.png", mime: "image/png", data, sizeBytes: data.length } })).id;
    const sql = readFileSync(resolve(__dirname, "../../../prisma/migrations/20261119120000_graphics_pixel_size/migration.sql"), "utf8");
    const update = sql.slice(sql.indexOf("UPDATE")).trim().replace(/;$/, "");
    await ctx.db.$executeRawUnsafe(`${update} AND "id" = ${id}`);
    const held = await ctx.db.graphic.findUniqueOrThrow({ where: { id } });
    expect([held.widthPx, held.heightPx]).toEqual([37, 11]);
  });

  it("answers a content version that changes when an id's bytes are replaced", async () => {
    const row = await upload("replaced", await png(8, 8));
    const before = (await caller.graphics.list()).find((g) => g.id === row.id)!.version;
    const other = await png(9, 9);
    await ctx.db.graphic.update({ where: { id: BigInt(row.id) }, data: { data: other, sizeBytes: other.length } });
    const after = (await caller.graphics.list()).find((g) => g.id === row.id)!.version;
    expect(after).not.toBe(before);
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
      // A club graphic too (answer 15: the key reads any club graphic by id).
      const club = await caller.graphics.saveToClub({ id: row.id });
      clubIds.push(BigInt(club.id));
      expect((await get(`/api/maps/${ctx.nameId}/graphics/${club.id}/thumb.png`, { "x-kiosk-key": KIOSK })).statusCode).toBe(200);
      // Another event's key does not read this event's graphic, nor this key the other's.
      const other = await createTestEvent("graphics_other");
      try {
        const OTHER = `kiosk-other-${suffix}`;
        await other.db.event.update({ where: { id: other.eventId }, data: { kioskKey: OTHER } });
        const theirs = (await other.db.graphic.create({ data: { eventId: other.eventId, name: "theirs.png", mime: "image/png", data: await png(4, 4), sizeBytes: 1 } })).id;
        expect((await get(`/api/maps/${ctx.nameId}/graphics/${row.id}`, { "x-kiosk-key": OTHER })).statusCode).toBe(401);
        expect((await get(`/api/maps/${other.nameId}/graphics/${row.id}`, { "x-kiosk-key": OTHER })).statusCode).toBe(404);
        expect((await get(`/api/maps/${ctx.nameId}/graphics/${theirs}`, { "x-kiosk-key": KIOSK })).statusCode).toBe(404);
      } finally {
        await other.cleanup();
      }
    } finally {
      if (previousAuthMode === undefined) delete process.env.AUTH_MODE;
      else process.env.AUTH_MODE = previousAuthMode;
    }
  });
});

describe("served graphics cannot run script (CRS-003 / API-31)", () => {
  const CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

  it("sends a sandboxing CSP and nosniff on the raw bytes, print.png and thumb.png; an SVG downloads", async () => {
    const svg = await upload("hostile-safe", SVG);
    const raster = await upload("raster", await png(8, 4));
    for (const row of [svg, raster]) {
      for (const path of ["", "/print.png?w=40&h=20", "/thumb.png"]) {
        // print.png of a PNG ignores w/h; of an SVG it needs them.
        const res = await get(`/api/maps/${ctx.nameId}/graphics/${row.id}${path}`);
        expect(res.statusCode, `${row.id}${path}`).toBe(200);
        expect(res.headers["content-security-policy"], `${row.id}${path}`).toBe(CSP);
        expect(res.headers["x-content-type-options"], `${row.id}${path}`).toBe("nosniff");
      }
    }
    const rawSvg = await get(`/api/maps/${ctx.nameId}/graphics/${svg.id}`);
    expect(rawSvg.headers["content-type"]).toContain("image/svg+xml");
    expect(rawSvg.headers["content-disposition"]).toBe(`attachment; filename="graphic-${svg.id}.svg"`);
    // A PNG is not a document: no download prompt.
    expect((await get(`/api/maps/${ctx.nameId}/graphics/${raster.id}`)).headers["content-disposition"]).toBeUndefined();
  });

  it("refuses an SVG whose script hides in a comment or a character reference at upload", async () => {
    const wrap = (inner: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4">${inner}</svg>`);
    for (const inner of ["<metadata><script>alert(1)</script></metadata>", "&#60;script>alert(1)&#60;/script>", '<image href="//evil.example/x.png"/>']) {
      await expect(upload("bad", wrap(inner)), inner).rejects.toThrow(/The SVG must not contain/);
    }
  });
});
