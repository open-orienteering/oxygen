/**
 * `GET /api/map-documents/:hash/colour-order/:order.json` (row I8a;
 * docs/map-storage.md §4.5 "The other order's document", docs/map-symbols.md
 * §8.7 "Compare"), on e2e/colour-layers.ocd: the document the colour switch
 * gives, without the picture —
 *
 *   - its own order: the document itself, no job
 *   - the other order: imported once, then by dedup; back again; nothing
 *     pinned, no setting written; the same document the picture draws from
 *   - a `source` document's IOF side with the map's overrides (`?deviations=`)
 *   - a second user may fetch the document they got (the own-job clause)
 *   - 400 / 401 / 403 / 404; 503 + Retry-After, then 200; 502 remembered
 *   - `?event=`: a reader with courses.view on the event's own map
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { createHash, randomBytes } from "crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { SYSTEM_GROUP_IDS, mapDocument } from "@oxygen/shared";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { grantSystemGroup } from "../../permissions.js";
import { applyEventMap } from "../../event-map.js";
import { startImportJob } from "../../map-store/jobs.js";
import { getBlob } from "../../map-store/blob-store.js";
import { resetColourPictureFailures } from "../../map-store/colour-pictures.js";
import { registerMapPreviewRoutes } from "../../map-store/preview-routes.js";
import { registerMapDocumentRoutes, resetDocumentAccessCache } from "../../map-store/routes.js";
import type { AuthUser } from "../../auth.js";

const FIXTURE = resolve(__dirname, "../../../../../e2e/colour-layers.ocd");
const suffix = randomBytes(4).toString("hex");
const EMAIL_DOMAIN = `@map-order-doc-${suffix}.example`;
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const PAVED_BUILDING = "brown50-paved>black50-building";

let E: TestEventContext;
let clubSource: string;
let eventFile: Buffer;
let eventSource: string;
let clubMapId: string;
let iofDoc: string;
let sourceDoc: string;
let setter: AuthUser;
let other: AuthUser;
let viewer: AuthUser;
let server: FastifyInstance;
let previousAuthMode: string | undefined;
const extraSources: string[] = [];

async function mkUser(name: string): Promise<AuthUser> {
  return E.db.user.create({ data: { email: `${name}${EMAIL_DOMAIN}`, displayName: name, isAdmin: false, active: true } });
}
const as = (user: AuthUser) => makeCaller(null, { user, authEnabled: true, authMode: "proxy" });
const orderOf = async (hash: string) => mapDocument.readMapDocumentHeader((await getBlob(E.db, "map_documents", hash))!).header.colourOrder?.order;
const club = () => ({ kind: "club" as const, clubMapId });
const get = (url: string, user?: AuthUser | null, extra: Record<string, string> = {}) =>
  server.inject({ method: "GET", url, headers: { ...(user ? { "x-forwarded-email": user.email } : {}), ...extra } });
const docUrl = (hash: string, order: string, q = "") => `/api/map-documents/${hash}/colour-order/${order}.json${q}`;
/** The document hash a 200 answers with; fails the test on any other status. */
async function hashOf(url: string, user: AuthUser, extra: Record<string, string> = {}): Promise<string> {
  const res = await get(url, user, extra);
  expect(res.statusCode, res.body).toBe(200);
  expect(res.headers["cache-control"]).toBe("no-store");
  return (res.json() as { documentHash: string }).documentHash;
}

/** A fresh copy of the fixture as a club map: its source and its IOF document. */
async function freshClubMap(tag: string): Promise<{ source: string; mapId: string; doc: string }> {
  const file = Buffer.concat([readFileSync(FIXTURE), Buffer.from(`map-order-doc-${tag}-${suffix}`)]);
  const source = sha256(file);
  extraSources.push(source);
  await E.db.mapSource.create({ data: { fileHash: source, kind: "ocad", bytes: Uint8Array.from(file), sizeBytes: file.byteLength, fileName: `${tag}.ocd` } });
  const mapId = (await E.db.clubMap.create({ data: { name: `order-doc-${tag}-${suffix}` } })).id;
  await startImportJob(E.db, { sourceHash: source, clubMapId: mapId });
  const doc = (await E.db.clubMapVersion.findFirstOrThrow({ where: { clubMapId: mapId }, select: { documentHash: true } })).documentHash;
  return { source, mapId, doc };
}

beforeAll(async () => {
  E = await createTestEvent("order_doc");
  ({ source: clubSource, mapId: clubMapId, doc: iofDoc } = await freshClubMap("club"));
  eventFile = Buffer.concat([readFileSync(FIXTURE), Buffer.from(`map-order-doc-event-${suffix}`)]);
  eventSource = sha256(eventFile);
  setter = await mkUser("setter");
  other = await mkUser("other");
  viewer = await mkUser("viewer");
  await grantSystemGroup(E.db, { eventId: E.eventId, userId: setter.id, groupId: SYSTEM_GROUP_IDS.courseSetter, grantedBy: setter.id });
  await E.db.event.update({ where: { id: E.eventId }, data: { date: new Date("2099-06-01T00:00:00Z") } });
  E.event.date = new Date("2099-06-01T00:00:00Z");
  const group = await E.db.permissionGroup.create({ data: { name: `Order doc viewer ${suffix}`, capabilities: ["event.view", "courses.view"] } });
  await E.db.eventPermission.create({ data: { eventId: E.eventId, userId: viewer.id, groupId: group.id } });
  server = Fastify({ logger: false });
  registerMapPreviewRoutes(server);
  registerMapDocumentRoutes(server);
  await server.ready();
  previousAuthMode = process.env.AUTH_MODE;
  process.env.AUTH_MODE = "proxy";
  resetDocumentAccessCache();
  resetColourPictureFailures();
}, 120_000);

afterAll(async () => {
  if (previousAuthMode === undefined) delete process.env.AUTH_MODE;
  else process.env.AUTH_MODE = previousAuthMode;
  await server?.close();
  const sources = [clubSource, eventSource, ...extraSources];
  await E?.cleanup();
  await E.db.mapImportJob.deleteMany({ where: { sourceHash: { in: sources } } });
  await E.db.clubMap.deleteMany({ where: { name: { contains: suffix } } });
  await E.db.mapDocument.deleteMany({ where: { sourceHash: { in: sources } } });
  await E.db.mapSource.deleteMany({ where: { fileHash: { in: sources } } });
  await E.db.permissionGroup.deleteMany({ where: { name: { contains: suffix } } });
  await E.db.user.deleteMany({ where: { email: { endsWith: EMAIL_DOMAIN } } });
  await disconnect();
}, 60_000);

describe("GET /api/map-documents/:hash/colour-order/:order.json on a club map", () => {
  it("answers the document's own order with the document itself, without a job", async () => {
    const jobs = await E.db.mapImportJob.count({ where: { sourceHash: clubSource } });
    expect(await hashOf(docUrl(iofDoc, "iof"), setter)).toBe(iofDoc);
    expect(await E.db.mapImportJob.count({ where: { sourceHash: clubSource } })).toBe(jobs);
  });

  it("imports the other order once, finds it by dedup after, and answers back the other way", async () => {
    const jobs = await E.db.mapImportJob.count({ where: { sourceHash: clubSource } });
    sourceDoc = await hashOf(docUrl(iofDoc, "source"), setter);
    expect(sourceDoc).not.toBe(iofDoc);
    expect(await orderOf(sourceDoc)).toBe("source");
    expect(await E.db.mapImportJob.count({ where: { sourceHash: clubSource, clubMapId: null, colour: { equals: { order: "source", deviations: {} } } } })).toBe(1);
    expect(await E.db.mapImportJob.count({ where: { sourceHash: clubSource } })).toBe(jobs + 1);
    expect(await hashOf(docUrl(iofDoc, "source"), setter)).toBe(sourceDoc);
    expect(await hashOf(docUrl(sourceDoc, "iof"), setter)).toBe(iofDoc);
    expect(await hashOf(docUrl(sourceDoc, "source"), setter)).toBe(sourceDoc);
    // Nothing pinned, no setting written, nothing left running.
    expect((await E.db.clubMapVersion.findFirstOrThrow({ where: { clubMapId }, select: { documentHash: true } })).documentHash).toBe(iofDoc);
    expect(await E.db.mapColourSetting.count({ where: { clubMapId } })).toBe(0);
    expect(await E.db.mapImportJob.count({ where: { sourceHash: clubSource, state: { not: "done" } } })).toBe(0);
  }, 90_000);

  it("is the document the picture draws its other order from: the picture imports nothing more", async () => {
    const jobs = await E.db.mapImportJob.count({ where: { sourceHash: clubSource } });
    expect((await get(`/api/map-documents/${iofDoc}/colour-order/source.png`, setter)).statusCode).toBe(200);
    expect(await E.db.mapImportJob.count({ where: { sourceHash: clubSource, documentHash: { notIn: [iofDoc, sourceDoc] } } })).toBe(0);
    expect(await E.db.mapImportJob.count({ where: { sourceHash: clubSource } })).toBeLessThanOrEqual(jobs + 1);
  }, 60_000);

  it("gives a source document's IOF side with the map's overrides from ?deviations=", async () => {
    const kept = await as(setter).mapImport.setDeviation({ documentHash: iofDoc, key: PAVED_BUILDING, choice: "keep", target: club() });
    const keptDoc = kept.job.documentHash!;
    expect(keptDoc).not.toBe(iofDoc);
    const q = `?deviations=${encodeURIComponent(`${PAVED_BUILDING}:keep`)}`;
    expect(await hashOf(docUrl(sourceDoc, "iof", q), setter)).toBe(keptDoc);
    // Without overrides: the defaults' document.
    expect(await hashOf(docUrl(sourceDoc, "iof"), setter)).toBe(iofDoc);
    // On an IOF document the query names nothing: its own order is itself.
    expect(await hashOf(docUrl(iofDoc, "iof", q), setter)).toBe(iofDoc);
    await as(setter).mapImport.setDeviation({ documentHash: keptDoc, key: PAVED_BUILDING, choice: "default", target: club() });
  }, 120_000);

  it("lets a second user fetch the document they got, when the first user's import gave it", async () => {
    const fresh = await freshClubMap("fetch");
    const theirs = await hashOf(docUrl(fresh.doc, "source"), other);
    // A document no club version pins: readable only through a job of one's own (§4.2).
    expect((await get(`/api/map-documents/${theirs}`, setter)).statusCode).toBe(403);
    resetDocumentAccessCache();
    const mine = await hashOf(docUrl(fresh.doc, "source"), setter);
    expect(mine).toBe(theirs);
    expect((await get(`/api/map-documents/${mine}`, setter)).statusCode).toBe(200);
  }, 120_000);

  it("validates, then authorises, then looks up", async () => {
    expect((await get(docUrl(iofDoc, "mapper"), setter)).statusCode).toBe(400);
    expect((await get(`/api/map-documents/nothex/colour-order/iof.json`, setter)).statusCode).toBe(400);
    expect((await get(docUrl(iofDoc, "iof", "?deviations=nonsense"), setter)).statusCode).toBe(400);
    expect((await get(docUrl(iofDoc, "iof"))).statusCode).toBe(401);
    expect((await get(docUrl("f".repeat(64), "iof"), setter)).statusCode).toBe(403);
    process.env.AUTH_MODE = "off";
    resetDocumentAccessCache();
    try {
      expect((await get(docUrl("e".repeat(64), "iof"))).statusCode).toBe(404);
    } finally {
      process.env.AUTH_MODE = "proxy";
      resetDocumentAccessCache();
    }
  });

  it("answers 503 with Retry-After while the other order is still importing, then the document", async () => {
    const fresh = await freshClubMap("wait");
    resetColourPictureFailures();
    const previous = process.env.MAP_COLOUR_PICTURE_WAIT_MS;
    process.env.MAP_COLOUR_PICTURE_WAIT_MS = "0";
    try {
      const pending = await get(docUrl(fresh.doc, "source"), setter);
      expect(pending.statusCode).toBe(503);
      expect(pending.headers["retry-after"]).toBe("5");
      expect(pending.headers["cache-control"]).toBe("no-store");
    } finally {
      if (previous === undefined) delete process.env.MAP_COLOUR_PICTURE_WAIT_MS;
      else process.env.MAP_COLOUR_PICTURE_WAIT_MS = previous;
    }
    await expect.poll(async () => (await get(docUrl(fresh.doc, "source"), setter)).statusCode, { timeout: 30_000 }).toBe(200);
  }, 90_000);

  it("answers 502 for an import that fails, and does not start it again for a while", async () => {
    const bad = Buffer.from(`not a map ${suffix}`);
    const badSource = sha256(bad);
    extraSources.push(badSource);
    await E.db.mapSource.create({ data: { fileHash: badSource, kind: "ocad", bytes: Uint8Array.from(bad), sizeBytes: bad.byteLength, fileName: "bad.ocd" } });
    const doc = await E.db.mapDocument.findUniqueOrThrow({ where: { hash: iofDoc }, select: { bytes: true, sizeBytes: true, formatVersion: true, importerVersion: true, libraryVersion: true, header: true, report: true } });
    const fakeHash = sha256(Buffer.from(`fake-doc-${suffix}`));
    await E.db.mapDocument.create({ data: { hash: fakeHash, sourceHash: badSource, ...doc, header: doc.header ?? {}, report: doc.report ?? {} } });
    await E.db.mapImportJob.create({ data: { sourceHash: badSource, state: "done", documentHash: fakeHash, startedBy: setter.id } });
    resetColourPictureFailures();
    try {
      expect((await get(docUrl(fakeHash, "source"), setter)).statusCode).toBe(502);
      const jobs = await E.db.mapImportJob.count({ where: { sourceHash: badSource } });
      expect((await get(docUrl(fakeHash, "source"), setter)).statusCode).toBe(502);
      expect(await E.db.mapImportJob.count({ where: { sourceHash: badSource } })).toBe(jobs);
      // Its own order needs no import.
      expect(await hashOf(docUrl(fakeHash, "iof"), setter)).toBe(fakeHash);
    } finally {
      resetColourPictureFailures();
    }
  }, 60_000);
});

describe("GET …/colour-order/:order.json on an event's own map", () => {
  it("answers a reader with courses.view through ?event=, who may then fetch the document", async () => {
    const own = (await applyEventMap(E.db, E.eventId, "own.ocd", eventFile, { startedBy: setter.id })).documentHash!;
    expect((await get(docUrl(own, "source"), viewer)).statusCode).toBe(403);
    const hash = await hashOf(docUrl(own, "source", `?event=${encodeURIComponent(E.event.nameId)}`), viewer);
    expect(hash).not.toBe(own);
    expect(await orderOf(hash)).toBe("source");
    expect((await get(`/api/map-documents/${hash}`, viewer, { "x-event-id": E.event.nameId })).statusCode).toBe(200);
  }, 90_000);
});
