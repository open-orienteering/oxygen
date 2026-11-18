/**
 * `mapImport.otherOrderDocument` (row I8; docs/map-symbols.md §8.7
 * "Compare (row I8)", docs/map-storage.md §4.5), on e2e/colour-layers.ocd:
 * the document the colour switch gives, without the picture —
 *
 *   - an IOF document's own-order document and back (dedup, one job)
 *   - a `source` document's IOF side with the map's overrides
 *   - the same document the picture route draws from
 *   - the caller may fetch the document it gets (the own-job clause)
 *   - access: as `review`; an unknown document
 *   - the event route, with `courses.view`
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
const EMAIL_DOMAIN = `@map-compare-${suffix}.example`;
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const PAVED_BUILDING = "brown50-paved>black50-building";

let E: TestEventContext;
let clubFile: Buffer;
let eventFile: Buffer;
let clubSource: string;
let eventSource: string;
let clubMapId: string;
let iofDoc: string;
let setter: AuthUser;
let other: AuthUser;
let viewer: AuthUser;
let server: FastifyInstance;
let previousAuthMode: string | undefined;

async function mkUser(name: string): Promise<AuthUser> {
  return E.db.user.create({ data: { email: `${name}${EMAIL_DOMAIN}`, displayName: name, isAdmin: false, active: true } });
}
const as = (ev: TestEventContext | null, user: AuthUser | null) => makeCaller(ev?.event ?? null, { user, authEnabled: true, authMode: "proxy" });
const orderOf = async (hash: string) => mapDocument.readMapDocumentHeader((await getBlob(E.db, "map_documents", hash))!).header.colourOrder?.order;
const club = () => ({ kind: "club" as const, clubMapId });
const ready = (r: { state: string; documentHash?: string }) => {
  expect(r.state).toBe("ready");
  return r.documentHash!;
};

beforeAll(async () => {
  E = await createTestEvent("compare_e");
  const base = readFileSync(FIXTURE);
  clubFile = Buffer.concat([base, Buffer.from(`map-compare-club-${suffix}`)]);
  eventFile = Buffer.concat([base, Buffer.from(`map-compare-event-${suffix}`)]);
  [clubSource, eventSource] = [clubFile, eventFile].map(sha256);
  await E.db.mapSource.create({ data: { fileHash: clubSource, kind: "ocad", bytes: Uint8Array.from(clubFile), sizeBytes: clubFile.byteLength, fileName: "compare.ocd" } });
  clubMapId = (await E.db.clubMap.create({ data: { name: `compare-${suffix}` } })).id;
  await startImportJob(E.db, { sourceHash: clubSource, clubMapId });
  iofDoc = (await E.db.clubMapVersion.findFirstOrThrow({ where: { clubMapId }, select: { documentHash: true } })).documentHash;
  setter = await mkUser("setter");
  other = await mkUser("other");
  viewer = await mkUser("viewer");
  await grantSystemGroup(E.db, { eventId: E.eventId, userId: setter.id, groupId: SYSTEM_GROUP_IDS.courseSetter, grantedBy: setter.id });
  await E.db.event.update({ where: { id: E.eventId }, data: { date: new Date("2099-06-01T00:00:00Z") } });
  E.event.date = new Date("2099-06-01T00:00:00Z");
  const group = await E.db.permissionGroup.create({ data: { name: `Compare viewer ${suffix}`, capabilities: ["event.view", "courses.view"] } });
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

describe("mapImport.otherOrderDocument on a club map", () => {
  let sourceDoc: string;

  it("gives an IOF document's own-order document, and that one's IOF document back", async () => {
    const r = await as(null, setter).mapImport.otherOrderDocument({ documentHash: iofDoc, clubMapId });
    expect(r).toMatchObject({ state: "ready", order: "source" });
    sourceDoc = ready(r);
    expect(sourceDoc).not.toBe(iofDoc);
    expect(await orderOf(sourceDoc)).toBe("source");
    const jobs = await E.db.mapImportJob.count({ where: { sourceHash: clubSource } });
    // Asked again: the same document, by dedup.
    expect(ready(await as(null, setter).mapImport.otherOrderDocument({ documentHash: iofDoc, clubMapId }))).toBe(sourceDoc);
    expect(ready(await as(null, setter).mapImport.otherOrderDocument({ documentHash: sourceDoc, clubMapId }))).toBe(iofDoc);
    // Nothing pinned, no setting written.
    expect((await E.db.clubMapVersion.findFirstOrThrow({ where: { clubMapId }, select: { documentHash: true } })).documentHash).toBe(iofDoc);
    expect(await E.db.mapColourSetting.count({ where: { clubMapId } })).toBe(0);
    expect(await E.db.mapImportJob.count({ where: { sourceHash: clubSource, state: { not: "done" } } })).toBe(0);
    expect(await E.db.mapImportJob.count({ where: { sourceHash: clubSource } })).toBeGreaterThanOrEqual(jobs);
  }, 90_000);

  it("is the document the picture route draws its other order from", async () => {
    const before = await E.db.mapImportJob.count({ where: { sourceHash: clubSource, colour: { equals: { order: "source", deviations: {} } }, documentHash: { not: sourceDoc } } });
    const pic = await server.inject({ method: "GET", url: `/api/map-documents/${iofDoc}/colour-order/source.png`, headers: { "x-forwarded-email": setter.email } });
    expect(pic.statusCode).toBe(200);
    expect(await E.db.mapImportJob.count({ where: { sourceHash: clubSource, colour: { equals: { order: "source", deviations: {} } }, documentHash: { not: sourceDoc } } })).toBe(before);
  }, 60_000);

  it("gives a source document's IOF side with the map's overrides", async () => {
    const kept = await as(null, setter).mapImport.setDeviation({ documentHash: iofDoc, key: PAVED_BUILDING, choice: "keep", target: club() });
    const keptDoc = kept.job.documentHash!;
    expect(keptDoc).not.toBe(iofDoc);
    const source = await as(null, setter).mapImport.setColourOrder({ documentHash: keptDoc, order: "source", target: club() });
    expect(source.job.documentHash).toBe(sourceDoc);
    expect(ready(await as(null, setter).mapImport.otherOrderDocument({ documentHash: sourceDoc, clubMapId }))).toBe(keptDoc);
    // Without a target there are no overrides: the defaults' document.
    expect(ready(await as(null, setter).mapImport.otherOrderDocument({ documentHash: sourceDoc }))).toBe(iofDoc);
    await as(null, setter).mapImport.setColourOrder({ documentHash: sourceDoc, order: "iof", target: club() });
    await as(null, setter).mapImport.setDeviation({ documentHash: keptDoc, key: PAVED_BUILDING, choice: "default", target: club() });
  }, 120_000);

  it("lets the caller fetch the document it got, even when another user's import gave it", async () => {
    // A fresh source, its other order imported first by another user.
    const file = Buffer.concat([readFileSync(FIXTURE), Buffer.from(`map-compare-fetch-${suffix}`)]);
    const src = sha256(file);
    await E.db.mapSource.create({ data: { fileHash: src, kind: "ocad", bytes: Uint8Array.from(file), sizeBytes: file.byteLength, fileName: "fetch.ocd" } });
    const map = await E.db.clubMap.create({ data: { name: `compare-fetch-${suffix}` } });
    try {
      await startImportJob(E.db, { sourceHash: src, clubMapId: map.id });
      const doc = (await E.db.clubMapVersion.findFirstOrThrow({ where: { clubMapId: map.id }, select: { documentHash: true } })).documentHash;
      const theirs = ready(await as(null, other).mapImport.otherOrderDocument({ documentHash: doc, clubMapId: map.id }));
      const mine = ready(await as(null, setter).mapImport.otherOrderDocument({ documentHash: doc, clubMapId: map.id }));
      expect(mine).toBe(theirs);
      const res = await server.inject({ method: "GET", url: `/api/map-documents/${mine}`, headers: { "x-forwarded-email": setter.email } });
      expect(res.statusCode).toBe(200);
    } finally {
      await E.db.mapImportJob.deleteMany({ where: { sourceHash: src } });
      await E.db.clubMap.delete({ where: { id: map.id } });
      await E.db.mapDocument.deleteMany({ where: { sourceHash: src } });
      await E.db.mapSource.deleteMany({ where: { fileHash: src } });
    }
  }, 120_000);

  it("is readable as review is: signed out is refused, an unknown document is not found", async () => {
    await expect(as(null, null).mapImport.otherOrderDocument({ documentHash: iofDoc, clubMapId })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(as(null, setter).mapImport.otherOrderDocument({ documentHash: "f".repeat(64) })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as(null, setter).mapImport.otherOrderDocument({ documentHash: "nothex" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("mapImport.otherOrderDocument on an event's own map", () => {
  it("answers a reader with courses.view, with the event's overrides", async () => {
    const own = (await applyEventMap(E.db, E.eventId, "own.ocd", eventFile, { startedBy: setter.id })).documentHash!;
    const r = await as(E, viewer).mapImport.otherOrderDocument({ documentHash: own });
    expect(r).toMatchObject({ state: "ready", order: "source" });
    expect(await orderOf(ready(r))).toBe("source");
    const res = await server.inject({ method: "GET", url: `/api/map-documents/${ready(r)}`, headers: { "x-forwarded-email": viewer.email, "x-event-id": E.event.nameId } });
    expect(res.statusCode).toBe(200);
  }, 90_000);
});
