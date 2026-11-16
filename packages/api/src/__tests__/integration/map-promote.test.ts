/**
 * Promote (docs/map-patches.md §5; row G12a): an event's corrections saved
 * to its club map as a new version, through the import.
 *
 *   - the columns: defaults and checks
 *   - refusals: nothing to promote (empty, disabled), not a club map, not
 *     the latest version, signed out, a viewer; PATCH_PROMOTING for every
 *     write while a promote job runs; a failed job leaves no version
 *   - 08 §7: promote creates the version (seq + 1, label, promoter, one
 *     layer, a baked document) and empties the patch; the other event on
 *     the base version is untouched
 *   - the patch-aware import: dedup per patch, decide / finalise keep it,
 *     course.useClubMap takes the latest version's document
 *   - a re-match of the promoted version keeps the corrections; a second
 *     run finds nothing
 *   - a second promote stacks a layer and numbers never shift
 *   - delete of the latest promoted version; the GC and the per-event dump
 *   - completion's edges: an op the bake skipped stays in the event's patch,
 *     a version the event already pins survives a failed job, an event
 *     whose map moved is left alone
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync } from "fs";
import { createHash, randomBytes } from "crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { SYSTEM_GROUP_IDS, mapDocument } from "@oxygen/shared";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { grantSystemGroup } from "../../permissions.js";
import { applyEventMap } from "../../event-map.js";
import { decodedDocument } from "../../map-store/event-document.js";
import { abandonPromote, completePromote } from "../../map-store/patches.js";
import { getImportJob, kickImportJobs, startImportJob, type ImportJobRow } from "../../map-store/jobs.js";
import { decideOnDocument, finaliseDocument } from "../../map-store/review.js";
import { planRematch, rematchItem } from "../../map-store/rematch.js";
import { runStorageGc } from "../../map-store/gc.js";
import { registerBackupRoute, splitBackupSections } from "../../backup.js";
import type { AuthUser } from "../../auth.js";

const FIXTURE = resolve(__dirname, "../../../../../e2e/test.ocd");
const RESTORE_SCRIPT = resolve(__dirname, "../../../scripts/restore-map-blobs.sql");
const suffix = randomBytes(4).toString("hex");
const EMAIL_DOMAIN = `@map-promote-${suffix}.example`;
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const BASE = mapDocument.BAKED_SOURCE_INDEX_BASE;
const ADD_ID = "0190a0a0-0000-7000-8000-0000000000c1";
const GONE = 0x7ffffff0;

let A: TestEventContext; // promotes
let B: TestEventContext; // stays on version 1
let C: TestEventContext; // an uploaded map, no club version
let D: TestEventContext; // the failing promote
const extra: TestEventContext[] = [];
let fixture: Buffer;
let sourceHash: string;
let clubMapId: string;
let v1: { id: string; documentHash: string };
let v1Doc: mapDocument.MapDocument;
let promoter: AuthUser;
let admin: AuthUser;
let viewer: AuthUser;
let stranger: AuthUser;
let iPoint: number;
let iPoint2: number;
let lineSym: number;
let server: FastifyInstance;
let dir: string;

async function mkUser(name: string, isAdmin = false): Promise<AuthUser> {
  return A.db.user.create({ data: { email: `${name}${EMAIL_DOMAIN}`, displayName: name, isAdmin, active: true } });
}
const as = (ev: TestEventContext, user: AuthUser | null) => makeCaller(ev.event, { user, authEnabled: true, authMode: "proxy" });
const open = (ev: TestEventContext) => makeCaller(ev.event);
const pin = async (ev: TestEventContext) => ev.db.mapFile.findFirstOrThrow({ where: { eventId: ev.eventId }, select: { documentHash: true, clubMapVersionId: true } });
const versions = () => A.db.clubMapVersion.findMany({ where: { clubMapId }, orderBy: { seq: "asc" } });
const src = (doc: mapDocument.MapDocument, i: number) => doc.attrs.sourceIndex[i];
const sourceIndices = (doc: mapDocument.MapDocument) => Array.from(doc.attrs.sourceIndex);
const coordsAt = (doc: mapDocument.MapDocument, s: number): number[][] => {
  const i = sourceIndices(doc).indexOf(s);
  const out: number[][] = [];
  for (let k = doc.coordStart[i]; k < doc.coordStart[i + 1]; k++) out.push([doc.coords[k * 2], doc.coords[k * 2 + 1]]);
  return out;
};

async function useClubMap(ev: TestEventContext): Promise<void> {
  await open(ev).course.useClubMap({ clubMapId });
}

beforeAll(async () => {
  A = await createTestEvent("promote_a");
  B = await createTestEvent("promote_b");
  C = await createTestEvent("promote_c");
  D = await createTestEvent("promote_d");
  fixture = Buffer.concat([readFileSync(FIXTURE), Buffer.from(`map-promote-${suffix}`)]);
  sourceHash = sha256(fixture);
  // C uploads the file as its own map; the club series imports the same source (dedup: the same document).
  await applyEventMap(C.db, C.eventId, "test.ocd", fixture, {});
  clubMapId = (await A.db.clubMap.create({ data: { name: `promote-${suffix}` } })).id;
  await startImportJob(A.db, { sourceHash, clubMapId });
  v1 = await A.db.clubMapVersion.findFirstOrThrow({ where: { clubMapId }, select: { id: true, documentHash: true } });
  v1Doc = (await decodedDocument(A.db, v1.documentHash))!;
  await useClubMap(A);
  await useClubMap(B);

  const visible = (i: number) => {
    const s = v1Doc.header.symbols[v1Doc.attrs.symbolIdx[i]];
    return s && s.render && !s.hidden;
  };
  const points: number[] = [];
  for (let i = 0; i < v1Doc.header.objects.count && points.length < 2; i++) if (v1Doc.attrs.type[i] === mapDocument.OBJECT_TYPE.point && visible(i)) points.push(i);
  [iPoint, iPoint2] = points;
  lineSym = v1Doc.header.symbols.findIndex((s) => s.kind === "line" && s.render && !s.hidden && s.sourceIndex !== undefined);

  promoter = await mkUser("promoter");
  admin = await mkUser("admin", true);
  viewer = await mkUser("viewer");
  stranger = await mkUser("stranger");
  for (const ev of [A, B, C, D]) await grantSystemGroup(A.db, { eventId: ev.eventId, userId: promoter.id, groupId: SYSTEM_GROUP_IDS.courseSetter, grantedBy: promoter.id });
  const group = await A.db.permissionGroup.create({ data: { name: `Promote viewer ${suffix}`, capabilities: ["event.view", "courses.view"] } });
  await A.db.eventPermission.create({ data: { eventId: A.eventId, userId: viewer.id, groupId: group.id } });
  for (const ev of [A, B, C, D]) {
    await A.db.event.update({ where: { id: ev.eventId }, data: { date: new Date("2099-06-01T00:00:00Z") } });
    ev.event.date = new Date("2099-06-01T00:00:00Z");
  }
  dir = mkdtempSync(join(tmpdir(), "oxygen-promote-"));
}, 120_000);

afterAll(async () => {
  await server?.close();
  for (const ev of [A, B, C, D, ...extra]) await ev?.cleanup();
  await A.db.mapImportJob.deleteMany({ where: { sourceHash } });
  await A.db.clubMap.deleteMany({ where: { name: { contains: suffix } } });
  await A.db.mapDocument.deleteMany({ where: { sourceHash } });
  await A.db.mapSource.deleteMany({ where: { fileHash: sourceHash } });
  await A.db.permissionGroup.deleteMany({ where: { name: { contains: suffix } } });
  await A.db.user.deleteMany({ where: { email: { endsWith: EMAIL_DOMAIN } } });
  if (dir) rmSync(dir, { recursive: true, force: true });
  await disconnect();
}, 60_000);

describe("the columns (migration 20261116120000_map_version_patches)", () => {
  it("default to none and refuse a value that is not a list", async () => {
    const v = await A.db.clubMapVersion.findUniqueOrThrow({ where: { id: v1.id }, select: { patch: true } });
    expect(v.patch).toEqual([]);
    const job = await A.db.mapImportJob.findFirstOrThrow({ where: { clubMapId }, select: { patch: true } });
    expect(job.patch).toEqual([]);
    expect((await A.db.mapDocument.findUniqueOrThrow({ where: { hash: v1.documentHash }, select: { patch: true } })).patch).toBeNull();
    await expect(A.db.$executeRaw`UPDATE "oxygen"."club_map_versions" SET "patch" = '{}'::jsonb WHERE "id" = ${v1.id}::uuid`).rejects.toThrow(/club_map_versions_patch_check/);
    await expect(A.db.$executeRaw`UPDATE "oxygen"."map_documents" SET "patch" = '[]'::jsonb WHERE "hash" = ${v1.documentHash}`).rejects.toThrow(/map_documents_patch_check/);
  });
});

describe("promote refusals", () => {
  it("nothing to promote: an empty patch, Apply corrections off, only ops that do not apply", async () => {
    const caller = as(A, promoter);
    await expect(caller.mapPatch.promote({ label: "x" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/^PATCH_NOTHING_TO_PROMOTE/) });
    await caller.mapPatch.applyChange({ documentHash: v1.documentHash, put: [{ op: "hide", sourceIndex: GONE }] });
    await expect(caller.mapPatch.promote({ label: "x" })).rejects.toThrow(/^PATCH_NOTHING_TO_PROMOTE: no correction/);
    await caller.mapPatch.applyChange({ documentHash: v1.documentHash, put: [{ op: "hide", sourceIndex: src(v1Doc, iPoint) }] });
    await caller.mapPatch.setEnabled({ enabled: false });
    await expect(caller.mapPatch.promote({ label: "x" })).rejects.toThrow(/^PATCH_NOTHING_TO_PROMOTE: Apply corrections is off/);
    await caller.mapPatch.setEnabled({ enabled: true });
    expect(await versions()).toHaveLength(1);
  });

  it("a map that is not a club version, signed out, a viewer", async () => {
    const docC = (await pin(C)).documentHash!;
    await as(C, promoter).mapPatch.applyChange({ documentHash: docC, put: [{ op: "hide", sourceIndex: src(v1Doc, iPoint) }] });
    await expect(as(C, promoter).mapPatch.promote({ label: "x" })).rejects.toThrow(/^PATCH_NOT_CLUB_MAP/);
    await expect(as(A, null).mapPatch.promote({ label: "x" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(as(A, viewer).mapPatch.promote({ label: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as(A, promoter).mapPatch.promote({ label: "  " })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses every write with PATCH_PROMOTING while the event's promote job runs, and reports it", async () => {
    // A running job of another instance with a fresh heartbeat: no engine here claims it.
    const job = await A.db.mapImportJob.create({
      data: { eventId: A.eventId, clubMapId, sourceHash, state: "running", stage: "encode", progress: 0.7, claimedBy: "elsewhere", heartbeatAt: new Date(), patch: [{ unitsPerMm: 100, ops: {}, symbols: [] }] },
    });
    try {
      const caller = as(A, promoter);
      const refused = { code: "PRECONDITION_FAILED", message: expect.stringMatching(/^PATCH_PROMOTING/) };
      await expect(caller.mapPatch.applyChange({ documentHash: v1.documentHash, put: [{ op: "hide", sourceIndex: src(v1Doc, iPoint2) }] })).rejects.toMatchObject(refused);
      await expect(caller.mapPatch.setEnabled({ enabled: false })).rejects.toMatchObject(refused);
      await expect(caller.mapPatch.attachUnresolved({ documentHash: v1.documentHash, key: "x", sourceIndex: 1 })).rejects.toMatchObject(refused);
      await expect(caller.mapPatch.promote({ label: "x" })).rejects.toMatchObject(refused);
      expect(await as(A, viewer).mapPatch.promoteStatus()).toEqual({ id: job.id, state: "running", stage: "encode", progress: expect.closeTo(0.7, 5), error: null });
      expect(await as(B, promoter).mapPatch.promoteStatus()).toBeNull();
    } finally {
      await A.db.mapImportJob.delete({ where: { id: job.id } });
    }
  });

  it("a failed promote job deletes its pending version and leaves the patch whole", async () => {
    // D's map is a source the importer cannot read, adopted as a club version by hand.
    const bad = Buffer.from(`not a map ${suffix}`);
    const badHash = sha256(bad);
    await A.db.mapSource.create({ data: { fileHash: badHash, kind: "ocad", bytes: bad, sizeBytes: bad.byteLength, fileName: "bad.ocd" } });
    const badClub = await A.db.clubMap.create({ data: { name: `promote-bad-${suffix}` } });
    const realBytes = (await A.db.mapDocument.findUniqueOrThrow({ where: { hash: v1.documentHash }, select: { bytes: true } })).bytes;
    const badDoc = await A.db.mapDocument.create({
      data: { hash: randomBytes(32).toString("hex"), bytes: realBytes, sizeBytes: realBytes.byteLength, formatVersion: 1, importerVersion: "x", libraryVersion: "x", sourceHash: badHash, header: {}, report: {} },
    });
    const base = await A.db.clubMapVersion.create({ data: { clubMapId: badClub.id, seq: 1, label: "bad", sourceHash: badHash, documentHash: badDoc.hash } });
    await A.db.mapFile.create({ data: { eventId: D.eventId, fileName: "bad.ocd", sourceHash: badHash, documentHash: badDoc.hash, clubMapVersionId: base.id } });
    // The real document's bytes under another hash: decodable, so promote gets as far as the job.
    const r = await as(D, promoter).mapPatch.applyChange({ documentHash: badDoc.hash, put: [{ op: "hide", sourceIndex: src(v1Doc, iPoint) }] });
    expect(Object.keys(r.patch!.ops)).toEqual([`hide:${src(v1Doc, iPoint)}`]);
    const res = await as(D, promoter).mapPatch.promote({ label: "doomed" });
    let job: ImportJobRow | null = await getImportJob(A.db, res.job.id);
    for (let t = 0; job && job.state !== "failed" && t < 100; t++) {
      await kickImportJobs(A.db);
      await new Promise((ok) => setTimeout(ok, 100));
      job = await getImportJob(A.db, res.job.id);
    }
    expect(job?.state).toBe("failed");
    expect(await A.db.clubMapVersion.findMany({ where: { clubMapId: badClub.id }, select: { seq: true } })).toEqual([{ seq: 1 }]);
    expect(Object.keys((await open(D).mapPatch.get()).patch!.ops)).toEqual([`hide:${src(v1Doc, iPoint)}`]);
    expect(await open(D).mapPatch.promoteStatus()).toMatchObject({ state: "failed" });
    await A.db.mapFile.deleteMany({ where: { eventId: D.eventId } });
    await A.db.mapPatch.deleteMany({ where: { eventId: D.eventId } });
    await A.db.mapImportJob.deleteMany({ where: { sourceHash: badHash } });
    await A.db.clubMap.delete({ where: { id: badClub.id } });
    await A.db.mapDocument.delete({ where: { hash: badDoc.hash } });
    await A.db.mapSource.delete({ where: { fileHash: badHash } });
  }, 60_000);
});

let v2: { id: string; documentHash: string; patch: mapDocument.VersionPatch };
let v2Doc: mapDocument.MapDocument;

describe("promote (08 §7)", () => {
  it("creates the version, pins the event onto it and empties the patch; the other event stays on version 1", async () => {
    const caller = as(A, promoter);
    const add: mapDocument.PatchOp = { op: "add", id: ADD_ID, type: mapDocument.OBJECT_TYPE.line, symbol: { doc: lineSym }, coords: [[0, 0], [5000, 2000], [9000, 0]] };
    await caller.mapPatch.applyChange({ documentHash: v1.documentHash, put: [add] });
    // An unresolved entry from an older edition: not promoted, kept.
    const from = randomBytes(32).toString("hex");
    const entry: mapDocument.UnresolvedOp = { op: { op: "hide", sourceIndex: 5 }, from, fromSource: "an older edition", unitsPerMm: 100, reason: "target" };
    const entryKey = mapDocument.unresolvedKey(from, entry.op);
    await A.db.mapPatch.update({ where: { eventId: A.eventId }, data: { unresolved: { [entryKey]: entry } } });
    const before = await caller.mapPatch.get();
    const bPin = await pin(B);

    const res = await caller.mapPatch.promote({ label: "Corrected for the club champs" });
    expect(res.job.state).toBe("done");
    expect(res.clubMapVersion).toMatchObject({ clubMapId, seq: 2, label: "Corrected for the club champs" });

    const all = await versions();
    expect(all.map((v) => v.seq)).toEqual([1, 2]);
    expect(all[0]).toMatchObject({ id: v1.id, documentHash: v1.documentHash, patch: [] });
    const row = all[1];
    expect(row).toMatchObject({ label: "Corrected for the club champs", uploadedBy: promoter.id, sourceHash });
    const layers = mapDocument.parseVersionPatch(row.patch);
    expect(layers).toHaveLength(1);
    expect(Object.keys(layers[0].ops)).toEqual([`add:${ADD_ID}`, `hide:${src(v1Doc, iPoint)}`]);
    expect(layers[0].ops[`add:${ADD_ID}`]).toMatchObject({ symbol: { doc: mapDocument.symbolAnchor(v1Doc, lineSym) } });
    v2 = { id: row.id, documentHash: row.documentHash, patch: layers };

    // The baked document: the hidden object gone, the path numbered from 0x80000000, the patch recorded.
    expect(v2.documentHash).not.toBe(v1.documentHash);
    const docRow = await A.db.mapDocument.findUniqueOrThrow({ where: { hash: v2.documentHash }, select: { patch: true, sourceHash: true, report: true } });
    expect(docRow.sourceHash).toBe(sourceHash);
    expect(mapDocument.sameVersionPatch(docRow.patch, row.patch)).toBe(true);
    expect((docRow.report as { corrections?: unknown }).corrections).toEqual({ layers: 1, ops: 2, issues: [] });
    v2Doc = (await decodedDocument(A.db, v2.documentHash))!;
    expect(sourceIndices(v2Doc)).not.toContain(src(v1Doc, iPoint));
    expect(coordsAt(v2Doc, BASE)).toEqual([[0, 0], [5000, 2000], [9000, 0]]);
    expect(v2Doc.header.objects.count).toBe(v1Doc.header.objects.count);

    // The event: on version 2; the promoted ops gone, the rest re-keyed onto the new pin.
    expect(await pin(A)).toEqual({ documentHash: v2.documentHash, clubMapVersionId: v2.id });
    const after = await caller.mapPatch.get();
    expect(after.patch!.documentHash).toBe(v2.documentHash);
    expect(after.patch!.ops).toEqual({});
    expect(BigInt(after.version)).toBeGreaterThan(BigInt(before.version));
    expect((await caller.course.mapMetadata()).patchVersion).toBe(after.version);
    const unresolved = Object.keys(after.patch!.unresolved ?? {});
    expect(unresolved).toContain(entryKey);
    // The op that did not apply was not promoted: it stays, unresolved now that its pin moved (§4.4).
    expect(unresolved).toContain(mapDocument.unresolvedKey(v1.documentHash, { op: "hide", sourceIndex: GONE }));
    expect(await caller.mapPatch.promoteStatus()).toMatchObject({ id: res.job.id, state: "done" });

    // The other event on version 1 is untouched.
    expect(await pin(B)).toEqual(bPin);
    expect(bPin).toEqual({ documentHash: v1.documentHash, clubMapVersionId: v1.id });

    // The download stays the original file (§5 answer 8); the list counts the corrections.
    const dl = await as(A, promoter).clubMap.download({ id: clubMapId });
    expect(Buffer.from(dl.fileDataBase64, "base64").equals(fixture)).toBe(true);
    // Named by its source, not by the promote's free-text label (G12b).
    expect(dl.fileName).toBe("test.ocd");
    const listed = (await open(A).clubMap.list()).find((m) => m.id === clubMapId)!;
    expect(listed.fileName).toBe("test.ocd");
    expect(listed.version).toMatchObject({ id: v2.id, seq: 2, layers: 1, corrections: 2, documentHash: v2.documentHash });
    expect(listed.versionCount).toBe(2);
  }, 120_000);

  it("refuses a promote from a version that is no longer the latest", async () => {
    await as(B, promoter).mapPatch.applyChange({ documentHash: v1.documentHash, put: [{ op: "hide", sourceIndex: src(v1Doc, iPoint2) }] });
    await expect(as(B, promoter).mapPatch.promote({ label: "x" })).rejects.toThrow(/^PATCH_NOT_LATEST/);
    expect(await versions()).toHaveLength(2);
  });
});

describe("the patch-aware import", () => {
  it("dedups per patch: the version's corrections find its document, none finds version 1's", async () => {
    const plain = await startImportJob(A.db, { sourceHash });
    const patched = await startImportJob(A.db, { sourceHash, patch: v2.patch });
    expect(plain).toMatchObject({ state: "done", documentHash: v1.documentHash, patch: [] });
    expect(patched).toMatchObject({ state: "done", documentHash: v2.documentHash });
    expect(mapDocument.sameVersionPatch(patched.patch, v2.patch)).toBe(true);
  });

  it("decide on the promoted document keeps its corrections; finalise moves only the matching version", async () => {
    const decided = await decideOnDocument(A.db, { hash: v2.documentHash, decisions: [], userId: null });
    expect(decided.ok && decided.job.documentHash).toBe(v2.documentHash);
    expect(await finaliseDocument(A.db, v1.documentHash, { kind: "club", clubMapId })).toEqual({ ok: true, pinned: 1, previous: [v1.documentHash] });
    const [one, two] = await versions();
    expect(one.documentHash).toBe(v1.documentHash);
    expect(two.documentHash).toBe(v2.documentHash);
    // A's row is on version 2's corrections: version 1's document is another target.
    expect(await finaliseDocument(A.db, v1.documentHash, { kind: "event", eventId: A.eventId })).toEqual({ ok: false, reason: "source-mismatch" });
    expect(await finaliseDocument(A.db, v2.documentHash, { kind: "event", eventId: A.eventId })).toMatchObject({ ok: true, pinned: 1 });
  });

  it("course.useClubMap takes the latest version's document", async () => {
    const E = await createTestEvent("promote_e");
    extra.push(E);
    await useClubMap(E);
    expect(await pin(E)).toEqual({ documentHash: v2.documentHash, clubMapVersionId: v2.id });
    // Named by the source, not the promote's label (G12b; map-storage §6.5).
    expect((await E.db.mapFile.findFirstOrThrow({ where: { eventId: E.eventId }, select: { fileName: true } })).fileName).toBe("test.ocd");
  });
});

describe("re-match of a promoted version (§6.9)", () => {
  it("re-imports it with its corrections, leaves version 1 unpatched, and a second run finds nothing", async () => {
    // The promoted version and A pinned to a document of an older importer, as a release bump leaves them.
    const bytes = Buffer.from(`stale-promoted-${suffix}`);
    const stale = sha256(bytes);
    await A.db.mapDocument.create({
      data: { hash: stale, bytes, sizeBytes: bytes.byteLength, formatVersion: 1, importerVersion: "ocad-3", libraryVersion: "none", sourceHash, header: {}, report: {}, patch: v2.patch as never },
    });
    await A.db.clubMapVersion.update({ where: { id: v2.id }, data: { documentHash: stale } });
    await A.db.mapFile.updateMany({ where: { eventId: A.eventId }, data: { documentHash: stale } });
    const mine = async () => (await planRematch(A.db)).filter((i) => i.sourceHash === sourceHash);
    const items = await mine();
    expect(items).toEqual([
      expect.objectContaining({ kind: "club", id: v2.id, documentHash: stale, reason: "importer", patch: v2.patch }),
      expect.objectContaining({ kind: "event", id: String(A.eventId), documentHash: stale, reason: "importer", patch: v2.patch }),
    ]);
    for (const item of items) expect(await rematchItem(A.db, item, 60_000)).toMatchObject({ outcome: "done", newDocumentHash: v2.documentHash });
    const [one, two] = await versions();
    expect(one.documentHash).toBe(v1.documentHash);
    expect(two.documentHash).toBe(v2.documentHash);
    expect((await pin(A)).documentHash).toBe(v2.documentHash);
    expect(await mine()).toEqual([]);
    await A.db.mapDocument.delete({ where: { hash: stale } });
  }, 120_000);
});

let v3: { id: string; documentHash: string };

describe("a second promote", () => {
  it("stacks a layer: the added path modified, another object hidden, numbers unchanged", async () => {
    const caller = as(A, promoter);
    await caller.mapPatch.applyChange({
      documentHash: v2.documentHash,
      put: [
        { op: "modify", sourceIndex: BASE, coords: [[100, 100], [6000, 3000]] },
        { op: "hide", sourceIndex: src(v1Doc, iPoint2) },
      ],
    });
    const res = await caller.mapPatch.promote({ label: "Second round" });
    expect(res.job.state).toBe("done");
    expect(res.clubMapVersion.seq).toBe(3);
    const row = (await versions())[2];
    const layers = mapDocument.parseVersionPatch(row.patch);
    expect(layers).toHaveLength(2);
    expect(layers[0]).toEqual(v2.patch[0]);
    expect(Object.keys(layers[1].ops)).toEqual([`hide:${src(v1Doc, iPoint2)}`, `modify:${BASE}`]);
    v3 = { id: row.id, documentHash: row.documentHash };
    const doc = (await decodedDocument(A.db, v3.documentHash))!;
    expect(coordsAt(doc, BASE)).toEqual([[100, 100], [6000, 3000]]);
    expect(sourceIndices(doc)).not.toContain(src(v1Doc, iPoint2));
    expect(sourceIndices(doc)).not.toContain(src(v1Doc, iPoint));
    expect(sourceIndices(doc).filter((s) => s >= BASE)).toEqual([BASE]);
    expect(await pin(A)).toEqual({ documentHash: v3.documentHash, clubMapVersionId: v3.id });
    expect((await caller.mapPatch.get()).patch!.ops).toEqual({});
  }, 120_000);
});

describe("the GC and the per-event dump", () => {
  it("keep the promoted documents while a version or a pin references them", async () => {
    const gc = await runStorageGc(A.db, { dryRun: true, graceDays: 0 });
    for (const h of [v1.documentHash, v2.documentHash, v3.documentHash]) expect(gc.documents).not.toContain(h);
    expect(gc.sources).not.toContain(sourceHash);
  });

  it("carry the promoted document with its patch, and restore it", async () => {
    server = Fastify({ logger: false });
    registerBackupRoute(server);
    await server.ready();
    const res = await server.inject({ method: "GET", url: `/api/backup/event?name=${A.nameId}` });
    expect(res.statusCode).toBe(200);
    const sections = splitBackupSections(res.body);
    const docs = sections.get("map_documents")!.trim().split("\n");
    expect(docs[0].split(",").at(-1)).toBe("patch");
    const row = docs.find((l) => l.startsWith(`${v3.documentHash},`))!;
    expect(row).toContain("unitsPerMm");
    const out = join(dir, "dump");
    mkdirSync(out);
    for (const t of ["map_sources", "map_documents", "club_symbol_decisions", "map_files"]) writeFileSync(join(out, `${t}.csv`), sections.get(t)!);

    // The document gone from this database (nothing references it but the event and its jobs), then restored.
    const R = await createTestEvent("promote_r");
    extra.push(R);
    await A.db.mapFile.deleteMany({ where: { eventId: A.eventId } });
    await A.db.mapPatch.deleteMany({ where: { eventId: A.eventId } });
    await A.db.clubMapVersion.update({ where: { id: v3.id }, data: { documentHash: v2.documentHash } });
    await A.db.mapImportJob.updateMany({ where: { documentHash: v3.documentHash }, data: { documentHash: null } });
    await A.db.mapDocument.delete({ where: { hash: v3.documentHash } });
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.delete("schema");
    execFileSync("psql", [url.toString(), "-X", "-q", "-v", `event_id=${R.eventId}`, "-f", RESTORE_SCRIPT], { stdio: "pipe", cwd: out });
    const restored = await A.db.mapDocument.findUniqueOrThrow({ where: { hash: v3.documentHash }, select: { patch: true } });
    expect(mapDocument.parseVersionPatch(restored.patch)).toHaveLength(2);
    expect((await pin(R)).documentHash).toBe(v3.documentHash);
    // Restored current: the re-match has nothing to do for it.
    expect((await planRematch(A.db, { eventId: R.eventId })).filter((i) => i.sourceHash === sourceHash)).toEqual([]);
    // A back on version 3, as before.
    await A.db.clubMapVersion.update({ where: { id: v3.id }, data: { documentHash: v3.documentHash } });
    await useClubMap(A);
    expect(await pin(A)).toEqual({ documentHash: v3.documentHash, clubMapVersionId: v3.id });
  }, 60_000);
});

describe("delete of the latest promoted version (§5 answer 7)", () => {
  it("only the latest promoted version, by its promoter or an admin; events keep their document", async () => {
    const asPromoter = makeCaller(null, { user: promoter, authEnabled: true, authMode: "proxy" });
    const asAdmin = makeCaller(null, { user: admin, authEnabled: true, authMode: "proxy" });
    const asStranger = makeCaller(null, { user: stranger, authEnabled: true, authMode: "proxy" });
    await expect(asStranger.clubMap.removeVersion({ id: clubMapId, versionId: v3.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(asPromoter.clubMap.removeVersion({ id: clubMapId, versionId: v2.id })).rejects.toThrow(/^VERSION_NOT_LATEST/);
    await expect(asPromoter.clubMap.removeVersion({ id: clubMapId, versionId: "0190a0a0-0000-7000-8000-0000000000ff" })).rejects.toMatchObject({ code: "NOT_FOUND" });

    await asPromoter.clubMap.removeVersion({ id: clubMapId, versionId: v3.id });
    expect((await versions()).map((v) => v.seq)).toEqual([1, 2]);
    expect(await pin(A)).toEqual({ documentHash: v3.documentHash, clubMapVersionId: null });
    const listed = (await open(A).clubMap.list()).find((m) => m.id === clubMapId)!;
    expect(listed.version).toMatchObject({ id: v2.id, seq: 2, layers: 1 });
    // The GC keeps what the event still pins.
    expect((await runStorageGc(A.db, { dryRun: true, graceDays: 0 })).documents).not.toContain(v3.documentHash);
    // A no longer pins a club version: promoting again is refused.
    await as(A, promoter).mapPatch.applyChange({ documentHash: v3.documentHash, put: [{ op: "hide", sourceIndex: BASE }] });
    await expect(as(A, promoter).mapPatch.promote({ label: "x" })).rejects.toThrow(/^PATCH_NOT_CLUB_MAP/);

    await asAdmin.clubMap.removeVersion({ id: clubMapId, versionId: v2.id });
    await expect(asAdmin.clubMap.removeVersion({ id: clubMapId, versionId: v1.id })).rejects.toThrow(/^VERSION_NOT_PROMOTED/);
    expect((await versions()).map((v) => v.seq)).toEqual([1]);
    expect((await pin(B)).clubMapVersionId).toBe(v1.id);
  });
});

describe("completion's edges (§5.4)", () => {
  it("keeps an op the bake skipped, never deletes a pinned version, and leaves an event whose map moved", async () => {
    const F = await createTestEvent("promote_f");
    extra.push(F);
    await useClubMap(F);
    const a = `hide:${src(v1Doc, iPoint)}`, b = `hide:${src(v1Doc, iPoint2)}`;
    await open(F).mapPatch.applyChange({ documentHash: v1.documentHash, put: [{ op: "hide", sourceIndex: src(v1Doc, iPoint) }, { op: "hide", sourceIndex: src(v1Doc, iPoint2) }] });
    const layers: mapDocument.VersionPatch = [{ unitsPerMm: 100, symbols: [], ops: { [a]: { op: "hide", sourceIndex: src(v1Doc, iPoint) }, [b]: { op: "hide", sourceIndex: src(v1Doc, iPoint2) } } }];
    // The job's document: its report says the bake skipped b (as when a target is gone from a fresh import).
    const bytes = (await A.db.mapDocument.findUniqueOrThrow({ where: { hash: v1.documentHash }, select: { bytes: true } })).bytes;
    const hash = randomBytes(32).toString("hex");
    await A.db.mapDocument.create({
      data: {
        hash, bytes, sizeBytes: bytes.byteLength, formatVersion: 1, importerVersion: "x", libraryVersion: "x", sourceHash, header: {}, patch: layers as never,
        report: { corrections: { layers: 1, ops: 2, issues: [{ layer: 0, opId: b, code: "target-missing" }] } },
      },
    });
    const version = await A.db.clubMapVersion.create({ data: { clubMapId, seq: 2, label: "edge", sourceHash, documentHash: hash, patch: layers as never } });
    const job = { eventId: F.eventId, clubMapId, sourceHash, documentHash: hash, patch: layers };

    expect(await completePromote(A.db, job)).toEqual({ outcome: "pinned", versionId: version.id });
    expect(await pin(F)).toEqual({ documentHash: hash, clubMapVersionId: version.id });
    expect(Object.keys((await open(F).mapPatch.get()).patch!.ops)).toEqual([b]);

    // A failure after the pin: the version holds corrections that left the patch, so it stays.
    expect(await abandonPromote(A.db, job)).toEqual([]);
    expect(await A.db.clubMapVersion.count({ where: { id: version.id } })).toBe(1);

    // Run again (a re-claim): F is no longer on the base version, so nothing moves.
    expect(await completePromote(A.db, job)).toMatchObject({ outcome: "skipped", versionId: version.id });
    expect(Object.keys((await open(F).mapPatch.get()).patch!.ops)).toEqual([b]);

    await A.db.mapFile.deleteMany({ where: { eventId: F.eventId } });
    await A.db.mapPatch.deleteMany({ where: { eventId: F.eventId } });
    await A.db.clubMapVersion.delete({ where: { id: version.id } });
    await A.db.mapDocument.delete({ where: { hash } });
  }, 60_000);
});
