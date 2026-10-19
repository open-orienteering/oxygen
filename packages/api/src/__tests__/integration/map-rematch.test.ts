/**
 * Re-match pass (docs/map-storage.md §6.9): pins of documents stored under
 * an older importer / library release (`ocad-3` / `none`) are re-imported
 * and moved, club editions also when the club decisions changed, events
 * not then (copy-on-use); dry run writes nothing; a second run is empty.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { createHash, randomBytes } from "crypto";
import { mapDocument, mapImport, symbolLibrary } from "@oxygen/shared";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";
import { applyEventMap } from "../../event-map.js";
import { startImportJob } from "../../map-store/jobs.js";
import { getBlob } from "../../map-store/blob-store.js";
import { planRematch, runRematch } from "../../map-store/rematch.js";

const FIXTURE = resolve(__dirname, "../../../../../e2e/test.ocd");
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

let ctx: TestEventContext;
let fixture: Buffer;
let sourceHash: string;
let currentDoc: string;
let staleDoc: string;
let clubMapId: string;
let versionId: string;
let ringFp: string;
const suffix = randomBytes(3).toString("hex");

const mine = async (opts: Parameters<typeof planRematch>[1] = {}) => (await planRematch(ctx.db, opts)).filter((i) => i.sourceHash === sourceHash);
const eventPin = async () => (await ctx.db.mapFile.findFirstOrThrow({ where: { eventId: ctx.eventId }, select: { documentHash: true } })).documentHash;
const versionPin = async () => (await ctx.db.clubMapVersion.findUniqueOrThrow({ where: { id: versionId }, select: { documentHash: true } })).documentHash;

beforeAll(async () => {
  ctx = await createTestEvent("map_rematch");
  fixture = Buffer.concat([readFileSync(FIXTURE), Buffer.from(`map-rematch-${suffix}`)]);
  sourceHash = sha256(fixture);
  const applied = await applyEventMap(ctx.db, ctx.eventId, "test.ocd", fixture, {});
  currentDoc = applied.documentHash!;
  const club = await ctx.db.clubMap.create({ data: { name: `rematch-${suffix}` } });
  clubMapId = club.id;
  await startImportJob(ctx.db, { sourceHash, clubMapId });
  versionId = (await ctx.db.clubMapVersion.findFirstOrThrow({ where: { clubMapId }, select: { id: true } })).id;

  // A pre-matcher document row of the same source, as rows written before stages 6–7 look (map-storage.md §3).
  const bytes = Buffer.from(`pre-matcher-${suffix}`);
  staleDoc = sha256(bytes);
  await ctx.db.mapDocument.create({
    data: { hash: staleDoc, bytes, sizeBytes: bytes.byteLength, formatVersion: 1, importerVersion: "ocad-3", libraryVersion: "none", sourceHash, header: {}, report: {} },
  });
  await ctx.db.mapFile.updateMany({ where: { eventId: ctx.eventId }, data: { documentHash: staleDoc } });
  await ctx.db.clubMapVersion.update({ where: { id: versionId }, data: { documentHash: staleDoc } });

  const header = mapDocument.readMapDocumentHeader((await getBlob(ctx.db, "map_documents", currentDoc))!).header;
  ringFp = mapImport.documentSymbolFingerprints(header)[header.symbols.findIndex((s) => s.code === "702.0")]!;
  await ctx.db.clubSymbolDecision.deleteMany({ where: { fingerprint: ringFp } });
}, 90_000);

afterAll(async () => {
  await ctx.db.clubSymbolDecision.deleteMany({ where: { fingerprint: ringFp } });
  await ctx.cleanup();
  await ctx.db.clubMap.deleteMany({ where: { name: { contains: suffix } } });
  await ctx.db.mapImportJob.deleteMany({ where: { sourceHash } });
  await ctx.db.mapDocument.deleteMany({ where: { sourceHash } });
  await ctx.db.mapSource.deleteMany({ where: { fileHash: sourceHash } });
  await disconnect();
}, 30_000);

describe("planRematch / runRematch", () => {
  it("plans the club edition and the event pin of a pre-matcher document", async () => {
    const items = await mine();
    expect(items).toEqual([
      expect.objectContaining({ kind: "club", id: versionId, documentHash: staleDoc, reason: "importer" }),
      expect.objectContaining({ kind: "event", id: String(ctx.eventId), documentHash: staleDoc, reason: "importer" }),
    ]);
    expect(await mine({ eventId: ctx.eventId })).toEqual([expect.objectContaining({ kind: "event" })]);
  });

  it("writes nothing on a dry run", async () => {
    const jobs = await ctx.db.mapImportJob.count({ where: { sourceHash } });
    const run = await runRematch(ctx.db, { eventId: ctx.eventId, dryRun: true });
    expect(run).toMatchObject({ dryRun: true, processed: 0 });
    expect(await ctx.db.mapImportJob.count({ where: { sourceHash } })).toBe(jobs);
    expect(await eventPin()).toBe(staleDoc);
  });

  it("moves both pins to the current document, and a second run finds nothing", async () => {
    const run = await runRematch(ctx.db, { itemTimeoutMs: 60_000 });
    expect(run.failures.filter((f) => f.sourceHash === sourceHash)).toEqual([]);
    expect(await eventPin()).toBe(currentDoc);
    expect(await versionPin()).toBe(currentDoc);
    expect(await mine()).toEqual([]);
  }, 120_000);

  it("re-matches a club edition when the club decisions change, but leaves the event's pin (copy-on-use)", async () => {
    await ctx.db.clubSymbolDecision.create({ data: { fingerprint: ringFp, libraryVersion: `ISOM2017-2@${symbolLibrary.SYMBOL_LIBRARY_VERSION}`, canonicalId: "ISOM2017-2:703" } });
    expect(await mine()).toEqual([expect.objectContaining({ kind: "club", id: versionId, documentHash: currentDoc, reason: "decisions" })]);
    await runRematch(ctx.db, { itemTimeoutMs: 60_000 });
    const moved = await versionPin();
    expect(moved).not.toBe(currentDoc);
    const doc = await ctx.db.mapDocument.findUniqueOrThrow({ where: { hash: moved }, select: { report: true } });
    expect(doc.report).toMatchObject({ matching: { byMethod: { explicit: 1 } } });
    expect(await eventPin()).toBe(currentDoc);
    expect(await mine()).toEqual([]);
  }, 120_000);
});
