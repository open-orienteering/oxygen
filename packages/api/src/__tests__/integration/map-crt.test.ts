/**
 * CRT export / import end to end (docs/map-symbols.md §8.6,
 * docs/map-import.md §2.2; research 06 §5.1, §5.3): `exportCrt` writes
 * the club rows of a document, `importCrt` records a CRT through
 * `decide`'s path (same rows, same job, same document), reports what it
 * cannot apply, and leaves restated automatic matches alone.
 *
 * `club_symbol_decisions` is instance-global and keyed by symbol geometry
 * (see map-review.test.ts): this file deletes the fixture's rows it writes
 * before and after.
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
import { importOcadToDocument } from "../../import/ocad.js";
import { getBlob } from "../../map-store/blob-store.js";
import type { AuthUser } from "../../auth.js";

const FIXTURE = resolve(__dirname, "../../../../../e2e/test.ocd");
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const V = `ISOM2017-2@${symbolLibrary.SYMBOL_LIBRARY_VERSION}`;

let ctx: TestEventContext;
let sourceHash: string;
let docA: string;
let docB: string;
let ring: number;
let fps: (string | null)[];
let setter: AuthUser;
let stranger: AuthUser;
const suffix = randomBytes(3).toString("hex");
const EMAIL_DOMAIN = `@map-crt-${suffix}.example`;

const caller = (u: AuthUser | null) => makeCaller(ctx.event, { user: u, authEnabled: true, authMode: "proxy" });
const ruleLines = (crt: string) => crt.split("\n").filter((l) => l && !l.startsWith("#"));

async function clearDecisions() {
  const mine = (fps ?? []).filter((f): f is string => f !== null);
  if (mine.length) await ctx.db.clubSymbolDecision.deleteMany({ where: { fingerprint: { in: mine } } });
}

beforeAll(async () => {
  ctx = await createTestEvent("map_crt");
  const bytes = Buffer.concat([readFileSync(FIXTURE), Buffer.from(`map-crt-${suffix}`)]);
  sourceHash = sha256(bytes);
  const admin = await ctx.db.user.create({ data: { email: `admin${EMAIL_DOMAIN}`, displayName: "admin", isAdmin: true, active: true } });
  setter = await ctx.db.user.create({ data: { email: `setter${EMAIL_DOMAIN}`, displayName: "setter", active: true } });
  stranger = await ctx.db.user.create({ data: { email: `stranger${EMAIL_DOMAIN}`, displayName: "stranger", active: true } });
  await grantSystemGroup(ctx.db, { eventId: ctx.eventId, userId: setter.id, groupId: SYSTEM_GROUP_IDS.courseSetter, grantedBy: admin.id });
  await ctx.db.event.update({ where: { id: ctx.eventId }, data: { date: new Date("2099-06-01T00:00:00Z"), kioskKey: `k-${suffix}` } });
  ctx.event.date = new Date("2099-06-01T00:00:00Z");

  // Rows a crashed earlier run (or another suite) left for the fixture would change docA; clear them first.
  const header = mapDocument.readMapDocumentHeader((await importOcadToDocument(bytes, "Skogen.ocd")).bytes).header;
  fps = mapImport.documentSymbolFingerprints(header);
  await clearDecisions();

  const applied = await applyEventMap(ctx.db, ctx.eventId, "Skogen.ocd", bytes, { uploadedBy: setter.id, startedBy: setter.id });
  docA = applied.documentHash!;
  const stored = mapDocument.readMapDocumentHeader((await getBlob(ctx.db, "map_documents", docA))!).header;
  ring = stored.symbols.findIndex((s) => s.code === "702.0");
  expect(mapImport.documentSymbolFingerprints(stored)).toEqual(fps);
}, 90_000);

afterAll(async () => {
  await clearDecisions();
  await ctx.cleanup();
  await ctx.db.mapImportJob.deleteMany({ where: { sourceHash } });
  await ctx.db.mapDocument.deleteMany({ where: { sourceHash } });
  await ctx.db.mapSource.deleteMany({ where: { fileHash: sourceHash } });
  await ctx.db.user.deleteMany({ where: { email: { endsWith: EMAIL_DOMAIN } } });
  await disconnect();
}, 30_000);

describe("mapImport.exportCrt", () => {
  it("writes only the header before any decision, and the automatic matches on request", async () => {
    const out = await caller(setter).mapImport.exportCrt({ documentHash: docA });
    expect(out).toMatchObject({ documentHash: docA, fileName: "Skogen-ISOM2017-2.crt", library: { id: "ISOM2017-2", version: symbolLibrary.SYMBOL_LIBRARY_VERSION }, rules: 0, kept: 0, auto: 0 });
    expect(out.crt.split("\n")[0]).toBe(`# oxygen-crt library=${V} source=ocad document=${docA}`);
    expect(ruleLines(out.crt)).toEqual([]);

    const full = await caller(setter).mapImport.exportCrt({ documentHash: docA, includeMatches: true });
    expect(full).toMatchObject({ rules: 4, auto: 4 });
    // 603.0 is the fixture's white-framed spot height (A12), auto-matched to 603's text variant.
    expect(ruleLines(full.crt)).toEqual(["706       706.0", "601.b     601.0", "521       521.0", "603.b     603.0"]);
  });

  it("carries a decision with its fingerprint, from any document of the same symbols", async () => {
    const res = await caller(setter).mapImport.decide({ documentHash: docA, decisions: [{ symbolIdx: ring, accept: "ISOM2017-2:703" }] });
    docB = res.job.documentHash!;
    for (const hash of [docA, docB]) {
      const out = await caller(setter).mapImport.exportCrt({ documentHash: hash });
      expect(out).toMatchObject({ rules: 1, kept: 0, auto: 0 });
      expect(out.crt).toContain(`\n# fp ${fps[ring]} decision 702.0 Control point\n703       702.0\n`);
    }
  }, 60_000);

  it("is gated by the document route's predicate, as review", async () => {
    await expect(caller(stranger).mapImport.exportCrt({ documentHash: docA })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(null).mapImport.exportCrt({ documentHash: docA })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const kiosk = makeCaller(ctx.event, { user: null, authEnabled: true, authMode: "proxy", kioskKey: `k-${suffix}` });
    await expect(kiosk.mapImport.exportCrt({ documentHash: docA })).resolves.toMatchObject({ rules: 1 });
    await expect(makeCaller(null).mapImport.exportCrt({ documentHash: "f".repeat(64) })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(makeCaller(null).mapImport.exportCrt({ documentHash: "nothex" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("mapImport.importCrt", () => {
  let exported: string;

  it("records an exported CRT through decide: same row, same document as the original decision", async () => {
    exported = (await caller(setter).mapImport.exportCrt({ documentHash: docA })).crt;
    const reset = await caller(setter).mapImport.decide({ documentHash: docB, decisions: [{ symbolIdx: ring, reset: true }] });
    expect(reset.job.documentHash).toBe(docA);
    expect(await ctx.db.clubSymbolDecision.count({ where: { fingerprint: fps[ring]! } })).toBe(0);

    const res = await caller(setter).mapImport.importCrt({ documentHash: docA, crt: exported });
    expect(res).toMatchObject({ decisions: [{ symbolIdx: ring, accept: "ISOM2017-2:703" }], unchanged: [], skipped: [], warnings: [], applied: 1 });
    expect(res.job).toMatchObject({ state: "done", eventId: null, clubMapId: null, sourceHash, documentHash: docB });
    const row = await ctx.db.clubSymbolDecision.findUniqueOrThrow({ where: { fingerprint_libraryVersion: { fingerprint: fps[ring]!, libraryVersion: V } } });
    expect(row).toMatchObject({ canonicalId: "ISOM2017-2:703", decidedBy: setter.id });
    // Not pinned, as decide.
    expect(await ctx.db.mapFile.findFirstOrThrow({ where: { eventId: ctx.eventId }, select: { documentHash: true } })).toEqual({ documentHash: docA });
  }, 60_000);

  it("records a keep, and writes nothing on a dry run", async () => {
    const dry = await caller(setter).mapImport.importCrt({ documentHash: docA, crt: "# keep 702\n", dryRun: true });
    expect(dry).toMatchObject({ decisions: [{ symbolIdx: ring, unmatch: true }], applied: 0, job: null });
    expect((await ctx.db.clubSymbolDecision.findUniqueOrThrow({ where: { fingerprint_libraryVersion: { fingerprint: fps[ring]!, libraryVersion: V } } })).canonicalId).toBe("ISOM2017-2:703");

    const res = await caller(setter).mapImport.importCrt({ documentHash: docA, crt: "# keep 702\n" });
    expect(res.applied).toBe(1);
    const header = mapDocument.readMapDocumentHeader((await getBlob(ctx.db, "map_documents", res.job!.documentHash!))!).header;
    expect(header.symbols[ring].match).toMatchObject({ canonicalId: null, method: "explicit", reviewed: true });
    const out = await caller(setter).mapImport.exportCrt({ documentHash: docA });
    expect(out).toMatchObject({ rules: 0, kept: 1 });
    expect(out.crt).toContain(`\n# fp ${fps[ring]} decision 702.0 Control point\n# keep 702.0\n`);
  }, 60_000);

  it("reports what it cannot apply, writes nothing when nothing applies, and leaves restated auto matches alone", async () => {
    const before = await ctx.db.clubSymbolDecision.findMany({ where: { fingerprint: { in: fps.filter((f): f is string => f !== null) } }, orderBy: { fingerprint: "asc" } });
    const bad = await caller(setter).mapImport.importCrt({ documentHash: docA, crt: "999 702.0\n703 888.0\n406    natural = wood\n" });
    expect(bad).toMatchObject({ decisions: [], applied: 0, job: null });
    expect(Object.fromEntries(bad.warnings.map((w) => [w.code, w.count]))).toEqual({ CRT_TARGET_UNKNOWN: 1, CRT_SOURCE_UNKNOWN: 1, CRT_QUERY_UNSUPPORTED: 1 });
    expect(bad.skipped.map((s) => s.line)).toEqual([1, 2, 3]);

    const full = (await caller(setter).mapImport.exportCrt({ documentHash: docA, includeMatches: true })).crt;
    const round = await caller(setter).mapImport.importCrt({ documentHash: docA, crt: full.replace("# keep 702.0\n", "") });
    expect(round).toMatchObject({ decisions: [], applied: 0, job: null, skipped: [] });
    expect(round.unchanged).toHaveLength(4);
    expect(await ctx.db.clubSymbolDecision.findMany({ where: { fingerprint: { in: fps.filter((f): f is string => f !== null) } }, orderBy: { fingerprint: "asc" } })).toEqual(before);
  }, 30_000);

  it("is gated as decide: courses.edit, never the kiosk key; size-limited", async () => {
    await expect(caller(stranger).mapImport.importCrt({ documentHash: docA, crt: "703 702.0\n" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(null).mapImport.importCrt({ documentHash: docA, crt: "703 702.0\n" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const kiosk = makeCaller(ctx.event, { user: stranger, authEnabled: true, authMode: "proxy", kioskKey: `k-${suffix}` });
    await expect(kiosk.mapImport.importCrt({ documentHash: docA, crt: "703 702.0\n" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(makeCaller(ctx.event).mapImport.importCrt({ documentHash: "f".repeat(64), crt: "703 702.0\n" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(makeCaller(ctx.event).mapImport.importCrt({ documentHash: docA, crt: "#".repeat(1024 * 1024 + 1) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await ctx.db.clubSymbolDecision.findUniqueOrThrow({ where: { fingerprint_libraryVersion: { fingerprint: fps[ring]!, libraryVersion: V } } })).canonicalId).toBeNull();
  });
});
