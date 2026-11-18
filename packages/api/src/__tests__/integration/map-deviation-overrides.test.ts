/**
 * Deviation overrides per map end to end (row I7; docs/map-symbols.md §9.3
 * "Overrides (row I7)", docs/map-storage.md §2, §4.5, §6.8, §6.9), on
 * e2e/colour-layers.ocd (nine deviations: the road and paved-over-contour
 * pairs kept by default, the building-over-contour pair kept by
 * implication, the paved-over-building pair dropped by default):
 *
 *   - an override that changes no bytes (keeping the implied pair) gives the
 *     same document and leaves the pin current: review, re-match, dedup
 *   - setDeviation keeps a dropped deviation and drops a kept one: new
 *     documents pinned nowhere until finalise; the review's rows follow
 *   - a reset is removing the key: back to the original document by dedup
 *   - overrides are kept while the order is the map's own and apply again
 *   - on an event's own upload; the permission and the bad inputs
 *   - a `source` document's IOF picture drawn with the map's overrides,
 *     stored under its own key
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
import { currentDocumentFor, getImportJob, startImportJob } from "../../map-store/jobs.js";
import { planRematch } from "../../map-store/rematch.js";
import { getBlob } from "../../map-store/blob-store.js";
import { loadClubDecisions } from "../../map-store/decisions.js";
import { readPreview } from "../../map-store/previews.js";
import { colourPictureKey, resetColourPictureFailures } from "../../map-store/colour-pictures.js";
import { registerMapPreviewRoutes } from "../../map-store/preview-routes.js";
import { resetDocumentAccessCache } from "../../map-store/routes.js";
import type { AuthUser } from "../../auth.js";

const FIXTURE = resolve(__dirname, "../../../../../e2e/colour-layers.ocd");
const suffix = randomBytes(4).toString("hex");
const EMAIL_DOMAIN = `@map-deviation-${suffix}.example`;
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

const ROAD = "brown50-road>brown100-line";
const BUILDING = "black50-building>brown100-line";
const PAVED_BUILDING = "brown50-paved>black50-building";

let E: TestEventContext;
let clubFile: Buffer;
let eventFile: Buffer;
let clubSource: string;
let eventSource: string;
let clubMapId: string;
let plainDoc: string;
let keptDoc: string;
let setter: AuthUser;
let viewer: AuthUser;
let server: FastifyInstance;
let previousAuthMode: string | undefined;

async function mkUser(name: string): Promise<AuthUser> {
  return E.db.user.create({ data: { email: `${name}${EMAIL_DOMAIN}`, displayName: name, isAdmin: false, active: true } });
}
const as = (ev: TestEventContext | null, user: AuthUser | null) => makeCaller(ev?.event ?? null, { user, authEnabled: true, authMode: "proxy" });
const header = async (hash: string) => mapDocument.readMapDocumentHeader((await getBlob(E.db, "map_documents", hash))!).header;
const keptOf = async (hash: string) => (await header(hash)).colourOrder?.kept ?? [];
const clubVersion = () => E.db.clubMapVersion.findFirstOrThrow({ where: { clubMapId }, orderBy: { seq: "desc" }, select: { documentHash: true } });
const setting = (where: { clubMapId: string } | { eventId: bigint; sourceHash: string }) => E.db.mapColourSetting.findFirst({ where, select: { order: true, deviations: true } });
const club = () => ({ kind: "club" as const, clubMapId });
const setDeviation = (documentHash: string, key: string, choice: "keep" | "drop" | "default", target: { kind: "club"; clubMapId: string } | { kind: "event" } = club()) =>
  as(target.kind === "event" ? E : null, setter).mapImport.setDeviation({ documentHash, key, choice, target });

beforeAll(async () => {
  E = await createTestEvent("deviation_e");
  const base = readFileSync(FIXTURE);
  clubFile = Buffer.concat([base, Buffer.from(`map-deviation-club-${suffix}`)]);
  eventFile = Buffer.concat([base, Buffer.from(`map-deviation-event-${suffix}`)]);
  [clubSource, eventSource] = [clubFile, eventFile].map(sha256);
  await E.db.mapSource.create({ data: { fileHash: clubSource, kind: "ocad", bytes: Uint8Array.from(clubFile), sizeBytes: clubFile.byteLength, fileName: "deviation.ocd" } });
  clubMapId = (await E.db.clubMap.create({ data: { name: `deviation-${suffix}` } })).id;
  await startImportJob(E.db, { sourceHash: clubSource, clubMapId });
  plainDoc = (await clubVersion()).documentHash;

  setter = await mkUser("setter");
  viewer = await mkUser("viewer");
  await grantSystemGroup(E.db, { eventId: E.eventId, userId: setter.id, groupId: SYSTEM_GROUP_IDS.courseSetter, grantedBy: setter.id });
  await E.db.event.update({ where: { id: E.eventId }, data: { date: new Date("2099-06-01T00:00:00Z") } });
  E.event.date = new Date("2099-06-01T00:00:00Z");
  const group = await E.db.permissionGroup.create({ data: { name: `Deviation viewer ${suffix}`, capabilities: ["event.view", "courses.view"] } });
  await E.db.eventPermission.create({ data: { eventId: E.eventId, userId: viewer.id, groupId: group.id } });

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
  const sources = [clubSource, eventSource];
  await E?.cleanup();
  await E.db.mapImportJob.deleteMany({ where: { sourceHash: { in: sources } } });
  await E.db.clubMap.deleteMany({ where: { name: { contains: suffix } } });
  await E.db.mapDocument.deleteMany({ where: { sourceHash: { in: sources } } });
  await E.db.mapSource.deleteMany({ where: { fileHash: { in: sources } } });
  await E.db.permissionGroup.deleteMany({ where: { name: { contains: suffix } } });
  await E.db.user.deleteMany({ where: { email: { endsWith: EMAIL_DOMAIN } } });
  await disconnect();
}, 60_000);

describe("the recorded settings", () => {
  it("records the setting every finished import was asked for, checked, and cascades with the document", async () => {
    expect(await E.db.mapDocumentColourSetting.findMany({ where: { documentHash: plainDoc }, select: { colourKey: true, colour: true } }))
      .toEqual([{ colourKey: '{"order":"iof","deviations":{}}', colour: { order: "iof", deviations: {} } }]);
    await expect(E.db.$executeRawUnsafe(`INSERT INTO oxygen.map_document_colour_settings (document_hash, colour_key, colour) VALUES ('${plainDoc}', 'x', '[]')`)).rejects.toThrow(/map_document_colour_settings_colour_check/);
    await expect(E.db.$executeRawUnsafe(`INSERT INTO oxygen.map_document_colour_settings (document_hash, colour_key, colour) VALUES ('${"0".repeat(64)}', 'x', '{}')`)).rejects.toThrow(/foreign key/);
    // The rows go with their document.
    const doc = await E.db.mapDocument.findUniqueOrThrow({ where: { hash: plainDoc }, select: { bytes: true, sizeBytes: true, formatVersion: true, importerVersion: true, libraryVersion: true, header: true, report: true } });
    const fake = sha256(Buffer.from(`fake-${suffix}`));
    await E.db.mapDocument.create({ data: { hash: fake, sourceHash: clubSource, ...doc, header: doc.header ?? {}, report: doc.report ?? {} } });
    await E.db.mapDocumentColourSetting.create({ data: { documentHash: fake, colourKey: "k", colour: {} } });
    await E.db.mapDocument.delete({ where: { hash: fake } });
    expect(await E.db.mapDocumentColourSetting.count({ where: { documentHash: fake } })).toBe(0);
  });
});

describe("an override that changes no bytes (carried from I6)", () => {
  it("gives the same document, which stays current: review, re-match and dedup", async () => {
    const res = await setDeviation(plainDoc, BUILDING, "keep");
    expect(res.settings).toEqual({ order: "iof", deviations: { [BUILDING]: "keep" } });
    expect(res.job).toMatchObject({ state: "done", documentHash: plainDoc, clubMapId: null, eventId: null });
    expect(await setting({ clubMapId })).toEqual({ order: "iof", deviations: { [BUILDING]: "keep" } });
    // The stored report is still the first import's ("implied"), but the pin follows the setting.
    const r = await as(null, setter).mapImport.review({ documentHash: plainDoc, clubMapId });
    expect(r.current).toBe(true);
    expect(r.colour.deviations.find((d) => d.key === BUILDING)).toMatchObject({ why: "implied", kept: true, choice: "keep", overridden: true });
    expect((await planRematch(E.db)).filter((i) => i.sourceHash === clubSource)).toEqual([]);
    const decisions = await loadClubDecisions(E.db, "ocad");
    expect(await currentDocumentFor(E.db, clubSource, decisions, [], { order: "iof", deviations: { [BUILDING]: "keep" } })).toEqual({ hash: plainDoc });
    // Asked again: dedup, no worker.
    const again = await setDeviation(plainDoc, BUILDING, "keep");
    expect(again.job).toMatchObject({ state: "done", documentHash: plainDoc });
    await setDeviation(plainDoc, BUILDING, "default");
    expect(await setting({ clubMapId })).toEqual({ order: "iof", deviations: {} });
  }, 60_000);

  it("is kept by a symbol decision on the map: the decided document is current and needs no re-match", async () => {
    await setDeviation(plainDoc, BUILDING, "keep");
    const r = await as(null, setter).mapImport.review({ documentHash: plainDoc, clubMapId });
    const row = r.symbols.find((x) => x.match?.state === "auto")!;
    try {
      const res = await as(null, setter).mapImport.decide({ documentHash: plainDoc, decisions: [{ symbolIdx: row.symbolIdx, unmatch: true }], clubMapId });
      const decided = res.job.documentHash!;
      expect(decided).not.toBe(plainDoc);
      expect((await getImportJob(E.db, res.job.id))!.colour).toEqual({ order: "iof", deviations: { [BUILDING]: "keep" } });
      expect((await as(null, setter).mapImport.review({ documentHash: decided, clubMapId })).current).toBe(true);
      await as(null, setter).mapImport.finalise({ documentHash: decided, target: club() });
      expect((await planRematch(E.db)).filter((i) => i.sourceHash === clubSource)).toEqual([]);
    } finally {
      await E.db.clubSymbolDecision.deleteMany({ where: { fingerprint: row.fingerprint } });
      await as(null, setter).mapImport.finalise({ documentHash: plainDoc, target: club() });
      await setDeviation(plainDoc, BUILDING, "default");
    }
  }, 90_000);
});

describe("setDeviation on a club map", () => {
  it("keeps a deviation dropped by default: a new document, pinned nowhere until finalise", async () => {
    const res = await setDeviation(plainDoc, PAVED_BUILDING, "keep");
    expect(res.settings).toEqual({ order: "iof", deviations: { [PAVED_BUILDING]: "keep" } });
    keptDoc = res.job.documentHash!;
    expect(keptDoc).not.toBe(plainDoc);
    expect(await keptOf(keptDoc)).toContain(PAVED_BUILDING);
    expect((await clubVersion()).documentHash).toBe(plainDoc);
    expect((await as(null, setter).mapImport.review({ documentHash: plainDoc, clubMapId })).current).toBe(false);
    const r = await as(null, setter).mapImport.review({ documentHash: keptDoc, clubMapId });
    expect(r.current).toBe(true);
    expect(r.colour.deviations.find((d) => d.key === PAVED_BUILDING)).toMatchObject({ kept: true, why: "override", default: "drop", choice: "keep", overridden: true });
    expect((await planRematch(E.db)).filter((i) => i.sourceHash === clubSource)).toEqual([expect.objectContaining({ reason: "colour", documentHash: plainDoc })]);
  }, 60_000);

  it("drops a deviation kept by default on top, then resets each: the original document by dedup", async () => {
    const dropped = await setDeviation(keptDoc, ROAD, "drop");
    expect(dropped.settings.deviations).toEqual({ [PAVED_BUILDING]: "keep", [ROAD]: "drop" });
    const both = dropped.job.documentHash!;
    expect([plainDoc, keptDoc]).not.toContain(both);
    expect(await keptOf(both)).not.toContain(ROAD);
    expect((await as(null, setter).mapImport.review({ documentHash: both, clubMapId })).colour.deviations.find((d) => d.key === ROAD)).toMatchObject({ kept: false, why: "override", choice: "drop", overridden: true });
    expect((await setDeviation(both, ROAD, "default")).job.documentHash).toBe(keptDoc);
    const reset = await setDeviation(keptDoc, PAVED_BUILDING, "default");
    expect(reset.settings).toEqual({ order: "iof", deviations: {} });
    expect(reset.job.documentHash).toBe(plainDoc);
    expect(await setting({ clubMapId })).toEqual({ order: "iof", deviations: {} });
    expect((await as(null, setter).mapImport.review({ documentHash: plainDoc, clubMapId })).current).toBe(true);
  }, 90_000);

  it("keeps the overrides while the order is the map's own, and applies them again on the way back", async () => {
    await setDeviation(plainDoc, PAVED_BUILDING, "keep");
    const source = await as(null, setter).mapImport.setColourOrder({ documentHash: keptDoc, order: "source", target: club() });
    expect(source.settings).toEqual({ order: "source", deviations: { [PAVED_BUILDING]: "keep" } });
    const sourceDoc = source.job.documentHash!;
    expect((await as(null, setter).mapImport.review({ documentHash: sourceDoc, clubMapId })).current).toBe(true);
    // A reset in the map's own order removes the key; no deviation is listed there to keep or drop.
    await expect(setDeviation(sourceDoc, ROAD, "drop")).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const back = await as(null, setter).mapImport.setColourOrder({ documentHash: sourceDoc, order: "iof", target: club() });
    expect(back.job.documentHash).toBe(keptDoc);
    expect((await setDeviation(keptDoc, PAVED_BUILDING, "default")).job.documentHash).toBe(plainDoc);
  }, 90_000);

  it("refuses an unknown or malformed key, an unknown target and a signed-out caller", async () => {
    await expect(setDeviation(plainDoc, "black100>blue100-line", "keep")).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(setDeviation(plainDoc, "not a key", "keep")).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(as(null, setter).mapImport.setDeviation({ documentHash: plainDoc, key: ROAD, choice: "maybe" as "keep", target: club() })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(setDeviation(plainDoc, ROAD, "drop", { kind: "club", clubMapId: "0190a0a0-0000-7000-8000-00000000dead" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(as(null, null).mapImport.setDeviation({ documentHash: plainDoc, key: ROAD, choice: "drop", target: club() })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    // A reset of a key the document does not list is allowed (it removes nothing here).
    expect((await setDeviation(plainDoc, "black100>blue100-line", "default")).settings).toEqual({ order: "iof", deviations: {} });
  }, 60_000);
});

describe("setDeviation on an event's own upload", () => {
  it("stores the event's override, needs courses.edit, and is followed by the re-match", async () => {
    const own = (await applyEventMap(E.db, E.eventId, "own.ocd", eventFile, { startedBy: setter.id })).documentHash!;
    const input = { documentHash: own, key: PAVED_BUILDING, choice: "keep" as const, target: { kind: "event" as const } };
    await expect(as(E, viewer).mapImport.setDeviation(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as(null, setter).mapImport.setDeviation(input)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(as(E, setter).mapImport.setDeviation({ ...input, documentHash: plainDoc })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await setting({ eventId: E.eventId, sourceHash: eventSource })).toBeNull();
    const res = await as(E, setter).mapImport.setDeviation(input);
    expect(await setting({ eventId: E.eventId, sourceHash: eventSource })).toEqual({ order: "iof", deviations: { [PAVED_BUILDING]: "keep" } });
    expect(res.job.documentHash).not.toBe(own);
    expect(await planRematch(E.db, { eventId: E.eventId })).toEqual([expect.objectContaining({ kind: "event", reason: "colour", documentHash: own })]);
    // A no-op override on the event: the plan does not change for it.
    await as(E, setter).mapImport.setDeviation({ ...input, choice: "default" });
    await as(E, setter).mapImport.setDeviation({ ...input, key: BUILDING });
    expect(await planRematch(E.db, { eventId: E.eventId })).toEqual([]);
  }, 90_000);
});

describe("the picture of a source document in the IOF order", () => {
  const get = (url: string) => server.inject({ method: "GET", url, headers: { "x-forwarded-email": setter.email } });

  it("is drawn with the map's overrides, under its own key and ETag", async () => {
    resetColourPictureFailures();
    await setDeviation(plainDoc, PAVED_BUILDING, "keep");
    const source = await as(null, setter).mapImport.setColourOrder({ documentHash: keptDoc, order: "source", target: club() });
    const sourceDoc = source.job.documentHash!;
    const r = await as(null, setter).mapImport.review({ documentHash: sourceDoc, clubMapId });
    const query = encodeURIComponent(`${PAVED_BUILDING}:keep`);
    expect(r.colour.pictures.iof).toBe(`/api/map-documents/${sourceDoc}/colour-order/iof.png?deviations=${query}`);
    expect((await get(`/api/map-documents/${sourceDoc}/colour-order/iof.png?deviations=bad`)).statusCode).toBe(400);
    const withOverrides = await get(r.colour.pictures.iof);
    expect(withOverrides.statusCode).toBe(200);
    const key = colourPictureKey("iof", { [PAVED_BUILDING]: "keep" });
    expect(withOverrides.headers.etag).toBe(`"${sourceDoc}/colour-order/${key}"`);
    const defaults = await get(`/api/map-documents/${sourceDoc}/colour-order/iof.png`);
    expect(defaults.statusCode).toBe(200);
    expect(defaults.headers.etag).toBe(`"${sourceDoc}/colour-order/iof"`);
    expect(withOverrides.rawPayload.equals(defaults.rawPayload)).toBe(false);
    expect(await readPreview(E.db, sourceDoc, "colour-order", key)).not.toBeNull();
    expect(await readPreview(E.db, sourceDoc, "colour-order", "iof")).not.toBeNull();
    // The overrides picture is drawn from the document the switch back gives.
    const jobs = await E.db.mapImportJob.findMany({ where: { sourceHash: clubSource, clubMapId: null, colour: { equals: { order: "iof", deviations: { [PAVED_BUILDING]: "keep" } } } }, select: { documentHash: true } });
    expect(new Set(jobs.map((j) => j.documentHash))).toEqual(new Set([keptDoc]));
    // Keys stay bounded: unlisted overrides are the defaults' picture, and an IOF document ignores the query.
    const unlisted = await get(`/api/map-documents/${sourceDoc}/colour-order/iof.png?deviations=${encodeURIComponent("black100>blue100-line:keep")}`);
    expect(unlisted.headers.etag).toBe(`"${sourceDoc}/colour-order/iof"`);
    const mixed = await get(`/api/map-documents/${sourceDoc}/colour-order/iof.png?deviations=${encodeURIComponent(`black100>blue100-line:keep,${PAVED_BUILDING}:keep`)}`);
    expect(mixed.headers.etag).toBe(`"${sourceDoc}/colour-order/${key}"`);
    const onIof = await get(`/api/map-documents/${keptDoc}/colour-order/iof.png?deviations=${query}`);
    expect(onIof.statusCode).toBe(200);
    expect(onIof.headers.etag).toBe(`"${keptDoc}/colour-order/iof"`);
    expect(await E.db.mapPreview.count({ where: { documentHash: { in: [sourceDoc, keptDoc] }, kind: "colour-order" } })).toBe(3);
  }, 90_000);
});
