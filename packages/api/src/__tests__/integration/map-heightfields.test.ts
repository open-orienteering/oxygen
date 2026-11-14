/**
 * Height fields (docs/map-storage.md §4.7): import stage 10 writes the
 * `map_heightfields` row (a field for a map with contours, a row without
 * bytes for one without), the route serves it immutably behind the §4.2
 * predicate, derives on a miss, and the row cascades with its document.
 *
 * Fixtures: the CC0 demo `.omap` (contours) imported for real, salted so
 * this run stores its own source; `e2e/test.ocd` (no contours); synthetic
 * documents inserted directly — the shared terrain tests' hill, garbage
 * bytes, and a sheet too large for a lowered cap.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { createHash, randomBytes } from "crypto";
import { brotliDecompressSync, gunzipSync } from "zlib";
import Fastify, { type FastifyInstance } from "fastify";
import { SYSTEM_GROUP_IDS, mapDocument } from "@oxygen/shared";
import { decodeHeightField, TERRAIN_VERSION } from "@oxygen/shared/src/terrain/field/index.js";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { FLAT, HILL, encodeTerrainDoc } from "../helpers/terrain-doc.js";
import { grantSystemGroup } from "../../permissions.js";
import { applyEventMap } from "../../event-map.js";
import { startImportJob } from "../../map-store/jobs.js";
import { deriveDocumentHeightfield, heightfieldUrl, readHeightfield, resetHeightfieldState } from "../../map-store/heightfield.js";
import { deriveHeightfieldBytes } from "../../map-store/heightfield-worker.js";
import { registerMapHeightfieldRoutes } from "../../map-store/heightfield-routes.js";
import { MAP_DOCUMENT_CACHE_CONTROL, resetDocumentAccessCache } from "../../map-store/routes.js";
import { runStorageGc } from "../../map-store/gc.js";
import type { AuthUser } from "../../auth.js";

const OCD = resolve(__dirname, "../../../../../e2e/test.ocd");
const OMAP = resolve(__dirname, "../../../../../docs/screenshots/fixtures/puit-de-laven-demo.omap");
const suffix = randomBytes(4).toString("hex");
const EMAIL_DOMAIN = `@map-heightfields-${suffix}.example`;

let ctx: TestEventContext;
let other: TestEventContext;
let server: FastifyInstance;
let member: AuthUser;
let stranger: AuthUser;
let uploader: AuthUser;
let previousAuthMode: string | undefined;
/** The demo map imported into `ctx`'s event: a document with contours. */
let demoHash: string;
let demoSource: string;
/** test.ocd imported into `other`'s event: no contours. */
let ocdHash: string;
let ocdSource: string;
const synthetic = { sourceHash: "", hill: "", flat: "", garbage: "", huge: "", clubMapId: "" };

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const get = (url: string, headers: Record<string, string> = {}) => server.inject({ method: "GET", url, headers });
const memberHeaders = () => ({ "x-forwarded-email": member.email, "x-event-id": ctx.nameId });
const signedIn = (u: AuthUser) => ({ "x-forwarded-email": u.email });
const url = (hash: string, v: number | string = TERRAIN_VERSION) => `/api/map-documents/${hash}/height.bin?v=${v}`;

async function mkUser(name: string, isAdmin = false): Promise<AuthUser> {
  return ctx.db.user.create({ data: { email: `${name}${EMAIL_DOMAIN}`, displayName: name, isAdmin, active: true } });
}

async function insertSyntheticDocuments(): Promise<void> {
  const sourceBytes = Buffer.from(`heightfield-source-${suffix}`);
  synthetic.sourceHash = sha(sourceBytes);
  await ctx.db.mapSource.create({ data: { fileHash: synthetic.sourceHash, kind: "ocad", bytes: sourceBytes, sizeBytes: sourceBytes.byteLength, fileName: "synthetic.ocd" } });
  const insert = async (bytes: Uint8Array, summary: unknown): Promise<string> => {
    const hash = sha(bytes);
    await ctx.db.mapDocument.create({
      data: {
        hash, bytes, sizeBytes: bytes.byteLength, formatVersion: 1, importerVersion: "test", libraryVersion: "none",
        sourceHash: synthetic.sourceHash, header: JSON.parse(JSON.stringify(summary)), report: {},
      },
    });
    return hash;
  };
  const summaryOf = (bytes: Uint8Array) => {
    const { header } = mapDocument.readMapDocumentHeader(bytes);
    return { ...header, symbols: undefined, strings: undefined };
  };
  const hill = encodeTerrainDoc(HILL, `hill-${suffix}`, synthetic.sourceHash);
  const flat = encodeTerrainDoc(FLAT, `flat-${suffix}`, synthetic.sourceHash);
  synthetic.hill = await insert(hill, summaryOf(hill));
  synthetic.flat = await insert(flat, summaryOf(flat));
  synthetic.garbage = await insert(Buffer.from(`not a document ${suffix}`), {});
  // A 2 × 2 m sheet: over any lowered cap, decided from the summary alone (its bytes are garbage too).
  synthetic.huge = await insert(Buffer.from(`huge ${suffix}`), { unitsPerMm: 100, bounds: { minX: 0, minY: 0, maxX: 200_000, maxY: 200_000 } });
  // Visible to any signed-in user through a club-library version.
  const clubMap = await ctx.db.clubMap.create({ data: { name: `Heightfields ${suffix}` } });
  synthetic.clubMapId = clubMap.id;
  for (const [seq, hash] of [synthetic.hill, synthetic.flat, synthetic.garbage, synthetic.huge].entries()) {
    await ctx.db.clubMapVersion.create({ data: { clubMapId: clubMap.id, seq: seq + 1, sourceHash: synthetic.sourceHash, documentHash: hash } });
  }
}

beforeAll(async () => {
  ctx = await createTestEvent("map_heightfields");
  other = await createTestEvent("map_heightfields_ocd");
  const admin = await mkUser("admin", true);
  member = await mkUser("member");
  stranger = await mkUser("stranger");
  uploader = await mkUser("uploader");
  await grantSystemGroup(ctx.db, { eventId: ctx.eventId, userId: member.id, groupId: SYSTEM_GROUP_IDS.courseSetter, grantedBy: admin.id });
  await ctx.db.event.update({ where: { id: ctx.eventId }, data: { kioskKey: `kiosk-${suffix}`, date: new Date("2099-06-01T00:00:00Z") } });
  ctx.event.kioskKey = `kiosk-${suffix}`;
  await ctx.db.event.update({ where: { id: other.eventId }, data: { date: new Date("2099-06-01T00:00:00Z") } });

  // A comment after the XML declaration salts the source hash without touching the map.
  const omap = readFileSync(OMAP, "utf8").replace(/^(<\?xml[^>]*\?>)/, `$1<!-- map-heightfields ${suffix} -->`);
  const demo = await applyEventMap(ctx.db, ctx.eventId, "puit-de-laven-demo.omap", Buffer.from(omap), { uploadedBy: uploader.id, startedBy: uploader.id, importHoldMs: 120_000 });
  demoHash = demo.documentHash!;
  demoSource = (await ctx.db.mapFile.findFirstOrThrow({ where: { eventId: ctx.eventId } })).sourceHash!;
  const ocd = await applyEventMap(other.db, other.eventId, "test.ocd", Buffer.concat([readFileSync(OCD), Buffer.from(`map-heightfields-${suffix}`)]), { uploadedBy: admin.id, importHoldMs: 120_000 });
  ocdHash = ocd.documentHash!;
  ocdSource = (await other.db.mapFile.findFirstOrThrow({ where: { eventId: other.eventId } })).sourceHash!;
  await insertSyntheticDocuments();

  server = Fastify({ logger: false });
  registerMapHeightfieldRoutes(server);
  await server.ready();
  previousAuthMode = process.env.AUTH_MODE;
  process.env.AUTH_MODE = "proxy";
  resetDocumentAccessCache();
  resetHeightfieldState();
}, 300_000);

afterAll(async () => {
  if (previousAuthMode === undefined) delete process.env.AUTH_MODE;
  else process.env.AUTH_MODE = previousAuthMode;
  delete process.env.MAP_HEIGHTFIELD_MAX_CELLS;
  await server?.close();
  await ctx.cleanup();
  await other.cleanup();
  await ctx.db.clubMap.deleteMany({ where: { id: synthetic.clubMapId } });
  const sources = [demoSource, ocdSource, synthetic.sourceHash].filter(Boolean);
  await ctx.db.mapImportJob.deleteMany({ where: { sourceHash: { in: sources } } });
  await ctx.db.mapDocument.deleteMany({ where: { sourceHash: { in: sources } } });
  await ctx.db.mapSource.deleteMany({ where: { fileHash: { in: sources } } });
  await ctx.db.user.deleteMany({ where: { email: { endsWith: EMAIL_DOMAIN } } });
  await disconnect();
}, 60_000);

describe("stage 10 derive", () => {
  it("the import job wrote the demo map's field: the in-process derive's bytes, header and report, and finished done", async () => {
    expect(demoHash).toMatch(/^[0-9a-f]{64}$/);
    const job = await ctx.db.mapImportJob.findFirstOrThrow({ where: { eventId: ctx.eventId }, orderBy: { createdAt: "desc" } });
    expect(job).toMatchObject({ state: "done", stage: "done", documentHash: demoHash });
    const row = await ctx.db.mapHeightfield.findUniqueOrThrow({ where: { documentHash_source_version: { documentHash: demoHash, source: "contours", version: TERRAIN_VERSION } } });
    const doc = await ctx.db.mapDocument.findUniqueOrThrow({ where: { hash: demoHash }, select: { bytes: true } });
    const inline = deriveHeightfieldBytes(new Uint8Array(doc.bytes));
    if (inline.type !== "done") throw new Error("the demo map has contours");
    expect(Buffer.from(row.bytes!).equals(Buffer.from(inline.bytes))).toBe(true);
    expect(row.sizeBytes).toBe(inline.bytes.byteLength);
    expect(row.header).toEqual(JSON.parse(JSON.stringify(inline.header)));
    expect(row.report).toEqual(JSON.parse(JSON.stringify(inline.report)));
    expect(decodeHeightField(new Uint8Array(row.bytes!)).header.source).toBe("contours");
  });

  it("a map without contours gets a row without bytes", async () => {
    const row = await ctx.db.mapHeightfield.findUniqueOrThrow({ where: { documentHash_source_version: { documentHash: ocdHash, source: "contours", version: TERRAIN_VERSION } } });
    expect(row).toMatchObject({ bytes: null, sizeBytes: null, header: null, report: null });
  });

  it("the dedup short-cut derives too: a deleted row is back after the next job on the same source", async () => {
    await ctx.db.mapHeightfield.deleteMany({ where: { documentHash: ocdHash } });
    const job = await startImportJob(other.db, { sourceHash: ocdSource, eventId: other.eventId });
    expect(job.state).toBe("done");
    // The short-cut does not wait for the height field (§6.1): it lands shortly after.
    await expect.poll(() => readHeightfield(ctx.db, ocdHash), { timeout: 30_000 }).toEqual({ bytes: null, header: null, report: null });
  });

  it("a failed derive is logged, writes nothing and does not throw", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(deriveDocumentHeightfield(ctx.db, synthetic.garbage)).resolves.toBeUndefined();
    expect(await ctx.db.mapHeightfield.count({ where: { documentHash: synthetic.garbage } })).toBe(0);
    expect(err.mock.calls.some((c) => String(c[0]).includes(`derive ${synthetic.garbage} failed`))).toBe(true);
    err.mockRestore();
  });

  it("over a lowered cap nothing is derived, decided from the stored header summary", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.MAP_HEIGHTFIELD_MAX_CELLS = "1000000";
    try {
      await deriveDocumentHeightfield(ctx.db, synthetic.huge);
      expect(await ctx.db.mapHeightfield.count({ where: { documentHash: synthetic.huge } })).toBe(0);
      expect(warn.mock.calls.some((c) => String(c[0]).includes("over the cap"))).toBe(true);
    } finally {
      delete process.env.MAP_HEIGHTFIELD_MAX_CELLS;
      warn.mockRestore();
    }
  });
});

describe("GET /api/map-documents/:hash/height.bin", () => {
  it("400 for a malformed hash or ?v=, then 401 / 403 before existence", async () => {
    expect((await get(`/api/map-documents/nope/height.bin?v=1`)).statusCode).toBe(400);
    expect((await get(`/api/map-documents/${demoHash}/height.bin`)).statusCode).toBe(400);
    expect((await get(url(demoHash, "01"))).statusCode).toBe(400);
    expect((await get(url(demoHash))).statusCode).toBe(401);
    expect((await get(url(demoHash), { "x-forwarded-email": stranger.email, "x-event-id": ctx.nameId })).statusCode).toBe(403);
    expect((await get(url("e".repeat(64)), memberHeaders())).statusCode).toBe(403);
  });

  it("200 with the stored bytes, immutable private cache and a versioned ETag; 304 on revalidation", async () => {
    const res = await get(url(demoHash), memberHeaders());
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/vnd.oxygen.heightfield");
    expect(res.headers["cache-control"]).toBe(MAP_DOCUMENT_CACHE_CONTROL);
    expect(res.headers.etag).toBe(`"${demoHash}/height/contours/${TERRAIN_VERSION}"`);
    expect(res.headers.vary).toBe("Accept-Encoding");
    expect(res.headers["accept-ranges"]).toBeUndefined();
    expect(res.headers["content-encoding"]).toBeUndefined();
    const row = await readHeightfield(ctx.db, demoHash);
    expect(res.rawPayload.equals(row!.bytes!)).toBe(true);
    const again = await get(url(demoHash), { ...memberHeaders(), "if-none-match": `W/"${demoHash}/height/contours/${TERRAIN_VERSION}"` });
    expect(again.statusCode).toBe(304);
    expect(again.headers.etag).toBe(`"${demoHash}/height/contours/${TERRAIN_VERSION}"`);
    expect(again.rawPayload.byteLength).toBe(0);
  });

  it("compresses by Accept-Encoding; both round-trip to the field", async () => {
    const row = await readHeightfield(ctx.db, demoHash);
    const br = await get(url(demoHash), { ...memberHeaders(), "accept-encoding": "br, gzip" });
    expect(br.headers["content-encoding"]).toBe("br");
    expect(brotliDecompressSync(br.rawPayload).equals(row!.bytes!)).toBe(true);
    const gz = await get(url(demoHash), { ...memberHeaders(), "accept-encoding": "gzip" });
    expect(gz.headers["content-encoding"]).toBe("gzip");
    const field = decodeHeightField(new Uint8Array(gunzipSync(gz.rawPayload)));
    expect(field.header.version).toBe(TERRAIN_VERSION);
    expect(gz.rawPayload.byteLength).toBeLessThan(row!.bytes!.byteLength);
  });

  it("the kiosk key, ?event=, the uploader's own job and a club version authorise as on the document route", async () => {
    expect((await get(`${url(demoHash)}&event=${ctx.nameId}&k=${ctx.event.kioskKey}`)).statusCode).toBe(200);
    expect((await get(`${url(demoHash)}&event=${ctx.nameId}&k=wrong`)).statusCode).toBe(401);
    expect((await get(url(demoHash), signedIn(uploader))).statusCode).toBe(200);
    expect((await get(url(demoHash), signedIn(stranger))).statusCode).toBe(403);
    // Through a club version (any signed-in user): past authorisation, the flat sheet has no contours.
    const club = await get(url(synthetic.flat), signedIn(stranger));
    expect(club.statusCode).toBe(404);
    expect(club.json()).toMatchObject({ reason: "no-contours" });
  });

  it("is open with auth off", async () => {
    process.env.AUTH_MODE = "off";
    try {
      expect((await get(url(demoHash))).statusCode).toBe(200);
    } finally {
      process.env.AUTH_MODE = "proxy";
    }
  });

  it("reading is not a reference: last_referenced_at does not move", async () => {
    const before = (await ctx.db.mapDocument.findUniqueOrThrow({ where: { hash: demoHash } })).lastReferencedAt;
    await get(url(demoHash), memberHeaders());
    expect((await ctx.db.mapDocument.findUniqueOrThrow({ where: { hash: demoHash } })).lastReferencedAt).toEqual(before);
  });

  it("derives on a miss and writes the row once; concurrent requests share one derive", async () => {
    expect(await readHeightfield(ctx.db, synthetic.hill)).toBeNull();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const [a, b] = await Promise.all([get(url(synthetic.hill), signedIn(member)), get(url(synthetic.hill), signedIn(member))]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(a.rawPayload.equals(b.rawPayload)).toBe(true);
    expect(log.mock.calls.filter((c) => String(c[0]).includes(`derived ${synthetic.hill}`))).toHaveLength(1);
    log.mockRestore();
    const row = await readHeightfield(ctx.db, synthetic.hill);
    expect(row!.bytes!.equals(a.rawPayload)).toBe(true);
    expect(row!.report!.share.decided).toBeGreaterThan(0.99);
    expect(await ctx.db.mapHeightfield.count({ where: { documentHash: synthetic.hill } })).toBe(1);
  });

  it("404 with a reason for no contours, another version and over the cap; 404 for an unknown document after authorisation", async () => {
    const flat = await get(url(synthetic.flat), signedIn(member));
    expect(flat.statusCode).toBe(404);
    expect(flat.json()).toMatchObject({ reason: "no-contours" });
    const version = await get(url(synthetic.hill, TERRAIN_VERSION + 1), signedIn(member));
    expect(version.statusCode).toBe(404);
    expect(version.json()).toMatchObject({ reason: "version" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.MAP_HEIGHTFIELD_MAX_CELLS = "1000000";
    try {
      const huge = await get(url(synthetic.huge), signedIn(member));
      expect(huge.statusCode).toBe(404);
      expect(huge.json()).toMatchObject({ reason: "over-cap" });
    } finally {
      delete process.env.MAP_HEIGHTFIELD_MAX_CELLS;
      warn.mockRestore();
    }
    process.env.AUTH_MODE = "off";
    try {
      expect((await get(url("f".repeat(64)))).statusCode).toBe(404);
    } finally {
      process.env.AUTH_MODE = "proxy";
    }
  });

  it("503 for a failed derive, remembered: nothing is stored", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    resetHeightfieldState();
    expect((await get(url(synthetic.garbage), signedIn(member))).statusCode).toBe(503);
    expect((await get(url(synthetic.garbage), signedIn(member))).statusCode).toBe(503);
    expect(err.mock.calls.filter((c) => String(c[0]).includes(`derive ${synthetic.garbage} failed`))).toHaveLength(1);
    expect(await ctx.db.mapHeightfield.count({ where: { documentHash: synthetic.garbage } })).toBe(0);
    err.mockRestore();
  });
});

describe("the terrain in the descriptor and the review", () => {
  const eventCaller = (c: TestEventContext) => makeCaller(c.event);

  it("course.mapMetadata.terrain: ready with the decided share and the versioned URL", async () => {
    const meta = await eventCaller(ctx).course.mapMetadata();
    const report = (await readHeightfield(ctx.db, demoHash))!.report!;
    expect(meta!.terrain).toEqual({ state: "ready", source: "contours", version: TERRAIN_VERSION, url: heightfieldUrl(demoHash), decided: report.share.decided });
  });

  it("course.mapMetadata.terrain: none without contours, pending without a row", async () => {
    expect((await eventCaller(other).course.mapMetadata())!.terrain).toMatchObject({ state: "none", url: null, decided: null });
    await ctx.db.mapHeightfield.deleteMany({ where: { documentHash: ocdHash } });
    expect((await eventCaller(other).course.mapMetadata())!.terrain).toMatchObject({ state: "pending", url: heightfieldUrl(ocdHash), decided: null });
    // The descriptor never derives.
    expect(await readHeightfield(ctx.db, ocdHash)).toBeNull();
  });

  it("mapImport.review.terrain carries the report and the field's size", async () => {
    const r = await makeCaller(ctx.event, { user: member, authEnabled: true, authMode: "proxy" }).mapImport.review({ documentHash: demoHash });
    const row = (await readHeightfield(ctx.db, demoHash))!;
    expect(r.terrain).toMatchObject({ state: "ready", url: heightfieldUrl(demoHash), field: { width: row.header!.width, height: row.header!.height, cellMm: row.header!.cellMm } });
    expect(r.terrain.report).toEqual(row.report);
  });

  it("over a lowered cap the review says so", async () => {
    process.env.MAP_HEIGHTFIELD_MAX_CELLS = "1000000";
    try {
      const { terrainReview } = await import("../../map-store/heightfield.js");
      expect((await terrainReview(ctx.db, synthetic.huge)).state).toBe("over-cap");
    } finally {
      delete process.env.MAP_HEIGHTFIELD_MAX_CELLS;
    }
  });
});

describe("lifetime", () => {
  it("a row of a superseded terrain version is swept by the GC; the current one stays; a dry run only counts", async () => {
    const stale = { documentHash: synthetic.hill, source: "contours", version: TERRAIN_VERSION - 1 };
    await ctx.db.mapHeightfield.create({ data: stale });
    const newer = { documentHash: synthetic.hill, source: "contours", version: TERRAIN_VERSION + 1 };
    await ctx.db.mapHeightfield.create({ data: newer });
    const dry = await runStorageGc(ctx.db, { dryRun: true });
    expect(dry.heightfields).toBeGreaterThanOrEqual(1);
    expect(await ctx.db.mapHeightfield.count({ where: { documentHash: synthetic.hill } })).toBe(3);
    const run = await runStorageGc(ctx.db);
    expect(run.heightfields).toBeGreaterThanOrEqual(1);
    const left = await ctx.db.mapHeightfield.findMany({ where: { documentHash: synthetic.hill }, select: { version: true }, orderBy: { version: "asc" } });
    // `<`, not `<>`: a newer image's row survives an older image's run.
    expect(left.map((r) => r.version)).toEqual([TERRAIN_VERSION, TERRAIN_VERSION + 1]);
    await ctx.db.mapHeightfield.deleteMany({ where: { documentHash: synthetic.hill, version: TERRAIN_VERSION + 1 } });
  });

  it("the CHECK keeps bytes, size, header and report null together", async () => {
    await expect(ctx.db.mapHeightfield.create({ data: { documentHash: synthetic.flat, source: "check-test", version: 1, bytes: new Uint8Array([1]) } })).rejects.toThrow();
  });

  it("deleting the document deletes its height-field rows", async () => {
    expect(await ctx.db.mapHeightfield.count({ where: { documentHash: synthetic.hill } })).toBe(1);
    await ctx.db.clubMapVersion.deleteMany({ where: { documentHash: synthetic.hill } });
    await ctx.db.mapDocument.delete({ where: { hash: synthetic.hill } });
    expect(await ctx.db.mapHeightfield.count({ where: { documentHash: synthetic.hill } })).toBe(0);
  });
});
