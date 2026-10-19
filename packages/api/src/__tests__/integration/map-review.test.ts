/**
 * The review round end to end (docs/map-storage.md §6.8, docs/map-import.md
 * §2.2, docs/map-symbols.md §8.5; research 06 §5.1, §5.3): `review` rows on
 * the fixture, `decide` writing `club_symbol_decisions` and producing an
 * unpinned document, `finalise` pinning it on the event and on a club map
 * version, decisions applied to a second file of the same symbols, the
 * dedup clause, the job snapshot and `reset`.
 *
 * `club_symbol_decisions` is global to the instance and keyed by symbol
 * geometry, so the fixture's rows would apply to every other suite's
 * import of `test.ocd`: integration files run one at a time, and this one
 * deletes the rows it writes before and after.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { createHash, randomBytes } from "crypto";
import { mapDocument, mapImport, SYSTEM_GROUP_IDS, symbolLibrary } from "@oxygen/shared";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { grantSystemGroup } from "../../permissions.js";
import { applyEventMap } from "../../event-map.js";
import { startImportJob } from "../../map-store/jobs.js";
import { getBlob } from "../../map-store/blob-store.js";
import type { AuthUser } from "../../auth.js";

const FIXTURE = resolve(__dirname, "../../../../../e2e/test.ocd");
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const V = `ISOM2017-2@${symbolLibrary.SYMBOL_LIBRARY_VERSION}`;

let ctx: TestEventContext;
let fixtureA: Buffer;
let fixtureB: Buffer;
let hashA: string;
let hashB: string;
let docA: string;
let docB: string;
let ring: number;
let ringFp: string;
let admin: AuthUser;
let setter: AuthUser;
let stranger: AuthUser;
let clubMapId: string;
const suffix = randomBytes(3).toString("hex");
const EMAIL_DOMAIN = `@map-review-${suffix}.example`;

async function mkUser(name: string, isAdmin = false): Promise<AuthUser> {
  return ctx.db.user.create({ data: { email: `${name}${EMAIL_DOMAIN}`, displayName: name, isAdmin, active: true } });
}
const caller = (u: AuthUser | null, withEvent = true) => makeCaller(withEvent ? ctx.event : null, { user: u, authEnabled: true, authMode: "proxy" });

async function headerOf(hash: string) {
  const bytes = await getBlob(ctx.db, "map_documents", hash);
  return mapDocument.readMapDocumentHeader(bytes!).header;
}

async function clearDecisions() {
  if (ringFp) await ctx.db.clubSymbolDecision.deleteMany({ where: { fingerprint: ringFp } });
}

beforeAll(async () => {
  ctx = await createTestEvent("map_review");
  // Own source hashes via a per-run trailer (the OCAD reader ignores trailing bytes): two "editions" of one map.
  const base = readFileSync(FIXTURE);
  fixtureA = Buffer.concat([base, Buffer.from(`map-review-a-${suffix}`)]);
  fixtureB = Buffer.concat([base, Buffer.from(`map-review-b-${suffix}`)]);
  hashA = sha256(fixtureA);
  hashB = sha256(fixtureB);
  admin = await mkUser("admin", true);
  setter = await mkUser("setter");
  stranger = await mkUser("stranger");
  await grantSystemGroup(ctx.db, { eventId: ctx.eventId, userId: setter.id, groupId: SYSTEM_GROUP_IDS.courseSetter, grantedBy: admin.id });
  await ctx.db.event.update({ where: { id: ctx.eventId }, data: { date: new Date("2099-06-01T00:00:00Z") } });
  ctx.event.date = new Date("2099-06-01T00:00:00Z");
  const club = await ctx.db.clubMap.create({ data: { name: `review-${suffix}` } });
  clubMapId = club.id;

  const applied = await applyEventMap(ctx.db, ctx.eventId, "test.ocd", fixtureA, { uploadedBy: setter.id, startedBy: setter.id });
  docA = applied.documentHash!;
  const header = await headerOf(docA);
  ring = header.symbols.findIndex((s) => s.code === "702.0");
  ringFp = mapImport.documentSymbolFingerprints(header)[ring]!;
  // A crashed earlier run may have left the fixture's rows behind; they would apply to docA's re-imports.
  await clearDecisions();
}, 90_000);

afterAll(async () => {
  await clearDecisions();
  const sources = [hashA, hashB];
  await ctx.cleanup();
  await ctx.db.clubMap.deleteMany({ where: { name: { contains: suffix } } });
  await ctx.db.mapImportJob.deleteMany({ where: { sourceHash: { in: sources } } });
  await ctx.db.mapDocument.deleteMany({ where: { sourceHash: { in: sources } } });
  await ctx.db.mapSource.deleteMany({ where: { fileHash: { in: sources } } });
  await ctx.db.user.deleteMany({ where: { email: { endsWith: EMAIL_DOMAIN } } });
  await disconnect();
}, 30_000);

describe("mapImport.review", () => {
  it("returns a row per source symbol with match, candidates, swatch URLs, colour class and flags", async () => {
    const r = await caller(setter).mapImport.review({ documentHash: docA });
    expect(r).toMatchObject({ documentHash: docA, current: true, library: { id: "ISOM2017-2", version: symbolLibrary.SYMBOL_LIBRARY_VERSION } });
    const header = await headerOf(docA);
    expect(r.symbols.length).toBe(header.symbols.filter((s) => s.origin === "source").length);
    const row = r.symbols.find((s) => s.symbolIdx === ring)!;
    expect(row).toMatchObject({ code: "702.0", type: "point", fingerprint: ringFp, previewUrl: `/api/map-documents/${docA}/symbols/${ring}.png` });
    expect(row.match).toMatchObject({ canonicalId: "ISOM2017-2:703", state: "suggested" });
    expect(row.candidates[0]).toMatchObject({ canonicalId: "ISOM2017-2:703", previewUrl: `/api/library/ISOM2017-2/${symbolLibrary.SYMBOL_LIBRARY_VERSION}/703.png` });
    expect(row.candidates.length).toBeLessThanOrEqual(3);
    expect(row.candidates[0].reasons.length).toBeGreaterThan(0);
    expect(row.colourClass).toBe("purple");
    // Object counts come from the attrs section and add up to the document's objects.
    const total = r.symbols.reduce((n, s) => n + s.objects, 0);
    expect(total).toBeLessThanOrEqual(header.objects.count);
    expect(total).toBeGreaterThan(0);
    expect(r.stack.colours).toEqual(header.colours);
    expect(r.report).toMatchObject({ matching: { library: { id: "ISOM2017-2" } } });
  }, 30_000);

  it("is gated by the document route's predicate", async () => {
    await expect(caller(stranger).mapImport.review({ documentHash: docA })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(null).mapImport.review({ documentHash: docA })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    // Kiosk key through the pinning event (as the document route).
    const kiosk = await ctx.db.event.update({ where: { id: ctx.eventId }, data: { kioskKey: `k-${suffix}` }, select: { kioskKey: true } });
    const asKiosk = makeCaller(ctx.event, { user: stranger, authEnabled: true, authMode: "proxy", kioskKey: kiosk.kioskKey });
    await expect(asKiosk.mapImport.review({ documentHash: docA })).resolves.toMatchObject({ documentHash: docA });
    await expect(makeCaller(null).mapImport.review({ documentHash: "f".repeat(64) })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(makeCaller(null).mapImport.review({ documentHash: "nothex" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("mapImport.decide", () => {
  it("writes the club decision and produces a new, unpinned document drawn canonically", async () => {
    const before = await ctx.db.mapFile.findFirstOrThrow({ where: { eventId: ctx.eventId }, select: { documentHash: true } });
    const res = await caller(setter).mapImport.decide({ documentHash: docA, decisions: [{ symbolIdx: ring, accept: "ISOM2017-2:703" }] });
    expect(res.applied).toBe(1);
    expect(res.job).toMatchObject({ state: "done", eventId: null, clubMapId: null, sourceHash: hashA });
    docB = res.job.documentHash!;
    expect(docB).toMatch(/^[0-9a-f]{64}$/);
    expect(docB).not.toBe(docA);
    expect(res.job.report).toMatchObject({ matching: { byMethod: { explicit: 1 }, symbols: { reviewed: 1 } } });

    const row = await ctx.db.clubSymbolDecision.findUniqueOrThrow({ where: { fingerprint_libraryVersion: { fingerprint: ringFp, libraryVersion: V } } });
    expect(row).toMatchObject({ canonicalId: "ISOM2017-2:703", decidedBy: setter.id });
    const job = await ctx.db.mapImportJob.findUniqueOrThrow({ where: { id: res.job.id }, select: { decisions: true, startedBy: true } });
    expect(job.startedBy).toBe(setter.id);
    expect(job.decisions).toEqual([{ code: "702", irHash: ringFp.split(":")[2], canonicalId: "ISOM2017-2:703", libraryId: "ISOM2017-2" }]);

    const decided = (await headerOf(docB)).symbols[ring];
    expect(decided.match).toMatchObject({ canonicalId: "ISOM2017-2:703", method: "explicit", state: "auto", reviewed: true });
    expect(mapDocument.isAppliedMatch(decided.match)).toBe(true);
    // Not pinned: the event still draws the matcher's output.
    expect(await ctx.db.mapFile.findFirstOrThrow({ where: { eventId: ctx.eventId }, select: { documentHash: true } })).toEqual(before);
  }, 60_000);

  it("lets the decider review the new document without an event (own job), and marks the old one stale", async () => {
    const own = await caller(setter, false).mapImport.review({ documentHash: docB });
    expect(own).toMatchObject({ current: true });
    expect(own.symbols.find((s) => s.symbolIdx === ring)!.match).toMatchObject({ method: "explicit", reviewed: true });
    // The proposal stays visible, so reset knows what it returns to.
    expect(own.symbols.find((s) => s.symbolIdx === ring)!.candidates[0].canonicalId).toBe("ISOM2017-2:703");
    expect((await caller(setter).mapImport.review({ documentHash: docA })).current).toBe(false);
    await expect(caller(stranger, false).mapImport.review({ documentHash: docB })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("is deterministic: the same file under the same decisions is the same document", async () => {
    const res = await caller(setter).mapImport.decide({ documentHash: docA, decisions: [{ symbolIdx: ring, accept: "ISOM2017-2:703" }] });
    expect(res.job).toMatchObject({ state: "done", documentHash: docB });
  }, 60_000);

  it("rejects decisions that do not fit the document, and callers without courses.edit", async () => {
    await expect(caller(setter).mapImport.decide({ documentHash: docA, decisions: [{ symbolIdx: ring, accept: "ISSprOM2019-2:703" }] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller(setter).mapImport.decide({ documentHash: docA, decisions: [{ symbolIdx: 9999, unmatch: true }] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller(stranger).mapImport.decide({ documentHash: docA, decisions: [{ symbolIdx: ring, unmatch: true }] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // The kiosk key reads but never decides.
    const asKiosk = makeCaller(ctx.event, { user: stranger, authEnabled: true, authMode: "proxy", kioskKey: `k-${suffix}` });
    await expect(asKiosk.mapImport.decide({ documentHash: docA, decisions: [{ symbolIdx: ring, unmatch: true }] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Nothing changed.
    expect(await ctx.db.clubSymbolDecision.count({ where: { fingerprint: ringFp } })).toBe(1);
  });

  it("applies the decision to a second file of the same symbols on import, and dedups to the decided document", async () => {
    await ctx.db.mapSource.create({ data: { fileHash: hashB, kind: "ocad", bytes: fixtureB, sizeBytes: fixtureB.byteLength, fileName: "edition-b.ocd" } });
    const second = await startImportJob(ctx.db, { sourceHash: hashB });
    expect(second.state).toBe("done");
    const doc = await ctx.db.mapDocument.findUniqueOrThrow({ where: { hash: second.documentHash! }, select: { report: true } });
    expect(doc.report).toMatchObject({ matching: { byMethod: { explicit: 1 }, symbols: { reviewed: 1 } } });
    // Dedup: the source of docA now imports to docB, not to the stale docA.
    const again = await startImportJob(ctx.db, { sourceHash: hashA });
    expect(again).toMatchObject({ state: "done", documentHash: docB });
  }, 60_000);
});

describe("mapImport.finalise", () => {
  it("pins the reviewed document on the event, idempotently", async () => {
    const res = await caller(setter).mapImport.finalise({ documentHash: docB, target: { kind: "event" } });
    expect(res).toEqual({ documentHash: docB, pinned: 1, previous: [docA] });
    expect(await ctx.db.mapFile.findFirstOrThrow({ where: { eventId: ctx.eventId }, select: { documentHash: true } })).toEqual({ documentHash: docB });
    const meta = await caller(setter).course.mapMetadata();
    expect(meta).toMatchObject({ documentHash: docB });
    expect(await caller(setter).mapImport.finalise({ documentHash: docB, target: { kind: "event" } })).toEqual({ documentHash: docB, pinned: 1, previous: [docB] });
  }, 30_000);

  it("refuses a document of another source, a missing event capability and a missing event", async () => {
    const other = await ctx.db.mapDocument.findFirstOrThrow({ where: { sourceHash: hashB }, select: { hash: true } });
    await expect(makeCaller(ctx.event).mapImport.finalise({ documentHash: other.hash, target: { kind: "event" } })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(caller(stranger).mapImport.finalise({ documentHash: docB, target: { kind: "event" } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(setter, false).mapImport.finalise({ documentHash: docB, target: { kind: "event" } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("moves the club map's version of the source to the reviewed document, keeping seq and label", async () => {
    // The club edition of file A: its import now applies the decision (docB).
    const imported = await startImportJob(ctx.db, { sourceHash: hashA, clubMapId });
    expect(imported.documentHash).toBe(docB);
    const v1 = await ctx.db.clubMapVersion.findFirstOrThrow({ where: { clubMapId }, select: { id: true, seq: true, label: true, documentHash: true } });
    expect(v1).toMatchObject({ seq: 1, documentHash: docB });

    // Review again on the club document: keep the ring as drawn in the file.
    const res = await caller(setter, false).mapImport.decide({ documentHash: docB, decisions: [{ symbolIdx: ring, unmatch: true }] });
    const docC = res.job.documentHash!;
    expect(docC).not.toBe(docB);
    expect((await headerOf(docC)).symbols[ring].match).toMatchObject({ canonicalId: null, method: "explicit", state: "unmatched", reviewed: true });
    expect(await ctx.db.clubSymbolDecision.findUniqueOrThrow({ where: { fingerprint_libraryVersion: { fingerprint: ringFp, libraryVersion: V } }, select: { canonicalId: true } })).toEqual({ canonicalId: null });

    const fin = await caller(setter, false).mapImport.finalise({ documentHash: docC, target: { kind: "club", clubMapId } });
    expect(fin).toEqual({ documentHash: docC, pinned: 1, previous: [docB] });
    const versions = await ctx.db.clubMapVersion.findMany({ where: { clubMapId }, select: { id: true, seq: true, label: true, documentHash: true } });
    expect(versions).toEqual([{ ...v1, documentHash: docC }]);
    // The event keeps the document it pinned (copy-on-use).
    expect(await ctx.db.mapFile.findFirstOrThrow({ where: { eventId: ctx.eventId }, select: { documentHash: true } })).toEqual({ documentHash: docB });

    const otherSource = await ctx.db.mapDocument.findFirstOrThrow({ where: { sourceHash: hashB }, select: { hash: true } });
    await expect(makeCaller(null).mapImport.finalise({ documentHash: otherSource.hash, target: { kind: "club", clubMapId } })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(makeCaller(null).mapImport.finalise({ documentHash: docC, target: { kind: "club", clubMapId: "01990e00-0000-7000-8000-00000000dead" } })).rejects.toMatchObject({ code: "NOT_FOUND" });
  }, 90_000);

  it("reset deletes the decision and returns the source to the matcher's own document", async () => {
    const res = await caller(setter).mapImport.decide({ documentHash: docB, decisions: [{ symbolIdx: ring, reset: true }] });
    expect(res.job).toMatchObject({ state: "done", documentHash: docA });
    expect(await ctx.db.clubSymbolDecision.count({ where: { fingerprint: ringFp } })).toBe(0);
    expect((await caller(setter).mapImport.review({ documentHash: docA })).current).toBe(true);
  }, 60_000);
});
