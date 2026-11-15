/**
 * The DEM job and its artifacts (docs/map-storage.md §4.7 "The DEM job";
 * docs/map-terrain.md §7): import stage 10 queues the job, which fetches
 * the provider's tiles by range, derives the ground and anchored fields
 * and writes the two `map_heightfields` rows with licence and attribution;
 * the job's failure states and retries; Lantmäteriet's no-coverage
 * falling to GLO-30; the route's `?source=`; the descriptor's `dem` block;
 * the GC and the cascade.
 *
 * Fixture: the recorded DEM fixture (`helpers/dem-fixture.ts`) — synthetic
 * Lantmäteriet and GLO-30 tiles behind a fake STAC and range server. No
 * request leaves the process. Documents are the terrain helper's hill,
 * placed in SWEREF 99 TM, inserted directly.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createHash, randomBytes } from "crypto";
import { brotliDecompressSync } from "zlib";
import Fastify, { type FastifyInstance } from "fastify";
import { mapDocument } from "@oxygen/shared";
import { decodeHeightField, sampleHeight, TERRAIN_VERSION } from "@oxygen/shared/src/terrain/field/index.js";
import { createTestEvent, type TestEventContext } from "../helpers/test-db.js";
import { FLAT, HILL, encodeTerrainDoc, sweref99 } from "../helpers/terrain-doc.js";
import { CONE_TOP, GLO_ORIGIN, LM_ORIGIN, TEST_CREDENTIAL, demFixture, type DemFixture } from "../helpers/dem-fixture.js";
import { deriveDocumentArtifacts } from "../../map-store/jobs.js";
import { configureDemEngine, DEM_JOB_RULES, demOverCapOf, enqueueDocumentDem, getDemJob, kickDemJobs, requeueAuthFailures, requeueOverCap } from "../../map-store/dem-jobs.js";
import { deriveDemFields } from "../../map-store/dem-worker.js";
import { setDemProviders } from "../../map-store/dem-registry.js";
import { readHeightfield, resetHeightfieldState, terrainDescriptor, terrainReview } from "../../map-store/heightfield.js";
import { registerMapHeightfieldRoutes } from "../../map-store/heightfield-routes.js";
import { MAP_DOCUMENT_CACHE_CONTROL, resetDocumentAccessCache } from "../../map-store/routes.js";
import { clearEventDocumentCaches } from "../../map-store/event-document.js";
import { runStorageGc } from "../../map-store/gc.js";

const suffix = randomBytes(4).toString("hex");
const EMAIL_DOMAIN = `@map-dem-${suffix}.example`;
const LM = "lantmateriet-2m", GLO = "glo30-30m";

let ctx: TestEventContext;
let server: FastifyInstance;
let fx: DemFixture;
let previousAuthMode: string | undefined;
let sourceHash = "";
let clubMapId = "";
let seq = 0;
const docs: string[] = [];

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const get = (url: string, headers: Record<string, string> = {}) => server.inject({ method: "GET", url, headers });
const url = (hash: string, source?: string, v: number = TERRAIN_VERSION) => `/api/map-documents/${hash}/height.bin?v=${v}${source ? `&source=${source}` : ""}`;
let signedIn: Record<string, string> = {};

/** A document inserted directly and visible to signed-in users through a club-library version. */
async function insertDoc(objects: Parameters<typeof encodeTerrainDoc>[0], name: string, georef?: Parameters<typeof encodeTerrainDoc>[3]): Promise<string> {
  const bytes = encodeTerrainDoc(objects, `${name}-${suffix}`, sourceHash, georef);
  const hash = sha(bytes);
  const { header } = mapDocument.readMapDocumentHeader(bytes);
  await ctx.db.mapDocument.create({
    data: { hash, bytes, sizeBytes: bytes.byteLength, formatVersion: 1, importerVersion: "test", libraryVersion: "none", sourceHash, header: JSON.parse(JSON.stringify({ ...header, symbols: undefined, strings: undefined })), report: {} },
  });
  await ctx.db.clubMapVersion.create({ data: { clubMapId, seq: ++seq, sourceHash, documentHash: hash } });
  docs.push(hash);
  return hash;
}

const jobs = (hash: string) => ctx.db.mapDemJob.findMany({ where: { documentHash: hash }, orderBy: { createdAt: "asc" } });

/** Runs the engine until the document has jobs, none queued or running, and no fallback job appears after them. */
async function settle(hash: string): Promise<Awaited<ReturnType<typeof jobs>>> {
  let quiet = 0, last = -1;
  for (let i = 0; i < 80; i++) {
    await kickDemJobs(ctx.db);
    const rows = await jobs(hash);
    const done = rows.length > 0 && rows.every((r) => r.state !== "queued" && r.state !== "running");
    quiet = done && rows.length === last ? quiet + 1 : 0;
    last = rows.length;
    if (quiet >= 2) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`DEM jobs of ${hash} did not settle: ${JSON.stringify(await jobs(hash))}`);
}

beforeAll(async () => {
  ctx = await createTestEvent("map_dem");
  const user = await ctx.db.user.create({ data: { email: `viewer${EMAIL_DOMAIN}`, displayName: "viewer", active: true } });
  signedIn = { "x-forwarded-email": user.email };
  const src = Buffer.from(`dem-source-${suffix}`);
  sourceHash = sha(src);
  await ctx.db.mapSource.create({ data: { fileHash: sourceHash, kind: "ocad", bytes: src, sizeBytes: src.byteLength, fileName: "dem.ocd" } });
  clubMapId = (await ctx.db.clubMap.create({ data: { name: `DEM ${suffix}` } })).id;
  server = Fastify({ logger: false });
  registerMapHeightfieldRoutes(server);
  await server.ready();
  previousAuthMode = process.env.AUTH_MODE;
  process.env.AUTH_MODE = "proxy";
  resetDocumentAccessCache();
  // in-process derive: the worker thread has its unit test (map-dem-worker.test.ts)
  configureDemEngine({ derive: async (d) => deriveDemFields(d) });
}, 120_000);

beforeEach(() => {
  fx = demFixture();
  setDemProviders(fx.providers());
  resetHeightfieldState();
  clearEventDocumentCaches();
});

afterAll(async () => {
  setDemProviders([]);
  configureDemEngine({});
  if (previousAuthMode === undefined) delete process.env.AUTH_MODE;
  else process.env.AUTH_MODE = previousAuthMode;
  await server?.close();
  await ctx.cleanup();
  await ctx.db.clubMap.deleteMany({ where: { id: clubMapId } });
  await ctx.db.mapDocument.deleteMany({ where: { sourceHash } });
  await ctx.db.mapSource.deleteMany({ where: { fileHash: sourceHash } });
  await ctx.db.user.deleteMany({ where: { email: { endsWith: EMAIL_DOMAIN } } });
});

describe("the DEM job at import stage 10 (map-storage.md §4.7)", () => {
  let hill = "";

  it("queues the job, fetches by range with the credential on Lantmäteriet only, and writes both rows", async () => {
    hill = await insertDoc(HILL, "hill", sweref99(LM_ORIGIN.e, LM_ORIGIN.n));
    await deriveDocumentArtifacts(ctx.db, hill);
    const [job] = await settle(hill);
    expect(job).toMatchObject({ provider: LM, version: TERRAIN_VERSION, state: "done", reason: null, error: null, attempts: 1 });

    const ground = (await readHeightfield(ctx.db, hill, TERRAIN_VERSION, `ground.${LM}`))!;
    const anchored = (await readHeightfield(ctx.db, hill, TERRAIN_VERSION, `contours.${LM}`))!;
    const contours = (await readHeightfield(ctx.db, hill))!;
    for (const row of [ground, anchored]) {
      expect(row.header).toMatchObject({ datum: "absolute", provider: { id: LM, licence: "CC BY 4.0", attribution: "© Lantmäteriet", grade: "anchor", verticalDatum: "RH 2000" } });
      const h = row.header!, c = contours.header!;
      expect([h.cellMm, h.x0, h.y0, h.width, h.height]).toEqual([c.cellMm, c.x0, c.y0, c.width, c.height]);
    }
    const g = decodeHeightField(ground.bytes!), a = decodeHeightField(anchored.bytes!);
    for (const r of [7.5, 12.5, 17.5]) {
      expect(Math.abs(sampleHeight(g, { x: 30 + r, y: 30 })! - (CONE_TOP - r))).toBeLessThan(0.15);
      expect(Math.abs(sampleHeight(a, { x: 30 - r, y: 30 })! - (CONE_TOP - r))).toBeLessThan(0.5);
    }
    expect(ground.report).toMatchObject({ dem: { provider: LM, tiles: 1, tilesRead: 1, dataShare: 1 } });
    expect(anchored.report).toMatchObject({ anchor: { source: LM, grade: "anchor" }, share: { decided: expect.any(Number) } });

    const stac = fx.requests.filter((r) => r.url.includes("/search?"));
    const tile = fx.requests.filter((r) => r.url.endsWith(".tif"));
    expect(stac.length).toBe(1);
    expect(stac[0].authorization).toBe(`Basic ${Buffer.from(TEST_CREDENTIAL).toString("base64")}`);
    expect(tile.length).toBeGreaterThan(0);
    expect(tile.every((r) => r.range?.startsWith("bytes=") && r.url.includes("lantmateriet.se"))).toBe(true);
    // the 2 m overview of a 1600 × 1200 m tile, not the tile: far less than its 7 MB
    expect(fx.requests.some((r) => r.url.includes("amazonaws"))).toBe(false);
  });

  it("hands the DEM out in the descriptor and the review, with licence and attribution", async () => {
    const d = await terrainDescriptor(ctx.db, hill);
    expect(d.state).toBe("ready");
    expect(d.dem).toMatchObject({
      state: "ready", reason: null,
      provider: { id: LM, licence: "CC BY 4.0", attribution: "© Lantmäteriet" },
      ground: { url: url(hill, `ground.${LM}`) },
      anchored: { url: url(hill, `contours.${LM}`), decided: expect.any(Number) },
    });
    expect((await terrainReview(ctx.db, hill)).dem.state).toBe("ready");
    expect((await terrainDescriptor(ctx.db, hill, undefined, { rotationCorrection: 1.5 })).dem).toEqual({ state: "unavailable", reason: "rotation-corrected", provider: null, ground: null, anchored: null });
    setDemProviders([]);
    expect((await terrainDescriptor(ctx.db, hill)).dem.state).toBe("disabled");
  });

  it("serves both fields immutably behind the document predicate, the contours route unchanged", async () => {
    const res = await get(url(hill, `ground.${LM}`), { ...signedIn, "accept-encoding": "br" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe(MAP_DOCUMENT_CACHE_CONTROL);
    expect(res.headers.etag).toBe(`"${hill}/height/ground.${LM}/${TERRAIN_VERSION}"`);
    expect(decodeHeightField(brotliDecompressSync(res.rawPayload)).header.source).toBe(`ground.${LM}`);
    expect((await get(url(hill, `ground.${LM}`), { ...signedIn, "if-none-match": res.headers.etag as string })).statusCode).toBe(304);
    expect((await get(url(hill, `contours.${LM}`), signedIn)).statusCode).toBe(200);
    const plain = await get(url(hill), signedIn);
    expect(plain.statusCode).toBe(200);
    expect(plain.headers.etag).toBe(`"${hill}/height/contours/${TERRAIN_VERSION}"`);
    expect((await get(url(hill, "contours"), signedIn)).headers.etag).toBe(plain.headers.etag);
  });

  it("checks in the contract's order: 400, then the predicate, then 404", async () => {
    expect((await get(url(hill, "dem.bad"))).statusCode).toBe(400);
    expect((await get(url(hill, "ground.srtm-30m"))).statusCode).toBe(401);
    expect((await get(url(hill, "GROUND.x"), signedIn)).statusCode).toBe(400);
    expect((await get(url(hill, `ground.${LM}`))).statusCode).toBe(401);
    const unknown = await get(url(hill, "ground.srtm-30m"), signedIn);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ reason: "source" });
    // an unknown hash fails the predicate: a hash cannot be probed (§4.2)
    expect((await get(url("f".repeat(64), `ground.${LM}`), signedIn)).statusCode).toBe(403);
    expect((await get(url(hill, `ground.${LM}`, TERRAIN_VERSION + 1), signedIn)).json()).toMatchObject({ reason: "version" });
  });
});

describe("states (map-storage.md §4.7 \"The DEM job\")", () => {
  it("falls to GLO-30 where Lantmäteriet has no coverage", async () => {
    const hash = await insertDoc(HILL, "glo", sweref99(GLO_ORIGIN.e, GLO_ORIGIN.n));
    await enqueueDocumentDem(ctx.db, hash);
    const rows = await settle(hash);
    expect(rows.map((r) => [r.provider, r.state, r.reason])).toEqual([[LM, "unavailable", "no-coverage"], [GLO, "done", null]]);
    const ground = (await readHeightfield(ctx.db, hash, TERRAIN_VERSION, `ground.${GLO}`))!;
    expect(ground.header).toMatchObject({ provider: { id: GLO, grade: "coarse", verticalDatum: "EGM2008" } });
    expect(ground.header!.provider!.attribution).toMatch(/COPERNICUS/);
    expect((await terrainDescriptor(ctx.db, hash)).dem).toMatchObject({ state: "ready", provider: { id: GLO }, ground: { url: url(hash, `ground.${GLO}`) } });
    expect(fx.requests.filter((r) => r.url.includes("amazonaws")).every((r) => r.authorization === null && r.range !== null)).toBe(true);
  });

  it("uses GLO-30 alone where Lantmäteriet is not enabled", async () => {
    const [, glo] = fx.providers();
    setDemProviders([glo]);
    const hash = await insertDoc(HILL, "glo-only", sweref99(GLO_ORIGIN.e, GLO_ORIGIN.n));
    await enqueueDocumentDem(ctx.db, hash);
    expect((await settle(hash)).map((r) => [r.provider, r.state])).toEqual([[GLO, "done"]]);
    expect(fx.requests.some((r) => r.url.includes("lantmateriet"))).toBe(false);
  });

  it("ends unavailable without a georeference, without contours, over the cap, or misaligned — writing nothing", async () => {
    const cases: [string, string][] = [
      [await insertDoc(HILL, "nogeo"), "no-georeference"],
      [await insertDoc(FLAT, "flat", sweref99(LM_ORIGIN.e, LM_ORIGIN.n)), "no-contours"],
      [await insertDoc(HILL, "off", sweref99(LM_ORIGIN.e + 225, LM_ORIGIN.n)), "misaligned"],
    ];
    for (const [hash, reason] of cases) {
      await enqueueDocumentDem(ctx.db, hash);
      expect((await settle(hash)).map((r) => [r.provider, r.state, r.reason])).toEqual([[LM, "unavailable", reason]]);
      expect(await ctx.db.mapHeightfield.count({ where: { documentHash: hash, source: { not: "contours" } } })).toBe(0);
      const res = await get(url(hash, `ground.${LM}`), signedIn);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ reason });
      expect((await terrainDescriptor(ctx.db, hash)).dem, reason).toMatchObject({ state: "unavailable", reason });
    }
    const huge = await insertDoc(HILL, "huge", sweref99(LM_ORIGIN.e, LM_ORIGIN.n));
    await ctx.db.mapDocument.update({ where: { hash: huge }, data: { header: { unitsPerMm: 100, bounds: { minX: 0, minY: 0, maxX: 200_000, maxY: 200_000 } } } });
    // the cap refuses nothing by default (§4.7 answer 3): an instance that lowers it
    process.env.MAP_HEIGHTFIELD_MAX_CELLS = "1000000";
    try {
      await enqueueDocumentDem(ctx.db, huge);
      const [job] = await settle(huge);
      expect(job).toMatchObject({ state: "unavailable", reason: "over-cap" });
      // which cap: H4's, on the document itself (§7.0c answer 12)
      expect(demOverCapOf(job.error)).toBe("field");
    } finally {
      delete process.env.MAP_HEIGHTFIELD_MAX_CELLS;
    }
  });

  it("fails a refused credential with a retry no sooner than an hour, and stores no secret", async () => {
    fx.mode.stac = 401;
    const hash = await insertDoc(HILL, "auth", sweref99(LM_ORIGIN.e, LM_ORIGIN.n));
    const before = Date.now();
    await enqueueDocumentDem(ctx.db, hash);
    const [job] = await settle(hash);
    expect(job).toMatchObject({ state: "failed", reason: "auth", attempts: 1 });
    expect(job.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(job.error).not.toContain(TEST_CREDENTIAL);
    expect(job.error).not.toContain(Buffer.from(TEST_CREDENTIAL).toString("base64"));
    // not due: the engine leaves it
    await kickDemJobs(ctx.db);
    expect((await getDemJob(ctx.db, hash, LM))!.attempts).toBe(1);
    const res = await get(url(hash, `ground.${LM}`), signedIn);
    expect(res.statusCode).toBe(503);
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(15);
    expect(res.json()).toMatchObject({ reason: "auth" });
    expect((await terrainDescriptor(ctx.db, hash)).dem).toMatchObject({ state: "failed", reason: "auth" });

    // the operator fixes the secret; the new revision's start queues the job again
    fx.mode.stac = "ok";
    expect(await requeueAuthFailures(ctx.db)).toBeGreaterThanOrEqual(1);
    expect((await settle(hash))[0]).toMatchObject({ state: "done", attempts: 1 });
  });

  it("retries a transient failure when due, then succeeds; stops after the last attempt", async () => {
    fx.mode.stac = 503;
    const hash = await insertDoc(HILL, "transient", sweref99(LM_ORIGIN.e, LM_ORIGIN.n));
    await enqueueDocumentDem(ctx.db, hash);
    const [first] = await settle(hash);
    expect(first).toMatchObject({ state: "failed", reason: "http", attempts: 1 });
    expect(first.nextAttemptAt!.getTime() - first.updatedAt.getTime()).toBeLessThanOrEqual(61_000);
    fx.mode.stac = "ok";
    await ctx.db.mapDemJob.updateMany({ where: { documentHash: hash }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    expect((await settle(hash))[0]).toMatchObject({ state: "done", reason: null, error: null, attempts: 2 });

    fx.mode.stac = 503;
    const last = await insertDoc(HILL, "final", sweref99(LM_ORIGIN.e, LM_ORIGIN.n));
    await ctx.db.mapDemJob.create({ data: { documentHash: last, provider: LM, version: TERRAIN_VERSION, state: "queued", attempts: 4 } });
    const [final] = await settle(last);
    expect(final).toMatchObject({ state: "failed", reason: "http", attempts: 5, nextAttemptAt: null });
    expect((await get(url(last, `ground.${LM}`), signedIn)).statusCode).toBe(404);
    // a request does not revive it; an import of the document does
    await enqueueDocumentDem(ctx.db, last);
    expect((await getDemJob(ctx.db, last, LM))!.state).toBe("failed");
    fx.mode.stac = "ok";
    await deriveDocumentArtifacts(ctx.db, last);
    expect((await settle(last))[0]).toMatchObject({ state: "done", attempts: 1 });
  });

  it("a route miss queues the job and answers 503 pending until the rows are there", async () => {
    const hash = await insertDoc(HILL, "lazy", sweref99(LM_ORIGIN.e, LM_ORIGIN.n));
    expect((await terrainDescriptor(ctx.db, hash)).dem).toMatchObject({ state: "pending", ground: { url: url(hash, `ground.${LM}`) } });
    const res = await get(url(hash, `ground.${LM}`), signedIn);
    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe("15");
    expect(res.json()).toMatchObject({ reason: "pending" });
    await settle(hash);
    expect((await get(url(hash, `ground.${LM}`), signedIn)).statusCode).toBe(200);
  });

  it("re-queues a done job whose rows went, from the route", async () => {
    const hash = await insertDoc(HILL, "rows-gone", sweref99(LM_ORIGIN.e, LM_ORIGIN.n));
    await enqueueDocumentDem(ctx.db, hash);
    await settle(hash);
    await ctx.db.mapHeightfield.deleteMany({ where: { documentHash: hash, source: { not: "contours" } } });
    const res = await get(url(hash, `ground.${LM}`), signedIn);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ reason: "pending" });
    expect((await settle(hash))[0]).toMatchObject({ state: "done" });
    expect((await get(url(hash, `ground.${LM}`), signedIn)).statusCode).toBe(200);
  });

  it("the review's dem block follows the job like the descriptor's", async () => {
    const hash = await insertDoc(HILL, "review", sweref99(LM_ORIGIN.e + 225, LM_ORIGIN.n));
    expect((await terrainReview(ctx.db, hash)).dem).toMatchObject({ state: "pending", provider: { id: LM } });
    await enqueueDocumentDem(ctx.db, hash);
    await settle(hash);
    expect((await terrainReview(ctx.db, hash)).dem).toMatchObject({ state: "unavailable", reason: "misaligned" });
  });

  it("fails for good a running job that went stale on its last attempt, instead of re-claiming it", async () => {
    const hash = await insertDoc(HILL, "crashy", sweref99(LM_ORIGIN.e, LM_ORIGIN.n));
    await ctx.db.mapDemJob.create({ data: { documentHash: hash, provider: LM, version: TERRAIN_VERSION, state: "running", attempts: DEM_JOB_RULES.maxAttempts, claimedBy: "gone:1", heartbeatAt: new Date(Date.now() - 120_000) } });
    await kickDemJobs(ctx.db);
    expect(await getDemJob(ctx.db, hash, LM)).toMatchObject({ state: "failed", reason: "derive", attempts: DEM_JOB_RULES.maxAttempts, nextAttemptAt: null });
  });

  it("re-claims a running job whose heartbeat went stale", async () => {
    const hash = await insertDoc(HILL, "stale", sweref99(LM_ORIGIN.e, LM_ORIGIN.n));
    await ctx.db.mapDemJob.create({ data: { documentHash: hash, provider: LM, version: TERRAIN_VERSION, state: "running", attempts: 1, claimedBy: "gone:1", heartbeatAt: new Date(Date.now() - 120_000) } });
    expect((await settle(hash))[0]).toMatchObject({ state: "done", attempts: 2 });
  });

  it("the table's CHECKs hold the states and reasons together", async () => {
    const hash = docs[0];
    await expect(ctx.db.mapDemJob.create({ data: { documentHash: hash, provider: "x-1m", version: 1, state: "lost" } })).rejects.toThrow();
    await expect(ctx.db.mapDemJob.create({ data: { documentHash: hash, provider: "x-1m", version: 1, state: "failed" } })).rejects.toThrow();
    await expect(ctx.db.mapDemJob.create({ data: { documentHash: hash, provider: "x-1m", version: 1, state: "done", reason: "auth" } })).rejects.toThrow();
  });
});

describe("over the window cap: the next coarser overview (map-terrain §7.0c answer 12)", () => {
  // the hill's window is about 124 k cells at 2 m and 31 k at 4 m; these caps put 2 m over
  const derive = async (d: Parameters<typeof deriveDemFields>[0]) => deriveDemFields(d);
  const withCap = async <T>(maxMosaicCells: number, fn: () => Promise<T>): Promise<T> => {
    configureDemEngine({ derive, maxMosaicCells });
    try {
      return await fn();
    } finally {
      configureDemEngine({ derive });
    }
  };

  it("queues an over-cap ending from before H13 once, and it completes at 4 m under the 2 m id", async () => {
    const hash = await insertDoc(HILL, "overcap-old", sweref99(LM_ORIGIN.e, LM_ORIGIN.n));
    // as H10 left it: unavailable, over-cap, no error
    await ctx.db.mapDemJob.create({ data: { documentHash: hash, provider: LM, version: TERRAIN_VERSION, state: "unavailable", reason: "over-cap", attempts: 1 } });
    await withCap(60_000, async () => {
      expect(await requeueOverCap(ctx.db)).toBeGreaterThanOrEqual(1);
      expect(await getDemJob(ctx.db, hash, LM)).toMatchObject({ state: "queued", reason: null, error: null, attempts: 0 });
      const [job] = await settle(hash);
      expect(job).toMatchObject({ provider: LM, state: "done", error: null, attempts: 1 });
    });
    const ground = (await readHeightfield(ctx.db, hash, TERRAIN_VERSION, `ground.${LM}`))!;
    const anchored = (await readHeightfield(ctx.db, hash, TERRAIN_VERSION, `contours.${LM}`))!;
    for (const row of [ground, anchored]) expect(row.header?.provider).toMatchObject({ id: LM, resolutionM: 4, grade: "anchor" });
    // the §7.5 gate held at 4 m, and the heights still follow the cone
    const g = decodeHeightField(ground.bytes!);
    for (const r of [7.5, 12.5]) expect(Math.abs(sampleHeight(g, { x: 30 + r, y: 30 })! - (CONE_TOP - r))).toBeLessThan(0.5);
    // the descriptor's provider is the row's: the level read (HeightFieldProvider.resolutionM)
    expect((await terrainDescriptor(ctx.db, hash)).dem).toMatchObject({ state: "ready", provider: { id: LM, resolutionM: 4 } });
    // once: nothing left to queue for this document, and a second pass takes nothing of it
    expect(await requeueOverCap(ctx.db)).toBeGreaterThanOrEqual(0);
    expect(await getDemJob(ctx.db, hash, LM)).toMatchObject({ state: "done" });
    expect(await ctx.db.mapDemJob.count({ where: { documentHash: hash, state: "unavailable", reason: "over-cap", error: null } })).toBe(0);
  });

  it("over the cap at 4 m too ends over-cap naming the window cells, and is not queued again", async () => {
    const hash = await insertDoc(HILL, "overcap-both", sweref99(LM_ORIGIN.e, LM_ORIGIN.n));
    await withCap(10_000, async () => {
      await enqueueDocumentDem(ctx.db, hash);
      const [job] = await settle(hash);
      expect(job).toMatchObject({ provider: LM, state: "unavailable", reason: "over-cap" });
      expect(demOverCapOf(job.error)).toBe("window-cells");
      expect(job.error).toMatch(/at 2 m and .* at 4 m, over the cap/);
      await requeueOverCap(ctx.db);
      expect(await getDemJob(ctx.db, hash, LM)).toMatchObject({ state: "unavailable", reason: "over-cap" });
    });
    expect(await ctx.db.mapHeightfield.count({ where: { documentHash: hash, source: { not: "contours" } } })).toBe(0);
  });

  it("the descriptor falls back to the registry's provider when the row's block is missing or another id", async () => {
    for (const [name, header] of [["nohdr", { datum: "absolute" }], ["otherid", { provider: { id: "lantmateriet-1m", resolutionM: 1, grade: "anchor", licence: "CC BY 4.0", attribution: "© Lantmäteriet", verticalDatum: "RH 2000" } }]] as const) {
      const hash = await insertDoc(HILL, `fallback-${name}`, sweref99(LM_ORIGIN.e, LM_ORIGIN.n));
      await ctx.db.mapDemJob.create({ data: { documentHash: hash, provider: LM, version: TERRAIN_VERSION, state: "done", attempts: 1 } });
      await ctx.db.mapHeightfield.create({ data: { documentHash: hash, source: `contours.${LM}`, version: TERRAIN_VERSION, bytes: new Uint8Array([0]), sizeBytes: 1, header, report: { share: { decided: 0.9 } } } });
      expect((await terrainDescriptor(ctx.db, hash)).dem, name).toMatchObject({ state: "ready", provider: { id: LM, resolutionM: 2 } });
    }
  });

  it("a map under the cap reads its own level", async () => {
    const hash = await insertDoc(HILL, "undercap", sweref99(LM_ORIGIN.e, LM_ORIGIN.n));
    await enqueueDocumentDem(ctx.db, hash);
    expect((await settle(hash))[0]).toMatchObject({ state: "done" });
    expect((await readHeightfield(ctx.db, hash, TERRAIN_VERSION, `ground.${LM}`))!.header?.provider).toMatchObject({ id: LM, resolutionM: 2 });
  });
});

describe("lifetime", () => {
  it("the GC's version pass sweeps DEM rows and jobs of a superseded terrain version, every source", async () => {
    const hash = docs[0];
    await ctx.db.mapHeightfield.create({ data: { documentHash: hash, source: `ground.${LM}`, version: TERRAIN_VERSION - 1 } });
    await ctx.db.mapDemJob.create({ data: { documentHash: hash, provider: LM, version: TERRAIN_VERSION - 1, state: "done" } });
    await runStorageGc(ctx.db);
    expect(await ctx.db.mapHeightfield.count({ where: { documentHash: hash, version: { lt: TERRAIN_VERSION } } })).toBe(0);
    expect(await ctx.db.mapDemJob.count({ where: { documentHash: hash, version: { lt: TERRAIN_VERSION } } })).toBe(0);
    expect(await ctx.db.mapHeightfield.count({ where: { documentHash: hash, source: `ground.${LM}`, version: TERRAIN_VERSION } })).toBe(1);
  });

  it("deleting the document deletes its DEM rows and jobs", async () => {
    const hash = docs[0];
    expect(await ctx.db.mapDemJob.count({ where: { documentHash: hash } })).toBeGreaterThan(0);
    await ctx.db.clubMapVersion.deleteMany({ where: { documentHash: hash } });
    await ctx.db.mapDocument.delete({ where: { hash } });
    expect(await ctx.db.mapDemJob.count({ where: { documentHash: hash } })).toBe(0);
    expect(await ctx.db.mapHeightfield.count({ where: { documentHash: hash } })).toBe(0);
  });
});
