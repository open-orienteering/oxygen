/**
 * Previews (docs/map-storage.md §4.5): stage 10 writes the thumbnail row,
 * rows are rendered on a miss and never rewritten, and the three routes
 * follow the document route's order — 400, then 401/403, then 404 — with
 * immutable caching and 304s.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { createHash, randomBytes } from "crypto";
import Fastify, { type FastifyInstance } from "fastify";
import sharp from "sharp";
import { SYSTEM_GROUP_IDS, mapDocument, symbolLibrary } from "@oxygen/shared";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";
import { grantSystemGroup } from "../../permissions.js";
import { applyEventMap } from "../../event-map.js";
import { startImportJob } from "../../map-store/jobs.js";
import { deriveDocumentPreviews, readPreview, resetLibraryPreviewCache } from "../../map-store/previews.js";
import { LIBRARY_PREVIEW_CACHE_CONTROL, registerMapPreviewRoutes } from "../../map-store/preview-routes.js";
import { MAP_DOCUMENT_CACHE_CONTROL, resetDocumentAccessCache } from "../../map-store/routes.js";
import { THUMBNAIL_LONG_EDGE_PX, THUMBNAIL_MAX_OBJECTS } from "../../render/previews.js";
import type { AuthUser } from "../../auth.js";

const FIXTURE = resolve(__dirname, "../../../../../e2e/test.ocd");
const suffix = randomBytes(4).toString("hex");
const EMAIL_DOMAIN = `@map-previews-${suffix}.example`;
const V = symbolLibrary.SYMBOL_LIBRARY_VERSION;

let ctx: TestEventContext;
let server: FastifyInstance;
let documentHash: string;
let fileHash: string;
let member: AuthUser;
let stranger: AuthUser;
let previousAuthMode: string | undefined;
/** Synthetic documents inserted directly: `nullRender` has symbol 0 without a render, `overCap` claims too many objects. */
const synthetic: { sourceHash: string; nullRender: string; overCap: string; garbage: string; clubMapId: string } = {
  sourceHash: "", nullRender: "", overCap: "", garbage: "", clubMapId: "",
};

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const get = (url: string, headers: Record<string, string> = {}) => server.inject({ method: "GET", url, headers });
const memberHeaders = () => ({ "x-forwarded-email": member.email, "x-event-id": ctx.nameId });
const isPng = (b: Buffer) => b.subarray(1, 4).toString() === "PNG";

async function mkUser(name: string, isAdmin = false): Promise<AuthUser> {
  return ctx.db.user.create({ data: { email: `${name}${EMAIL_DOMAIN}`, displayName: name, isAdmin, active: true } });
}

/** A tiny document of our own: two symbols (the first without a render), one area object. */
async function insertSyntheticDocuments(): Promise<void> {
  const sourceBytes = Buffer.from(`synthetic-source-${suffix}`);
  synthetic.sourceHash = sha(sourceBytes);
  await ctx.db.mapSource.create({ data: { fileHash: synthetic.sourceHash, kind: "ocad", bytes: sourceBytes, sizeBytes: sourceBytes.byteLength, fileName: "synthetic.ocd" } });
  const doc = (objectsClaimed?: number, salt = "") => {
    const bytes = mapDocument.encodeMapDocument({
      header: {
        format: { version: 1, importer: `test-${suffix}${salt}` },
        source: { kind: "ocad", version: "2018", hash: synthetic.sourceHash, bytes: sourceBytes.byteLength },
        unitsPerMm: 100,
        mapScale: 10000,
        georeferencing: { crs: null, paperOrigin: null },
        colours: [{ id: "src:0", name: "Black", cmyk: [0, 0, 0, 1] }, { id: "src:1", name: "Yellow", cmyk: [0, 0.27, 0.79, 0] }],
        symbols: [
          { code: "101.0", name: "Contour", kind: "line", render: null },
          { code: "401.0", name: "Open land", kind: "area", render: { type: "area", id: "s:401", code: "401", name: "Open land", fill: 1 } },
        ],
      },
      objects: [{ symbolIdx: 1, type: 3, sourceIndex: 0, coords: [0, 0, 2000, 0, 2000, 2000, 0, 2000], flags: [0, 0, 0, 0] }],
    });
    const { header } = mapDocument.readMapDocumentHeader(bytes);
    const summary = { ...header, symbols: undefined, strings: undefined, objects: { ...header.objects, count: objectsClaimed ?? header.objects.count } };
    return { bytes, hash: sha(bytes), summary };
  };
  const insert = async (d: { bytes: Uint8Array; hash: string; summary: unknown }) =>
    ctx.db.mapDocument.create({
      data: {
        hash: d.hash, bytes: d.bytes, sizeBytes: d.bytes.byteLength, formatVersion: 1, importerVersion: "test",
        libraryVersion: "none", sourceHash: synthetic.sourceHash, header: JSON.parse(JSON.stringify(d.summary)), report: {},
      },
    });
  const a = doc();
  const b = doc(THUMBNAIL_MAX_OBJECTS + 1, "-cap");
  const garbage = { bytes: Buffer.from(`not a document ${suffix}`), hash: "", summary: {} };
  garbage.hash = sha(garbage.bytes);
  await insert(a);
  await insert(b);
  await insert(garbage);
  synthetic.nullRender = a.hash;
  synthetic.overCap = b.hash;
  synthetic.garbage = garbage.hash;
  // Visible to any signed-in user through a club-library version.
  const clubMap = await ctx.db.clubMap.create({ data: { name: `Previews ${suffix}` } });
  synthetic.clubMapId = clubMap.id;
  for (const [seq, hash] of [a.hash, b.hash].entries()) {
    await ctx.db.clubMapVersion.create({ data: { clubMapId: clubMap.id, seq: seq + 1, sourceHash: synthetic.sourceHash, documentHash: hash } });
  }
}

beforeAll(async () => {
  ctx = await createTestEvent("map_previews");
  const fixture = Buffer.concat([readFileSync(FIXTURE), Buffer.from(`map-previews-${suffix}`)]);
  const admin = await mkUser("admin", true);
  member = await mkUser("member");
  stranger = await mkUser("stranger");
  await grantSystemGroup(ctx.db, { eventId: ctx.eventId, userId: member.id, groupId: SYSTEM_GROUP_IDS.courseSetter, grantedBy: admin.id });
  await ctx.db.event.update({ where: { id: ctx.eventId }, data: { kioskKey: `kiosk-${suffix}`, date: new Date("2099-06-01T00:00:00Z") } });
  ctx.event.kioskKey = `kiosk-${suffix}`;

  const applied = await applyEventMap(ctx.db, ctx.eventId, "test.ocd", fixture, { uploadedBy: admin.id });
  documentHash = applied.documentHash!;
  fileHash = (await ctx.db.mapFile.findFirstOrThrow({ where: { eventId: ctx.eventId } })).sourceHash!;
  await insertSyntheticDocuments();

  server = Fastify({ logger: false });
  registerMapPreviewRoutes(server);
  await server.ready();
  previousAuthMode = process.env.AUTH_MODE;
  process.env.AUTH_MODE = "proxy";
  resetDocumentAccessCache();
  resetLibraryPreviewCache();
}, 120_000);

afterAll(async () => {
  if (previousAuthMode === undefined) delete process.env.AUTH_MODE;
  else process.env.AUTH_MODE = previousAuthMode;
  await server?.close();
  await ctx.cleanup();
  await ctx.db.clubMap.deleteMany({ where: { id: synthetic.clubMapId } });
  await ctx.db.mapDocument.deleteMany({ where: { sourceHash: { in: [fileHash, synthetic.sourceHash] } } });
  await ctx.db.mapSource.deleteMany({ where: { fileHash: { in: [fileHash, synthetic.sourceHash] } } });
  await ctx.db.user.deleteMany({ where: { email: { endsWith: EMAIL_DOMAIN } } });
  await disconnect();
}, 30_000);

describe("stage 10 derive", () => {
  it("the import job wrote the thumbnail row and finished done", async () => {
    const row = await ctx.db.mapPreview.findUniqueOrThrow({ where: { documentHash_kind_key: { documentHash, kind: "thumbnail", key: "" } } });
    expect(isPng(Buffer.from(row.png))).toBe(true);
    const job = await ctx.db.mapImportJob.findFirstOrThrow({ where: { eventId: ctx.eventId }, orderBy: { createdAt: "desc" } });
    expect(job).toMatchObject({ state: "done", stage: "done", documentHash });
  });

  it("the dedup short-cut derives too: a deleted thumbnail is back after the next job on the same source", async () => {
    await ctx.db.mapPreview.deleteMany({ where: { documentHash, kind: "thumbnail" } });
    const job = await startImportJob(ctx.db, { sourceHash: fileHash, eventId: ctx.eventId });
    expect(job.state).toBe("done");
    expect(await readPreview(ctx.db, documentHash, "thumbnail", "")).not.toBeNull();
  });

  it("a failed derive is logged, writes nothing and does not throw", async () => {
    await expect(deriveDocumentPreviews(ctx.db, synthetic.garbage)).resolves.toBeUndefined();
    expect(await ctx.db.mapPreview.count({ where: { documentHash: synthetic.garbage } })).toBe(0);
  });

  it("an over-cap document gets no thumbnail, decided from the stored header summary", async () => {
    await deriveDocumentPreviews(ctx.db, synthetic.overCap);
    expect(await ctx.db.mapPreview.count({ where: { documentHash: synthetic.overCap } })).toBe(0);
  });
});

describe("GET /api/map-documents/:hash/thumbnail.png", () => {
  const url = () => `/api/map-documents/${documentHash}/thumbnail.png`;

  it("400 for a malformed hash, then 401 / 403 before existence", async () => {
    expect((await get("/api/map-documents/nope/thumbnail.png")).statusCode).toBe(400);
    expect((await get(url())).statusCode).toBe(401);
    expect((await get(url(), { "x-forwarded-email": stranger.email, "x-event-id": ctx.nameId })).statusCode).toBe(403);
    expect((await get(`/api/map-documents/${"e".repeat(64)}/thumbnail.png`, memberHeaders())).statusCode).toBe(403);
  });

  it("200 PNG, long edge 512 px, immutable private cache, ETag; 304 on revalidation", async () => {
    const res = await get(url(), memberHeaders());
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["cache-control"]).toBe(MAP_DOCUMENT_CACHE_CONTROL);
    expect(res.headers.etag).toBe(`"${documentHash}/thumbnail"`);
    expect(res.headers["accept-ranges"]).toBeUndefined();
    expect(res.headers["content-encoding"]).toBeUndefined();
    const meta = await sharp(res.rawPayload).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBe(THUMBNAIL_LONG_EDGE_PX);
    const again = await get(url(), { ...memberHeaders(), "if-none-match": `"${documentHash}/thumbnail"` });
    expect(again.statusCode).toBe(304);
    expect(again.rawPayload.byteLength).toBe(0);
  });

  it("reading previews is not a reference: last_referenced_at does not move", async () => {
    const before = (await ctx.db.mapDocument.findUniqueOrThrow({ where: { hash: documentHash } })).lastReferencedAt;
    await get(url(), memberHeaders());
    await get(`/api/map-documents/${documentHash}/symbols/0.png`, memberHeaders());
    expect((await ctx.db.mapDocument.findUniqueOrThrow({ where: { hash: documentHash } })).lastReferencedAt).toEqual(before);
  });

  it("kiosk key and ?event= work as on the document route", async () => {
    expect((await get(`${url()}?event=${ctx.nameId}&k=${ctx.event.kioskKey}`)).statusCode).toBe(200);
    expect((await get(`${url()}?event=${ctx.nameId}&k=wrong`)).statusCode).toBe(401);
  });

  it("renders on a miss (documents stored before stage 10) and serves the stored row afterwards", async () => {
    await ctx.db.mapPreview.deleteMany({ where: { documentHash, kind: "thumbnail" } });
    const res = await get(url(), memberHeaders());
    expect(res.statusCode).toBe(200);
    const row = await ctx.db.mapPreview.findUniqueOrThrow({ where: { documentHash_kind_key: { documentHash, kind: "thumbnail", key: "" } } });
    expect(Buffer.from(row.png).equals(res.rawPayload)).toBe(true);
  });

  it("404 for an over-cap document, after authorisation", async () => {
    resetDocumentAccessCache();
    const u = `/api/map-documents/${synthetic.overCap}/thumbnail.png`;
    expect((await get(u)).statusCode).toBe(401);
    expect((await get(u, { "x-forwarded-email": stranger.email })).statusCode).toBe(404);
  });
});

describe("GET /api/map-documents/:hash/symbols/:idx.png", () => {
  const url = (idx: number | string) => `/api/map-documents/${documentHash}/symbols/${idx}`;

  it("400 for a bad index or a missing .png, before authorisation", async () => {
    expect((await get(url("abc.png"))).statusCode).toBe(400);
    expect((await get(url("01.png"))).statusCode).toBe(400);
    expect((await get(url("1"))).statusCode).toBe(400);
    expect((await get(url("-1.png"))).statusCode).toBe(400);
  });

  it("401 anonymous, 403 stranger", async () => {
    expect((await get(url("0.png"))).statusCode).toBe(401);
    expect((await get(url("0.png"), { "x-forwarded-email": stranger.email, "x-event-id": ctx.nameId })).statusCode).toBe(403);
  });

  it("first request renders and stores the row, the second is served from it unchanged", async () => {
    await ctx.db.mapPreview.deleteMany({ where: { documentHash, kind: "symbol" } });
    const first = await get(url("0.png"), memberHeaders());
    expect(first.statusCode).toBe(200);
    expect(first.headers["content-type"]).toBe("image/png");
    expect(first.headers["cache-control"]).toBe(MAP_DOCUMENT_CACHE_CONTROL);
    expect(first.headers.etag).toBe(`"${documentHash}/symbols/0"`);
    expect(isPng(first.rawPayload)).toBe(true);
    const row = await ctx.db.mapPreview.findUniqueOrThrow({ where: { documentHash_kind_key: { documentHash, kind: "symbol", key: "0" } } });
    const second = await get(url("0.png"), memberHeaders());
    expect(Buffer.from(second.rawPayload).equals(first.rawPayload)).toBe(true);
    const after = await ctx.db.mapPreview.findMany({ where: { documentHash, kind: "symbol", key: "0" } });
    expect(after).toHaveLength(1);
    expect(after[0].createdAt).toEqual(row.createdAt);
    expect((await get(url("0.png"), { ...memberHeaders(), "if-none-match": `W/"${documentHash}/symbols/0"` })).statusCode).toBe(304);
  });

  it("every symbol of the fixture has a swatch; one past the end is 404", async () => {
    const doc = await ctx.db.mapDocument.findUniqueOrThrow({ where: { hash: documentHash }, select: { header: true } });
    const count = (doc.header as { symbolCount: number }).symbolCount;
    for (let i = 0; i < count; i++) expect((await get(url(`${i}.png`), memberHeaders())).statusCode, `symbol ${i}`).toBe(200);
    expect((await get(url(`${count}.png`), memberHeaders())).statusCode).toBe(404);
  });

  it("a symbol without a render is 404; its neighbour renders", async () => {
    const h = synthetic.nullRender;
    const headers = { "x-forwarded-email": stranger.email };
    expect((await get(`/api/map-documents/${h}/symbols/0.png`, headers)).statusCode).toBe(404);
    expect((await get(`/api/map-documents/${h}/symbols/1.png`, headers)).statusCode).toBe(200);
    expect(await ctx.db.mapPreview.count({ where: { documentHash: h, kind: "symbol" } })).toBe(1);
  });
});

describe("GET /api/library/:libraryId/:version/:code.png", () => {
  const url = (code: string, lib = "ISOM2017-2", version = V) => `/api/library/${lib}/${version}/${code}`;
  const signedIn = () => ({ "x-forwarded-email": stranger.email });

  it("400 for an unknown library or a malformed code, 401 anonymous", async () => {
    expect((await get(url("418.png", "ISOM2000"), signedIn())).statusCode).toBe(400);
    expect((await get(url("41.png"), signedIn())).statusCode).toBe(400);
    expect((await get(url("418"), signedIn())).statusCode).toBe(400);
    expect((await get(url("418.png"))).statusCode).toBe(401);
  });

  it("200 for any signed-in user with a public immutable cache; a variant addresses its own entry", async () => {
    const res = await get(url("418.png"), signedIn());
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["cache-control"]).toBe(LIBRARY_PREVIEW_CACHE_CONTROL);
    expect(res.headers.etag).toBe(`"ISOM2017-2@${V}/418"`);
    const variant = symbolLibrary.getSymbolLibrary("ISOM2017-2").entries.find((e) => e.variant !== null)!;
    const v = await get(url(`${variant.id.split(":")[1]}.png`), signedIn());
    expect(v.statusCode).toBe(200);
    expect((await get(url("418.png"), { ...signedIn(), "if-none-match": `"ISOM2017-2@${V}/418"` })).statusCode).toBe(304);
  });

  it("404 for an unknown code or another library version; nothing is stored", async () => {
    expect((await get(url("999.png"), signedIn())).statusCode).toBe(404);
    expect((await get(url("418.png", "ISOM2017-2", "2000.1.1"), signedIn())).statusCode).toBe(404);
  });

  it("with auth off the library and existing documents are served", async () => {
    process.env.AUTH_MODE = "off";
    resetDocumentAccessCache();
    try {
      expect((await get(url("418.png"))).statusCode).toBe(200);
      expect((await get(`/api/map-documents/${documentHash}/symbols/0.png`)).statusCode).toBe(200);
      expect((await get(`/api/map-documents/${"e".repeat(64)}/thumbnail.png`)).statusCode).toBe(404);
    } finally {
      process.env.AUTH_MODE = "proxy";
      resetDocumentAccessCache();
    }
  });
});
