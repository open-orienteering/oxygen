/**
 * Content-addressed map storage and the document route
 * (docs/map-storage.md): store + dedup, RESTRICT on referenced blobs,
 * `applyEventMap` pinning, and the `/api/map-documents/:hash` matrix —
 * 200 / 206 / 304 / 400 / 401 / 403 / 404 / 416, kiosk key, club-library
 * membership, compression on whole responses and never on ranges.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { randomBytes } from "crypto";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import Fastify, { type FastifyInstance } from "fastify";
import { SYSTEM_GROUP_IDS, mapDocument, symbolLibrary } from "@oxygen/shared";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { grantSystemGroup } from "../../permissions.js";
import { applyEventMap } from "../../event-map.js";
import { importOcadToDocument } from "../../import/ocad.js";
import { importAndStoreOcad, storeImportedDocument, buildImportReport } from "../../map-store/documents.js";
import { deleteBlob, getBlob, getBlobSize } from "../../map-store/blob-store.js";
import { MAP_DOCUMENT_CACHE_CONTROL, MAP_DOCUMENT_CONTENT_TYPE, registerMapDocumentRoutes, resetDocumentAccessCache } from "../../map-store/routes.js";
import type { AuthUser } from "../../auth.js";

const FIXTURE = resolve(__dirname, "../../../../../e2e/test.ocd");
const suffix = randomBytes(4).toString("hex");
const EMAIL_DOMAIN = `@map-docs-${suffix}.example`;

let ctx: TestEventContext;
let server: FastifyInstance;
let fixture: Buffer;
let documentHash: string;
let fileHash: string;
let size: number;
let member: AuthUser;
let stranger: AuthUser;
let previousAuthMode: string | undefined;

async function mkUser(name: string, isAdmin = false): Promise<AuthUser> {
  return ctx.db.user.create({ data: { email: `${name}${EMAIL_DOMAIN}`, displayName: name, isAdmin, active: true } });
}

const get = (url: string, headers: Record<string, string> = {}) => server.inject({ method: "GET", url, headers });

beforeAll(async () => {
  ctx = await createTestEvent("map_documents");
  // Per-run trailer: content-addressed rows are global, so the suite must not share bytes with other suites (see map-import-jobs.test.ts).
  fixture = Buffer.concat([readFileSync(FIXTURE), Buffer.from(`map-docs-${suffix}`)]);
  const admin = await mkUser("admin", true);
  member = await mkUser("member");
  stranger = await mkUser("stranger");
  await grantSystemGroup(ctx.db, { eventId: ctx.eventId, userId: member.id, groupId: SYSTEM_GROUP_IDS.courseSetter, grantedBy: admin.id });
  // A future date: completed events grant courses.view to every signed-in
  // user, which would mask the 403 cases below.
  await ctx.db.event.update({ where: { id: ctx.eventId }, data: { kioskKey: `kiosk-${suffix}`, date: new Date("2099-06-01T00:00:00Z") } });
  ctx.event.kioskKey = `kiosk-${suffix}`;
  ctx.event.date = new Date("2099-06-01T00:00:00Z");

  // The real upload path: pins source + document on the event's map row.
  const applied = await applyEventMap(ctx.db, ctx.eventId, "test.ocd", fixture, { uploadedBy: admin.id });
  expect(applied.documentHash).toMatch(/^[0-9a-f]{64}$/);
  documentHash = applied.documentHash!;
  const row = await ctx.db.mapFile.findFirstOrThrow({ where: { eventId: ctx.eventId } });
  fileHash = row.sourceHash!;
  size = (await getBlobSize(ctx.db, "map_documents", documentHash))!;

  server = Fastify({ logger: false });
  registerMapDocumentRoutes(server);
  await server.ready();
  previousAuthMode = process.env.AUTH_MODE;
  process.env.AUTH_MODE = "proxy";
  resetDocumentAccessCache();
}, 60_000);

afterAll(async () => {
  if (previousAuthMode === undefined) delete process.env.AUTH_MODE;
  else process.env.AUTH_MODE = previousAuthMode;
  await server?.close();
  // Pins go with the event; then the blobs are unreferenced and deletable.
  await ctx.cleanup();
  await ctx.db.clubMapVersion.deleteMany({ where: { documentHash } });
  await ctx.db.clubMap.deleteMany({ where: { name: { endsWith: suffix } } });
  await ctx.db.mapDocument.deleteMany({ where: { sourceHash: fileHash } });
  await ctx.db.mapSource.deleteMany({ where: { fileHash } });
  await ctx.db.user.deleteMany({ where: { email: { endsWith: EMAIL_DOMAIN } } });
  await disconnect();
}, 30_000);

describe("storeImportedDocument", () => {
  it("applyEventMap stored the source and the document, keyed by their hashes, with header summary and report", async () => {
    const row = await ctx.db.mapFile.findFirstOrThrow({ where: { eventId: ctx.eventId }, select: { sourceHash: true, documentHash: true, fileHash: true } });
    expect(row.sourceHash).toBe(row.fileHash);
    expect(row.documentHash).toBe(documentHash);
    const doc = await ctx.db.mapDocument.findUniqueOrThrow({ where: { hash: documentHash } });
    expect(doc.sourceHash).toBe(fileHash);
    expect(doc.sizeBytes).toBe(size);
    expect(doc.formatVersion).toBe(1);
    expect(doc.importerVersion).toBe("ocad-4");
    expect(doc.libraryVersion).toBe(`ISOM2017-2@${symbolLibrary.SYMBOL_LIBRARY_VERSION}`); // 1:7500 fixture → ISOM
    const header = doc.header as Record<string, unknown>;
    expect(header).toHaveProperty("mapScale");
    expect(header).toHaveProperty("bounds");
    expect(header).not.toHaveProperty("symbols");
    expect(header.symbolCount).toBeGreaterThan(0);
    const report = doc.report as { counts: { objects: number }; warnings: unknown[]; source: { fileHash: string } };
    expect(report.counts.objects).toBeGreaterThan(0);
    expect(report.source.fileHash).toBe(fileHash);
    const src = await ctx.db.mapSource.findUniqueOrThrow({ where: { fileHash } });
    expect(src.kind).toBe("ocad");
    expect(src.sizeBytes).toBe(fixture.byteLength);
    expect(Buffer.from(src.bytes).equals(fixture)).toBe(true);
  });

  it("storing the same bytes again is a no-op that reports deduplicated", async () => {
    const again = await importAndStoreOcad(ctx.db, fixture, "renamed.ocd");
    expect(again.documentHash).toBe(documentHash);
    expect(again.deduplicated).toBe(true);
    const sources = await ctx.db.mapSource.count({ where: { fileHash } });
    const docs = await ctx.db.mapDocument.count({ where: { hash: documentHash } });
    expect([sources, docs]).toEqual([1, 1]);
    // The first upload's name stays.
    expect((await ctx.db.mapSource.findUniqueOrThrow({ where: { fileHash } })).fileName).toBe("test.ocd");
  });

  it("refuses a document whose header names a different source", async () => {
    const result = await importOcadToDocument(fixture, "test.ocd");
    const { header } = mapDocument.readMapDocumentHeader(result.bytes);
    await expect(
      storeImportedDocument(ctx.db, {
        source: { bytes: fixture, fileHash: "0".repeat(64), kind: "ocad", fileName: "x.ocd" },
        document: { bytes: result.bytes, hash: result.documentHash },
        report: buildImportReport(result, header, "test.ocd"),
      }),
    ).rejects.toThrow(/imported from/);
  });

  it("a referenced document or source cannot be deleted (FK RESTRICT)", async () => {
    await expect(deleteBlob(ctx.db, "map_documents", documentHash)).rejects.toThrow();
    await expect(deleteBlob(ctx.db, "map_sources", fileHash)).rejects.toThrow();
  });

  it("blob reads: whole, sized, and sliced ranges match the bytes", async () => {
    const whole = (await getBlob(ctx.db, "map_documents", documentHash))!;
    expect(whole.byteLength).toBe(size);
    expect(whole.subarray(0, 4).toString()).toBe(mapDocument.MAP_DOCUMENT_MAGIC);
    const slice = (await getBlob(ctx.db, "map_documents", documentHash, { start: 10, end: 29 }))!;
    expect(slice.equals(whole.subarray(10, 30))).toBe(true);
    const tail = (await getBlob(ctx.db, "map_documents", documentHash, { start: size - 5, end: size - 1 }))!;
    expect(tail.equals(whole.subarray(size - 5))).toBe(true);
    expect(await getBlob(ctx.db, "map_documents", "f".repeat(64))).toBeNull();
  });

  it("course.mapMetadata exposes the pinned document hash", async () => {
    const meta = await makeCaller(ctx.event).course.mapMetadata();
    expect(meta?.documentHash).toBe(documentHash);
  });
});

describe("GET /api/map-documents/:hash", () => {
  const url = () => `/api/map-documents/${documentHash}`;
  const memberHeaders = () => ({ "x-forwarded-email": member.email });

  it("rejects malformed hashes with 400 before any lookup", async () => {
    expect((await get("/api/map-documents/not-a-hash")).statusCode).toBe(400);
    expect((await get(`/api/map-documents/${"g".repeat(64)}`)).statusCode).toBe(400);
  });

  it("anonymous → 401, signed-in without a reference → 403, unknown hash for an allowed caller → 404", async () => {
    expect((await get(url())).statusCode).toBe(401);
    expect((await get(url(), { "x-forwarded-email": stranger.email })).statusCode).toBe(403);
    expect((await get(url(), { "x-forwarded-email": stranger.email, "x-event-id": ctx.nameId })).statusCode).toBe(403);
    // Allowed principal, hash nobody pins: the predicate fails before existence is revealed.
    expect((await get(`/api/map-documents/${"e".repeat(64)}`, { ...memberHeaders(), "x-event-id": ctx.nameId })).statusCode).toBe(403);
  });

  it("serves the whole document to a member of the pinning event, identity-encoded when not negotiated", async () => {
    const res = await get(url(), { ...memberHeaders(), "x-event-id": ctx.nameId });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe(MAP_DOCUMENT_CONTENT_TYPE);
    expect(res.headers["cache-control"]).toBe(MAP_DOCUMENT_CACHE_CONTROL);
    expect(res.headers.etag).toBe(`"${documentHash}"`);
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(Number(res.headers["content-length"])).toBe(size);
    const doc = mapDocument.decodeMapDocument(new Uint8Array(res.rawPayload));
    expect(doc.header.source.hash).toBe(fileHash);
    expect(await mapDocument.mapDocumentHash(new Uint8Array(res.rawPayload))).toBe(documentHash);
  });

  it("accepts the event via ?event= and the kiosk key via header or ?k=", async () => {
    expect((await get(`${url()}?event=${ctx.nameId}`, memberHeaders())).statusCode).toBe(200);
    expect((await get(url(), { "x-event-id": ctx.nameId, "x-kiosk-key": ctx.event.kioskKey! })).statusCode).toBe(200);
    expect((await get(`${url()}?event=${ctx.nameId}&k=${ctx.event.kioskKey}`)).statusCode).toBe(200);
    expect((await get(`${url()}?event=${ctx.nameId}&k=wrong`)).statusCode).toBe(401);
  });

  it("compresses whole responses with brotli or gzip and decompresses to the same bytes", async () => {
    const br = await get(url(), { ...memberHeaders(), "x-event-id": ctx.nameId, "accept-encoding": "gzip, br" });
    expect(br.statusCode).toBe(200);
    expect(br.headers["content-encoding"]).toBe("br");
    expect(br.headers.vary).toContain("Accept-Encoding");
    expect(br.rawPayload.byteLength).toBeLessThan(size);
    expect(await mapDocument.mapDocumentHash(new Uint8Array(brotliDecompressSync(br.rawPayload)))).toBe(documentHash);
    const gz = await get(url(), { ...memberHeaders(), "x-event-id": ctx.nameId, "accept-encoding": "gzip" });
    expect(gz.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(gz.rawPayload).byteLength).toBe(size);
  });

  it("answers 304 to a matching If-None-Match", async () => {
    const res = await get(url(), { ...memberHeaders(), "x-event-id": ctx.nameId, "if-none-match": `"${documentHash}"` });
    expect(res.statusCode).toBe(304);
    expect(res.rawPayload.byteLength).toBe(0);
    expect(res.headers.etag).toBe(`"${documentHash}"`);
  });

  it("serves a single byte range as 206 from a slice, never compressed; 416 past the end", async () => {
    const whole = (await getBlob(ctx.db, "map_documents", documentHash))!;
    const res = await get(url(), { ...memberHeaders(), "x-event-id": ctx.nameId, range: "bytes=4-19", "accept-encoding": "br, gzip" });
    expect(res.statusCode).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes 4-19/${size}`);
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(Number(res.headers["content-length"])).toBe(16);
    expect(Buffer.from(res.rawPayload).equals(whole.subarray(4, 20))).toBe(true);
    const suffixRange = await get(url(), { ...memberHeaders(), "x-event-id": ctx.nameId, range: "bytes=-8" });
    expect(suffixRange.statusCode).toBe(206);
    expect(suffixRange.headers["content-range"]).toBe(`bytes ${size - 8}-${size - 1}/${size}`);
    const bad = await get(url(), { ...memberHeaders(), "x-event-id": ctx.nameId, range: `bytes=${size}-` });
    expect(bad.statusCode).toBe(416);
    expect(bad.headers["content-range"]).toBe(`bytes */${size}`);
    const multi = await get(url(), { ...memberHeaders(), "x-event-id": ctx.nameId, range: "bytes=0-1,4-5" });
    expect(multi.statusCode).toBe(200);
  });

  it("a club-library version makes the document visible to any signed-in user, without an event", async () => {
    const clubMap = await ctx.db.clubMap.create({ data: { name: `Club map ${suffix}` } });
    await ctx.db.clubMapVersion.create({ data: { clubMapId: clubMap.id, seq: 1, sourceHash: fileHash, documentHash } });
    resetDocumentAccessCache();
    expect((await get(url(), { "x-forwarded-email": stranger.email })).statusCode).toBe(200);
    expect((await get(url())).statusCode).toBe(401);
    // Deleting the version leaves the event's pin (SET NULL semantics only apply to club_map_version_id).
    await ctx.db.clubMapVersion.deleteMany({ where: { clubMapId: clubMap.id } });
    await ctx.db.clubMap.delete({ where: { id: clubMap.id } });
    resetDocumentAccessCache();
    expect((await get(url(), { "x-forwarded-email": stranger.email })).statusCode).toBe(403);
    expect((await ctx.db.mapFile.findFirstOrThrow({ where: { eventId: ctx.eventId } })).documentHash).toBe(documentHash);
  });

  it("the user who started a non-failed import job that produced the document may read it without an event", async () => {
    const job = await ctx.db.mapImportJob.create({ data: { eventId: ctx.eventId, sourceHash: fileHash, state: "done", documentHash, startedBy: stranger.id } });
    try {
      resetDocumentAccessCache();
      expect((await get(url(), { "x-forwarded-email": stranger.email })).statusCode).toBe(200);
      expect((await get(url(), { "x-forwarded-email": member.email })).statusCode).toBe(403); // not their job, no event given
      expect((await get(url())).statusCode).toBe(401);
      await ctx.db.mapImportJob.update({ where: { id: job.id }, data: { state: "failed" } });
      resetDocumentAccessCache();
      expect((await get(url(), { "x-forwarded-email": stranger.email })).statusCode).toBe(403);
    } finally {
      await ctx.db.mapImportJob.delete({ where: { id: job.id } });
      resetDocumentAccessCache();
    }
  });

  it("with auth off everything that exists is served", async () => {
    process.env.AUTH_MODE = "off";
    resetDocumentAccessCache();
    try {
      expect((await get(url())).statusCode).toBe(200);
      expect((await get(`/api/map-documents/${"e".repeat(64)}`)).statusCode).toBe(404);
    } finally {
      process.env.AUTH_MODE = "proxy";
      resetDocumentAccessCache();
    }
  });
});
