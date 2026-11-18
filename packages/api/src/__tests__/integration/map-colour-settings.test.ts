/**
 * A map's colour setting end to end (row I6; docs/map-symbols.md §9.3
 * "Per map (row I6)", docs/map-storage.md §2, §6.1, §6.5, §6.9), on
 * e2e/colour-layers.ocd (a badly ordered table, so the two orders give two
 * documents):
 *
 *   - the table's checks and cascades; the job column's default
 *   - setColourOrder on a club map: the row, the job's snapshot, a `source`
 *     document pinned nowhere until finalise; back to `iof` is the original
 *     document by dedup; review's colour block and `current`
 *   - the setting survives a re-match (reason `colour`) and a second run
 *     finds nothing
 *   - useClubMap copies the series' setting; a promote makes the new club
 *     version in the series' order
 *   - an event's own upload: setColourOrder on the event, kept across a
 *     re-upload of the same file; another file starts at the defaults
 *   - the permission: courses.edit on the event, signed in for the club;
 *     not-found, another source, a bad order
 *   - decide on a `source` document stays `source`
 *   - the picture route
 *
 * `club_symbol_decisions` is global: the decide test removes the row it writes.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { createHash, randomBytes } from "crypto";
import Fastify, { type FastifyInstance } from "fastify";
import sharp from "sharp";
import { SYSTEM_GROUP_IDS, mapDocument, mapImport } from "@oxygen/shared";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { grantSystemGroup } from "../../permissions.js";
import { applyEventMap } from "../../event-map.js";
import { getImportJob, startImportJob } from "../../map-store/jobs.js";
import { planRematch, rematchItem } from "../../map-store/rematch.js";
import { getBlob } from "../../map-store/blob-store.js";
import { readPreview } from "../../map-store/previews.js";
import { resetColourPictureFailures } from "../../map-store/colour-pictures.js";
import { registerMapPreviewRoutes } from "../../map-store/preview-routes.js";
import { MAP_DOCUMENT_CACHE_CONTROL, resetDocumentAccessCache } from "../../map-store/routes.js";
import type { AuthUser } from "../../auth.js";

const FIXTURE = resolve(__dirname, "../../../../../e2e/colour-layers.ocd");
const suffix = randomBytes(4).toString("hex");
const EMAIL_DOMAIN = `@map-colour-${suffix}.example`;
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

let A: TestEventContext; // uses the club map
let E: TestEventContext; // its own upload
let clubFile: Buffer;
let eventFile: Buffer;
let otherFile: Buffer;
let clubSource: string;
let eventSource: string;
let otherSource: string;
let clubMapId: string;
let otherClubMapId: string;
let iofDoc: string;
let sourceDoc: string;
let setter: AuthUser;
let viewer: AuthUser;
let stranger: AuthUser;
let member: AuthUser;
let server: FastifyInstance;
let previousAuthMode: string | undefined;
const decided: string[] = [];

async function mkUser(name: string): Promise<AuthUser> {
  return A.db.user.create({ data: { email: `${name}${EMAIL_DOMAIN}`, displayName: name, isAdmin: false, active: true } });
}
const as = (ev: TestEventContext | null, user: AuthUser | null) => makeCaller(ev?.event ?? null, { user, authEnabled: true, authMode: "proxy" });
const orderOf = async (hash: string) => mapDocument.readMapDocumentHeader((await getBlob(A.db, "map_documents", hash))!).header.colourOrder?.order;
const clubVersion = (id = clubMapId) => A.db.clubMapVersion.findFirstOrThrow({ where: { clubMapId: id }, orderBy: { seq: "desc" }, select: { id: true, seq: true, documentHash: true } });
const eventPin = (ev: TestEventContext) => ev.db.mapFile.findFirstOrThrow({ where: { eventId: ev.eventId }, select: { documentHash: true, sourceHash: true } });
const setting = (where: { clubMapId: string } | { eventId: bigint; sourceHash: string }) => A.db.mapColourSetting.findFirst({ where, select: { order: true, deviations: true } });

beforeAll(async () => {
  A = await createTestEvent("colour_a");
  E = await createTestEvent("colour_e");
  const base = readFileSync(FIXTURE);
  // Own source hashes via a per-run trailer (the OCAD reader ignores trailing bytes).
  clubFile = Buffer.concat([base, Buffer.from(`map-colour-club-${suffix}`)]);
  eventFile = Buffer.concat([base, Buffer.from(`map-colour-event-${suffix}`)]);
  otherFile = Buffer.concat([base, Buffer.from(`map-colour-other-${suffix}`)]);
  [clubSource, eventSource, otherSource] = [clubFile, eventFile, otherFile].map(sha256);
  await A.db.mapSource.createMany({
    data: [clubFile, otherFile].map((bytes, i) => ({ fileHash: sha256(bytes), kind: "ocad", bytes: Uint8Array.from(bytes), sizeBytes: bytes.byteLength, fileName: `colour-${i}.ocd` })),
  });
  clubMapId = (await A.db.clubMap.create({ data: { name: `colour-${suffix}` } })).id;
  otherClubMapId = (await A.db.clubMap.create({ data: { name: `colour-other-${suffix}` } })).id;
  await startImportJob(A.db, { sourceHash: clubSource, clubMapId });
  await startImportJob(A.db, { sourceHash: otherSource, clubMapId: otherClubMapId });
  iofDoc = (await clubVersion()).documentHash;

  setter = await mkUser("setter");
  viewer = await mkUser("viewer");
  stranger = await mkUser("stranger");
  member = await mkUser("member");
  for (const ev of [A, E]) {
    await grantSystemGroup(A.db, { eventId: ev.eventId, userId: setter.id, groupId: SYSTEM_GROUP_IDS.courseSetter, grantedBy: setter.id });
    await A.db.event.update({ where: { id: ev.eventId }, data: { date: new Date("2099-06-01T00:00:00Z") } });
    ev.event.date = new Date("2099-06-01T00:00:00Z");
  }
  const group = await A.db.permissionGroup.create({ data: { name: `Colour viewer ${suffix}`, capabilities: ["event.view", "courses.view"] } });
  await A.db.eventPermission.create({ data: { eventId: E.eventId, userId: viewer.id, groupId: group.id } });
  await grantSystemGroup(A.db, { eventId: E.eventId, userId: member.id, groupId: SYSTEM_GROUP_IDS.courseSetter, grantedBy: setter.id });

  server = Fastify({ logger: false });
  registerMapPreviewRoutes(server);
  await server.ready();
  previousAuthMode = process.env.AUTH_MODE;
  process.env.AUTH_MODE = "proxy";
  resetDocumentAccessCache();
}, 120_000);

afterAll(async () => {
  if (previousAuthMode === undefined) delete process.env.AUTH_MODE;
  else process.env.AUTH_MODE = previousAuthMode;
  await server?.close();
  if (decided.length) await A.db.clubSymbolDecision.deleteMany({ where: { fingerprint: { in: decided } } });
  const sources = [clubSource, eventSource, otherSource];
  for (const ev of [A, E]) await ev?.cleanup();
  await A.db.mapImportJob.deleteMany({ where: { sourceHash: { in: sources } } });
  await A.db.clubMap.deleteMany({ where: { name: { contains: suffix } } });
  await A.db.mapDocument.deleteMany({ where: { sourceHash: { in: sources } } });
  await A.db.mapSource.deleteMany({ where: { fileHash: { in: sources } } });
  await A.db.permissionGroup.deleteMany({ where: { name: { contains: suffix } } });
  await A.db.user.deleteMany({ where: { email: { endsWith: EMAIL_DOMAIN } } });
  await disconnect();
}, 60_000);

describe("the table", () => {
  it("holds one target per row, a known order and an object of overrides; cascades with its target", async () => {
    const db = A.db;
    await expect(db.$executeRawUnsafe(`INSERT INTO oxygen.map_colour_settings (club_map_id, event_id, source_hash) VALUES ('${clubMapId}', ${A.eventId}, '${clubSource}')`)).rejects.toThrow(/map_colour_settings_target_check/);
    await expect(db.$executeRawUnsafe(`INSERT INTO oxygen.map_colour_settings (event_id) VALUES (${A.eventId})`)).rejects.toThrow(/map_colour_settings_target_check/);
    await expect(db.$executeRawUnsafe(`INSERT INTO oxygen.map_colour_settings (club_map_id, colour_order) VALUES ('${otherClubMapId}', 'mapper')`)).rejects.toThrow(/map_colour_settings_order_check/);
    await expect(db.$executeRawUnsafe(`INSERT INTO oxygen.map_colour_settings (club_map_id, deviations) VALUES ('${otherClubMapId}', '[]')`)).rejects.toThrow(/map_colour_settings_deviations_check/);
    const tmp = await db.clubMap.create({ data: { name: `colour-tmp-${suffix}` } });
    await db.mapColourSetting.create({ data: { clubMapId: tmp.id, order: "source" } });
    await expect(db.mapColourSetting.create({ data: { clubMapId: tmp.id } })).rejects.toThrow();
    await db.clubMap.delete({ where: { id: tmp.id } });
    expect(await db.mapColourSetting.count({ where: { clubMapId: tmp.id } })).toBe(0);
  });

  it("gives an import job the defaults when an older image inserts it without the column", async () => {
    const [row] = await A.db.$queryRawUnsafe<{ colour: unknown }[]>(
      `INSERT INTO oxygen.map_import_jobs (source_hash, state) VALUES ('${otherSource}', 'failed') RETURNING colour`,
    );
    expect(row.colour).toEqual({});
    await expect(A.db.$executeRawUnsafe(`INSERT INTO oxygen.map_import_jobs (source_hash, state, colour) VALUES ('${otherSource}', 'failed', '[]')`)).rejects.toThrow(/map_import_jobs_colour_check/);
  });
});

describe("setColourOrder on a club map", () => {
  it("starts in the IOF order with no row", async () => {
    expect(await orderOf(iofDoc)).toBe("iof");
    expect(await setting({ clubMapId })).toBeNull();
    const r = await as(null, setter).mapImport.review({ documentHash: iofDoc, clubMapId });
    expect(r.current).toBe(true);
    expect(r.colour).toMatchObject({ order: "iof", fallback: false, setting: { order: "iof", deviations: {} } });
    expect(r.colour.layers).toHaveLength(13);
    expect(r.colour.deviations).toHaveLength(9);
    expect(r.colour.pictures.source).toBe(`/api/map-documents/${iofDoc}/colour-order/source.png`);
    // Without a target there is no setting to show.
    expect((await as(null, setter).mapImport.review({ documentHash: iofDoc })).colour.setting).toBeNull();
  });

  it("stores the map's own order and rebuilds as decide does: a source document, pinned nowhere until finalise", async () => {
    const res = await as(null, setter).mapImport.setColourOrder({ documentHash: iofDoc, order: "source", target: { kind: "club", clubMapId } });
    expect(res.settings).toEqual({ order: "source", deviations: {} });
    expect(res.job).toMatchObject({ state: "done", clubMapId: null, eventId: null });
    sourceDoc = res.job.documentHash!;
    expect(sourceDoc).not.toBe(iofDoc);
    expect(await orderOf(sourceDoc)).toBe("source");
    expect(await setting({ clubMapId })).toEqual({ order: "source", deviations: {} });
    expect((await getImportJob(A.db, res.job.id))!.colour).toEqual({ order: "source", deviations: {} });
    // Nothing pinned yet: the version still holds the IOF document, which is now not up to date.
    expect((await clubVersion()).documentHash).toBe(iofDoc);
    expect((await as(null, setter).mapImport.review({ documentHash: iofDoc, clubMapId })).current).toBe(false);
    const r = await as(null, setter).mapImport.review({ documentHash: sourceDoc, clubMapId });
    expect(r.current).toBe(true);
    expect(r.colour).toMatchObject({ order: "source", setting: { order: "source", deviations: {} }, layers: null, deviations: [] });
  }, 60_000);

  it("survives a re-match: the version's pin follows the setting, and a second run finds nothing", async () => {
    const items = (await planRematch(A.db)).filter((i) => i.kind === "club" && i.sourceHash === clubSource);
    expect(items).toEqual([expect.objectContaining({ reason: "colour", documentHash: iofDoc })]);
    const r = await rematchItem(A.db, items[0], 60_000);
    expect(r).toMatchObject({ outcome: "done", newDocumentHash: sourceDoc });
    expect((await clubVersion()).documentHash).toBe(sourceDoc);
    expect((await planRematch(A.db)).filter((i) => i.sourceHash === clubSource)).toEqual([]);
  }, 60_000);

  it("switches back to the IOF order: the original document by dedup, kept as the map's", async () => {
    const res = await as(null, setter).mapImport.setColourOrder({ documentHash: sourceDoc, order: "iof", target: { kind: "club", clubMapId } });
    expect(res.job.documentHash).toBe(iofDoc);
    await as(null, setter).mapImport.finalise({ documentHash: iofDoc, target: { kind: "club", clubMapId } });
    expect((await clubVersion()).documentHash).toBe(iofDoc);
    // And to the map's order again, finalised, for the copy and promote below.
    const again = await as(null, setter).mapImport.setColourOrder({ documentHash: iofDoc, order: "source", target: { kind: "club", clubMapId } });
    expect(again.job.documentHash).toBe(sourceDoc);
    await as(null, setter).mapImport.finalise({ documentHash: sourceDoc, target: { kind: "club", clubMapId } });
    expect((await clubVersion()).documentHash).toBe(sourceDoc);
  }, 60_000);

  it("is copied to an event that uses the club map, and a promote makes the new version in the series' order", async () => {
    await as(A, setter).course.useClubMap({ clubMapId });
    expect(await setting({ eventId: A.eventId, sourceHash: clubSource })).toEqual({ order: "source", deviations: {} });
    expect((await eventPin(A)).documentHash).toBe(sourceDoc);
    const doc = mapDocument.decodeMapDocument((await getBlob(A.db, "map_documents", sourceDoc))!);
    await as(A, setter).mapPatch.applyChange({ documentHash: sourceDoc, put: [{ op: "hide", sourceIndex: doc.attrs.sourceIndex[0] }] });
    const promoted = await as(A, setter).mapPatch.promote({ label: `v2-${suffix}` });
    expect(promoted.job).toMatchObject({ state: "done" });
    const v2 = await clubVersion();
    expect(v2.seq).toBe(2);
    expect(v2.documentHash).not.toBe(sourceDoc);
    expect(await orderOf(v2.documentHash)).toBe("source");
    expect((await planRematch(A.db)).filter((i) => i.sourceHash === clubSource)).toEqual([]);
  }, 90_000);
});

describe("useClubMap of a series without a setting", () => {
  it("removes the event's own row for that source", async () => {
    // The other club map has no row; give event A a stray one for its source first.
    await A.db.mapColourSetting.create({ data: { eventId: A.eventId, sourceHash: otherSource, order: "source" } });
    await as(A, setter).course.useClubMap({ clubMapId: otherClubMapId });
    expect(await setting({ eventId: A.eventId, sourceHash: otherSource })).toBeNull();
    expect(await orderOf((await eventPin(A)).documentHash!)).toBe("iof");
  }, 60_000);
});

describe("setColourOrder on an event's own upload", () => {
  let eventIof: string;

  it("stores the event's setting for its file and keeps it across a re-upload of the same file", async () => {
    eventIof = (await applyEventMap(E.db, E.eventId, "own.ocd", eventFile, { startedBy: setter.id })).documentHash!;
    expect(await orderOf(eventIof)).toBe("iof");
    const res = await as(E, setter).mapImport.setColourOrder({ documentHash: eventIof, order: "source", target: { kind: "event" } });
    expect(await setting({ eventId: E.eventId, sourceHash: eventSource })).toEqual({ order: "source", deviations: {} });
    const own = res.job.documentHash!;
    expect(await orderOf(own)).toBe("source");
    expect((await eventPin(E)).documentHash).toBe(eventIof);
    // The event's pin is stale for the re-match by its own setting.
    expect((await planRematch(A.db, { eventId: E.eventId }))).toEqual([expect.objectContaining({ kind: "event", reason: "colour", documentHash: eventIof })]);
    // Run it: the event's pin moves to its own order; a second plan is empty.
    const [item] = await planRematch(A.db, { eventId: E.eventId });
    expect(await rematchItem(A.db, item, 60_000)).toMatchObject({ outcome: "done", newDocumentHash: own });
    expect((await eventPin(E)).documentHash).toBe(own);
    expect(await planRematch(A.db, { eventId: E.eventId })).toEqual([]);
    await as(E, setter).mapImport.finalise({ documentHash: own, target: { kind: "event" } });
    const again = await applyEventMap(E.db, E.eventId, "own.ocd", eventFile, { startedBy: setter.id });
    expect(again.documentHash).toBe(own);
    expect((await as(E, setter).mapImport.review({ documentHash: own })).colour.setting).toEqual({ order: "source", deviations: {} });
  }, 90_000);

  it("starts another file at the defaults", async () => {
    const other = await applyEventMap(E.db, E.eventId, "other.ocd", otherFile, { startedBy: setter.id });
    expect(await orderOf(other.documentHash!)).toBe("iof");
    expect((await as(E, setter).mapImport.review({ documentHash: other.documentHash! })).colour.setting).toEqual({ order: "iof", deviations: {} });
    // Back to the own file for the rest.
    await applyEventMap(E.db, E.eventId, "own.ocd", eventFile, { startedBy: setter.id });
  }, 90_000);

  it("needs courses.edit on the event, as decide does", async () => {
    const pin = (await eventPin(E)).documentHash!;
    const input = { documentHash: pin, order: "iof" as const, target: { kind: "event" as const } };
    await expect(as(E, null).mapImport.setColourOrder(input)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(as(E, stranger).mapImport.setColourOrder(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as(E, viewer).mapImport.setColourOrder(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const kiosk = await E.db.event.update({ where: { id: E.eventId }, data: { kioskKey: `k-${suffix}` }, select: { kioskKey: true } });
    await expect(makeCaller(E.event, { user: null, authEnabled: true, authMode: "proxy", kioskKey: kiosk.kioskKey }).mapImport.setColourOrder(input)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    // Nothing was written by the refusals.
    expect(await setting({ eventId: E.eventId, sourceHash: eventSource })).toEqual({ order: "source", deviations: {} });
    await expect(as(null, setter).mapImport.setColourOrder({ ...input, target: { kind: "event" } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // A document of another source than the event's map; an unknown document; a bad order.
    await expect(as(E, setter).mapImport.setColourOrder({ ...input, documentHash: iofDoc })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(as(E, setter).mapImport.setColourOrder({ ...input, documentHash: "f".repeat(64) })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as(E, setter).mapImport.setColourOrder({ ...input, order: "mapper" as "iof" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(as(E, member).mapImport.setColourOrder(input)).resolves.toMatchObject({ settings: { order: "iof" } });
  }, 60_000);

  it("on a club map: signed in, the series must exist and hold the document's source", async () => {
    const input = { documentHash: iofDoc, order: "source" as const, target: { kind: "club" as const, clubMapId } };
    await expect(as(null, null).mapImport.setColourOrder(input)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(as(null, setter).mapImport.setColourOrder({ ...input, target: { kind: "club", clubMapId: "0190a0a0-0000-7000-8000-00000000dead" } })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(as(null, setter).mapImport.setColourOrder({ ...input, target: { kind: "club", clubMapId: otherClubMapId } })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await setting({ clubMapId: otherClubMapId })).toBeNull();
  });
});

describe("decide on a document in the map's own order", () => {
  it("imports again in that order", async () => {
    const r = await as(null, setter).mapImport.review({ documentHash: sourceDoc, clubMapId });
    const row = r.symbols.find((s) => s.match?.state === "auto")!;
    decided.push(row.fingerprint);
    const res = await as(null, setter).mapImport.decide({ documentHash: sourceDoc, decisions: [{ symbolIdx: row.symbolIdx, unmatch: true }] });
    expect(res.job.state).toBe("done");
    expect(res.job.documentHash).not.toBe(sourceDoc);
    expect(await orderOf(res.job.documentHash!)).toBe("source");
    await A.db.clubSymbolDecision.deleteMany({ where: { fingerprint: { in: decided } } });
  }, 60_000);
});

describe("GET /api/map-documents/:hash/colour-order/:order.png", () => {
  const get = (url: string, headers: Record<string, string> = {}) => server.inject({ method: "GET", url, headers });
  const signedIn = () => ({ "x-forwarded-email": setter.email });

  it("validates, then authorises, then looks up", async () => {
    expect((await get(`/api/map-documents/${iofDoc}/colour-order/mapper.png`, signedIn())).statusCode).toBe(400);
    expect((await get(`/api/map-documents/${iofDoc}/colour-order/iof`, signedIn())).statusCode).toBe(400);
    expect((await get(`/api/map-documents/nothex/colour-order/iof.png`, signedIn())).statusCode).toBe(400);
    expect((await get(`/api/map-documents/${iofDoc}/colour-order/iof.png`)).statusCode).toBe(401);
    expect((await get(`/api/map-documents/${"f".repeat(64)}/colour-order/iof.png`, signedIn())).statusCode).toBe(403);
  });

  it("draws the document's own order from it and the other order from the document the switch gives, once each", async () => {
    // A fresh club version in the IOF order (the club map above is on its own order now).
    const fresh = await A.db.clubMap.create({ data: { name: `colour-pic-${suffix}` } });
    const picFile = Buffer.concat([readFileSync(FIXTURE), Buffer.from(`map-colour-pic-${suffix}`)]);
    const picSource = sha256(picFile);
    await A.db.mapSource.create({ data: { fileHash: picSource, kind: "ocad", bytes: Uint8Array.from(picFile), sizeBytes: picFile.byteLength, fileName: "pic.ocd" } });
    try {
      await startImportJob(A.db, { sourceHash: picSource, clubMapId: fresh.id });
      const doc = (await clubVersion(fresh.id)).documentHash;
      const own = await get(`/api/map-documents/${doc}/colour-order/iof.png`, signedIn());
      expect(own.statusCode).toBe(200);
      expect(own.headers["content-type"]).toBe("image/png");
      expect(own.headers["cache-control"]).toBe(MAP_DOCUMENT_CACHE_CONTROL);
      expect(own.headers.etag).toBe(`"${doc}/colour-order/iof"`);
      expect((await get(`/api/map-documents/${doc}/colour-order/iof.png`, { ...signedIn(), "if-none-match": own.headers.etag as string })).statusCode).toBe(304);
      const jobsBefore = await A.db.mapImportJob.count({ where: { sourceHash: picSource } });
      const other = await get(`/api/map-documents/${doc}/colour-order/source.png`, signedIn());
      expect(other.statusCode).toBe(200);
      // The other order was imported once, as a job without a target; the version is untouched.
      expect(await A.db.mapImportJob.count({ where: { sourceHash: picSource } })).toBe(jobsBefore + 1);
      expect(await A.db.mapImportJob.count({ where: { sourceHash: picSource, clubMapId: null, colour: { equals: { order: "source", deviations: {} } } } })).toBe(1);
      expect((await clubVersion(fresh.id)).documentHash).toBe(doc);
      expect(await readPreview(A.db, doc, "colour-order", "source")).not.toBeNull();
      await get(`/api/map-documents/${doc}/colour-order/source.png`, signedIn());
      expect(await A.db.mapImportJob.count({ where: { sourceHash: picSource } })).toBe(jobsBefore + 1);
      // Same window, different pictures.
      const [a, b] = await Promise.all([own.rawPayload, other.rawPayload].map((p) => sharp(p).raw().toBuffer({ resolveWithObject: true })));
      expect([a.info.width, a.info.height]).toEqual([b.info.width, b.info.height]);
      expect(a.data.equals(b.data)).toBe(false);
    } finally {
      await A.db.mapImportJob.deleteMany({ where: { sourceHash: picSource } });
      await A.db.clubMap.delete({ where: { id: fresh.id } });
      await A.db.mapDocument.deleteMany({ where: { sourceHash: picSource } });
      await A.db.mapSource.deleteMany({ where: { fileHash: picSource } });
    }
  }, 90_000);

  it("answers 503 with Retry-After while the other order is still importing, then the picture", async () => {
    // A wait of 0 ms cannot finish the work (the club map's IOF document has no `source` picture row yet).
    await A.db.mapPreview.deleteMany({ where: { documentHash: iofDoc, kind: "colour-order" } });
    resetColourPictureFailures();
    const previous = process.env.MAP_COLOUR_PICTURE_WAIT_MS;
    process.env.MAP_COLOUR_PICTURE_WAIT_MS = "0";
    try {
      const pending = await get(`/api/map-documents/${iofDoc}/colour-order/source.png`, signedIn());
      expect(pending.statusCode).toBe(503);
      expect(pending.headers["retry-after"]).toBe("5");
    } finally {
      if (previous === undefined) delete process.env.MAP_COLOUR_PICTURE_WAIT_MS;
      else process.env.MAP_COLOUR_PICTURE_WAIT_MS = previous;
    }
    await expect.poll(async () => (await get(`/api/map-documents/${iofDoc}/colour-order/source.png`, signedIn())).statusCode, { timeout: 30_000 }).toBe(200);
  }, 60_000);

  it("answers 502 for an import that fails, and does not start it again for a while", async () => {
    // A document whose source bytes are not a map: the other order's import fails.
    const bad = Buffer.from(`not a map ${suffix}`);
    const badSource = sha256(bad);
    await A.db.mapSource.create({ data: { fileHash: badSource, kind: "ocad", bytes: Uint8Array.from(bad), sizeBytes: bad.byteLength, fileName: "bad.ocd" } });
    const doc = await A.db.mapDocument.findUniqueOrThrow({ where: { hash: iofDoc }, select: { bytes: true, sizeBytes: true, formatVersion: true, importerVersion: true, libraryVersion: true, header: true, report: true } });
    const fakeHash = sha256(Buffer.from(`fake-doc-${suffix}`));
    await A.db.mapDocument.create({ data: { hash: fakeHash, sourceHash: badSource, ...doc, header: doc.header ?? {}, report: doc.report ?? {} } });
    await A.db.mapImportJob.create({ data: { sourceHash: badSource, state: "done", documentHash: fakeHash, startedBy: setter.id } });
    resetColourPictureFailures();
    try {
      const failed = await get(`/api/map-documents/${fakeHash}/colour-order/source.png`, signedIn());
      expect(failed.statusCode).toBe(502);
      const jobs = await A.db.mapImportJob.count({ where: { sourceHash: badSource } });
      expect((await get(`/api/map-documents/${fakeHash}/colour-order/source.png`, signedIn())).statusCode).toBe(502);
      expect(await A.db.mapImportJob.count({ where: { sourceHash: badSource } })).toBe(jobs);
    } finally {
      resetColourPictureFailures();
      await A.db.mapImportJob.deleteMany({ where: { sourceHash: badSource } });
      await A.db.mapDocument.deleteMany({ where: { sourceHash: badSource } });
      await A.db.mapSource.deleteMany({ where: { fileHash: badSource } });
    }
  }, 60_000);
});

// Keep the shared import of `mapImport` used (the deviation key helper) for readers of this file.
void mapImport.deviationKey;
