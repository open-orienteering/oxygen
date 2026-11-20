/**
 * Re-match pass (docs/map-storage.md §6.9): pins of documents stored under
 * an older importer / library release (`ocad-3` / `none`) are re-imported
 * and moved, club editions also when the club decisions changed, events
 * not then (copy-on-use); a live event's sourced row without a document
 * is imported; dry run writes nothing; a second run is empty.
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
import { importMapToDocument } from "../../import/ocad.js";

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

  it("imports a live event's sourced row that has no document, and leaves a soft-deleted event's alone (E5)", async () => {
    const live = await createTestEvent("map_rematch_unpinned");
    const removed = await createTestEvent("map_rematch_removed");
    try {
      for (const e of [live, removed]) await ctx.db.mapFile.create({ data: { eventId: e.eventId, fileName: "unpinned.ocd", sourceHash } });
      await ctx.db.event.update({ where: { id: removed.eventId }, data: { removed: true } });
      expect(await mine()).toEqual([
        expect.objectContaining({ kind: "event", id: String(live.eventId), documentHash: null, reason: "unpinned" }),
      ]);
      const run = await runRematch(ctx.db, { eventId: live.eventId });
      expect(run).toMatchObject({ total: 1, done: 1, failed: 0 });
      const pinned = await ctx.db.mapFile.findFirstOrThrow({ where: { eventId: live.eventId }, select: { documentHash: true, scale: true } });
      expect(pinned.documentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(pinned.scale).toBeGreaterThan(0);
      expect(await mine()).toEqual([]);
      expect((await ctx.db.mapFile.findFirstOrThrow({ where: { eventId: removed.eventId }, select: { documentHash: true } })).documentHash).toBeNull();
    } finally {
      await live.cleanup();
      await removed.cleanup();
    }
  }, 60_000);
});

describe("the release re-match moves a source-order pin onto the IOF colour layers (row I5)", () => {
  it("re-imports an ocad-18 document in the iof order; its patch keeps every op and re-materialises its symbol", async () => {
    const ev = await createTestEvent("map_rematch_layers");
    // The same file as ocad-18 drew it: the source order (§9.2), stored under the old importer.
    const old = await importMapToDocument(fixture, "test.ocd", "ocad", { importer: "ocad-18", match: { decisions: [], colourOrder: "source" } });
    const oldDoc = mapDocument.decodeMapDocument(old.bytes);
    expect(oldDoc.header.colourOrder).toEqual({ order: "source" });
    const sym = mapDocument.materialiseSymbol(oldDoc, "ISOM2017-2:204");
    if (!sym.ok) throw new Error("fixture");
    const target = oldDoc.attrs.sourceIndex[0];
    const ADD = "019a7d2e-0000-7000-8000-0000000000cc";
    const ops = {
      [`hide:${target}`]: { op: "hide", sourceIndex: target },
      [`add:${ADD}`]: { op: "add", id: ADD, type: mapDocument.OBJECT_TYPE.point, symbol: { patch: sym.key }, coords: [[1000, 1000]] },
    };
    const patchRow = () => ctx.db.mapPatch.findUniqueOrThrow({ where: { eventId: ev.eventId } });
    try {
      await ctx.db.mapDocument.createMany({
        data: [{ hash: old.documentHash, bytes: Uint8Array.from(old.bytes), sizeBytes: old.bytes.byteLength, formatVersion: 1, importerVersion: "ocad-18", libraryVersion: old.libraryVersion, sourceHash, header: {}, report: {} }],
        skipDuplicates: true,
      });
      await ctx.db.mapFile.create({ data: { eventId: ev.eventId, fileName: "test.ocd", sourceHash, documentHash: old.documentHash } });
      await ctx.db.mapPatch.create({ data: { eventId: ev.eventId, documentHash: old.documentHash, ops, symbols: { [sym.key]: sym.symbol }, version: 3n } });
      expect(await mine({ eventId: ev.eventId })).toEqual([expect.objectContaining({ kind: "event", documentHash: old.documentHash, reason: "importer" })]);

      const run = await runRematch(ctx.db, { eventId: ev.eventId, itemTimeoutMs: 60_000 });
      expect(run.failures).toEqual([]);
      const pin = (await ctx.db.mapFile.findFirstOrThrow({ where: { eventId: ev.eventId } })).documentHash!;
      expect(pin).not.toBe(old.documentHash);
      const now = mapDocument.decodeMapDocument((await getBlob(ctx.db, "map_documents", pin))!);
      expect(now.header.format.importer).toBe(mapImport.OCAD_IMPORTER_VERSION);
      expect(now.header.colourOrder?.order).toBe("iof");
      const rekeyed = await patchRow();
      expect(rekeyed).toMatchObject({ documentHash: pin, ops, unresolved: {} });
      const again = mapDocument.materialiseSymbol(now, sym.key);
      if (!again.ok) throw new Error("not materialisable on the layers");
      expect(rekeyed.symbols).toEqual({ [sym.key]: JSON.parse(JSON.stringify(again.symbol)) });
    } finally {
      await ev.cleanup();
    }
  }, 120_000);
});

describe("the event's map patch follows the re-match (docs/map-patches.md §4.4, G11)", () => {
  it("a re-match keeps a hide on the re-imported document; a dry run leaves the row; the sweep wakes a row left dormant", async () => {
    const ev = await createTestEvent("map_rematch_patch");
    // A stale copy of the current document: its bytes under another hash, stored as a pre-matcher import (the blob read does not check the hash).
    const bytes = (await getBlob(ctx.db, "map_documents", currentDoc))!;
    const stale = randomBytes(32).toString("hex");
    const target = mapDocument.decodeMapDocument(bytes).attrs.sourceIndex[0];
    const op = { op: "hide", sourceIndex: target };
    const patchRow = () => ctx.db.mapPatch.findUniqueOrThrow({ where: { eventId: ev.eventId } });
    try {
      await ctx.db.mapDocument.create({
        data: { hash: stale, bytes, sizeBytes: bytes.byteLength, formatVersion: 1, importerVersion: "ocad-3", libraryVersion: "none", sourceHash, header: {}, report: {} },
      });
      await ctx.db.mapFile.create({ data: { eventId: ev.eventId, fileName: "test.ocd", sourceHash, documentHash: stale } });
      await ctx.db.mapPatch.create({ data: { eventId: ev.eventId, documentHash: stale, ops: { [`hide:${target}`]: op }, version: 7n } });

      const dry = await runRematch(ctx.db, { eventId: ev.eventId, dryRun: true });
      expect(dry).toMatchObject({ total: 1, processed: 0 });
      expect((await patchRow()).documentHash).toBe(stale);

      const run = await runRematch(ctx.db, { eventId: ev.eventId, itemTimeoutMs: 60_000 });
      expect(run.failures).toEqual([]);
      // The source imported now (with the club decisions an earlier case wrote, so not necessarily `currentDoc`).
      const pin = (await ctx.db.mapFile.findFirstOrThrow({ where: { eventId: ev.eventId } })).documentHash!;
      expect(pin).not.toBe(stale);
      const rekeyed = await patchRow();
      expect(rekeyed).toMatchObject({ documentHash: pin, ops: { [`hide:${target}`]: op }, unresolved: {} });
      expect(rekeyed.version).not.toBe(7n);

      // Left dormant (a hook that failed): the sweep re-keys it.
      await ctx.db.mapPatch.update({ where: { eventId: ev.eventId }, data: { documentHash: stale } });
      let planned: unknown[] = [];
      await runRematch(ctx.db, { eventId: ev.eventId, dryRun: true, onPlan: (items) => { planned = items; } });
      expect(planned).toEqual([expect.objectContaining({ kind: "patch", id: String(ev.eventId), documentHash: stale, reason: "patch" })]);
      const swept = await runRematch(ctx.db, { eventId: ev.eventId });
      expect(swept).toMatchObject({ total: 1, done: 1, failed: 0 });
      expect(await patchRow()).toMatchObject({ documentHash: pin, ops: { [`hide:${target}`]: op } });
      expect((await runRematch(ctx.db, { eventId: ev.eventId })).total).toBe(0);
    } finally {
      await ev.cleanup();
      await ctx.db.mapDocument.deleteMany({ where: { hash: stale } });
    }
  }, 120_000);
});
