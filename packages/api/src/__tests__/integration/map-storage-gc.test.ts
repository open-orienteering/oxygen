/**
 * Storage garbage collector (docs/map-storage.md §8): what is collectable,
 * the touch pass, per-row re-checks, dry run, interruption, the daily
 * schedule in `settings`, and the admin entry point.
 *
 * Rows are synthetic (random hashes, junk bytes) — the collector looks at
 * references and timestamps, never at content — and aged by hand. The test
 * database is shared with other suites, so assertions only ever name this
 * suite's hashes.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "crypto";
import { inspect } from "node:util";
import { TRPCError } from "@trpc/server";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { deleteBlob } from "../../map-store/blob-store.js";
import {
  GC_SETTINGS,
  _resetStorageGcSchedule,
  currentStorageGc,
  isForeignKeyViolation,
  maybeStartStorageGc,
  runStorageGc,
  stopStorageGc,
} from "../../map-store/gc.js";
import { getSetting, setSetting } from "../../db.js";
import type { AuthUser } from "../../auth.js";

const suffix = randomBytes(4).toString("hex");
const EMAIL_DOMAIN = `@map-gc-${suffix}.example`;
const DAY = 86_400_000;
const hex = () => randomBytes(32).toString("hex");

let ctx: TestEventContext;
let admin: AuthUser;
let stranger: AuthUser;
const sources = new Set<string>();
const documents = new Set<string>();
const savedSettings = new Map<string, string | null>();

async function source(ageDays = 0): Promise<string> {
  const fileHash = hex();
  sources.add(fileHash);
  const bytes = randomBytes(64);
  await ctx.db.mapSource.create({
    data: { fileHash, kind: "ocad", bytes, sizeBytes: bytes.byteLength, fileName: `gc-${suffix}.ocd`, createdAt: new Date(Date.now() - ageDays * DAY) },
  });
  return fileHash;
}

async function document(sourceHash: string, lastReferencedDaysAgo = 0): Promise<string> {
  const hash = hex();
  documents.add(hash);
  const bytes = randomBytes(64);
  const at = new Date(Date.now() - lastReferencedDaysAgo * DAY);
  await ctx.db.mapDocument.create({
    data: {
      hash, bytes, sizeBytes: bytes.byteLength, formatVersion: 1, importerVersion: "test", libraryVersion: "none",
      sourceHash, header: {}, report: {}, createdAt: at, lastReferencedAt: at,
    },
  });
  return hash;
}

/** An old document over an old source, nothing pointing at either. */
async function orphanPair(days = 40): Promise<{ src: string; doc: string }> {
  const src = await source(days);
  return { src, doc: await document(src, days) };
}

const docExists = async (hash: string) => (await ctx.db.mapDocument.count({ where: { hash } })) === 1;
const srcExists = async (fileHash: string) => (await ctx.db.mapSource.count({ where: { fileHash } })) === 1;

beforeAll(async () => {
  ctx = await createTestEvent("map_storage_gc");
  admin = await ctx.db.user.create({ data: { email: `admin${EMAIL_DOMAIN}`, displayName: "admin", isAdmin: true, active: true } });
  stranger = await ctx.db.user.create({ data: { email: `stranger${EMAIL_DOMAIN}`, displayName: "stranger", active: true } });
  for (const key of Object.values(GC_SETTINGS)) savedSettings.set(key, await getSetting(key));
});

afterAll(async () => {
  for (const [key, value] of savedSettings) await setSetting(key, value);
  await ctx.cleanup();
  await ctx.db.clubMap.deleteMany({ where: { name: { endsWith: suffix } } });
  await ctx.db.mapImportJob.deleteMany({ where: { sourceHash: { in: [...sources] } } });
  await ctx.db.mapUpload.deleteMany({ where: { fileName: `gc-${suffix}.ocd` } });
  await ctx.db.mapDocument.deleteMany({ where: { hash: { in: [...documents] } } });
  await ctx.db.mapSource.deleteMany({ where: { fileHash: { in: [...sources] } } });
  await ctx.db.user.deleteMany({ where: { email: { endsWith: EMAIL_DOMAIN } } });
  await disconnect();
}, 30_000);

describe("runStorageGc", () => {
  it("deletes an old unreferenced document with its previews, then its source, and logs both hashes", async () => {
    const { src, doc } = await orphanPair();
    await ctx.db.mapPreview.create({ data: { documentHash: doc, kind: "thumbnail", png: randomBytes(8) } });
    const result = await runStorageGc(ctx.db);
    expect(result.dryRun).toBe(false);
    expect(result.graceDays).toBe(30);
    expect(result.documents).toContain(doc);
    expect(result.sources).toContain(src);
    expect(await docExists(doc)).toBe(false);
    expect(await srcExists(src)).toBe(false);
    expect(await ctx.db.mapPreview.count({ where: { documentHash: doc } })).toBe(0);
  });

  it("keeps young unreferenced rows: documents by last_referenced_at, sources by created_at", async () => {
    const youngSrc = await source(5);
    const youngDoc = await document(await source(40), 5);
    const result = await runStorageGc(ctx.db);
    expect(result.documents).not.toContain(youngDoc);
    expect(result.sources).not.toContain(youngSrc);
    expect(await docExists(youngDoc)).toBe(true);
    expect(await srcExists(youngSrc)).toBe(true);
  });

  it("honours the grace passed in", async () => {
    const { src, doc } = await orphanPair(10);
    expect((await runStorageGc(ctx.db, { graceDays: 30 })).documents).not.toContain(doc);
    const short = await runStorageGc(ctx.db, { graceDays: 7 });
    expect(short.documents).toContain(doc);
    expect(short.sources).toContain(src);
  });

  it("keeps an old document referenced by an event pin and touches it, so the grace restarts", async () => {
    const { src, doc } = await orphanPair();
    await ctx.db.mapFile.create({ data: { eventId: ctx.eventId, fileName: "pinned.ocd", fileData: randomBytes(4), sourceHash: src, documentHash: doc } });
    const result = await runStorageGc(ctx.db);
    expect(result.documents).not.toContain(doc);
    expect(result.sources).not.toContain(src);
    expect(result.touched).toBeGreaterThanOrEqual(1);
    const row = await ctx.db.mapDocument.findUniqueOrThrow({ where: { hash: doc }, select: { lastReferencedAt: true } });
    expect(Date.now() - row.lastReferencedAt.getTime()).toBeLessThan(60_000);

    // Dereference (event map replaced): the document now waits out a fresh grace instead of going at once.
    await ctx.db.mapFile.deleteMany({ where: { eventId: ctx.eventId } });
    const after = await runStorageGc(ctx.db);
    expect(after.documents).not.toContain(doc);
    expect(await docExists(doc)).toBe(true);
    // …and goes once the grace has run out since that last touch.
    await ctx.db.mapDocument.update({ where: { hash: doc }, data: { lastReferencedAt: new Date(Date.now() - 31 * DAY) } });
    expect((await runStorageGc(ctx.db)).documents).toContain(doc);
  });

  it("keeps an old document referenced by a club map version", async () => {
    const { src, doc } = await orphanPair();
    const clubMap = await ctx.db.clubMap.create({ data: { name: `GC club ${suffix}` } });
    await ctx.db.clubMapVersion.create({ data: { clubMapId: clubMap.id, seq: 1, sourceHash: src, documentHash: doc } });
    const result = await runStorageGc(ctx.db);
    expect(result.documents).not.toContain(doc);
    expect(result.sources).not.toContain(src);
    expect(await docExists(doc)).toBe(true);
  });

  it("keeps an old document referenced only by a job (SET NULL, so NOT EXISTS is the only guard) and leaves the job intact", async () => {
    const { src, doc } = await orphanPair();
    const job = await ctx.db.mapImportJob.create({ data: { sourceHash: src, state: "done", documentHash: doc } });
    const result = await runStorageGc(ctx.db);
    expect(result.documents).not.toContain(doc);
    expect((await ctx.db.mapImportJob.findUniqueOrThrow({ where: { id: job.id } })).documentHash).toBe(doc);
  });

  it("keeps an old source referenced only by a queued job (CASCADE, so deleting it would delete the job)", async () => {
    const src = await source(40);
    const job = await ctx.db.mapImportJob.create({ data: { sourceHash: src, state: "queued" } });
    const result = await runStorageGc(ctx.db);
    expect(result.sources).not.toContain(src);
    expect(await srcExists(src)).toBe(true);
    expect(await ctx.db.mapImportJob.count({ where: { id: job.id } })).toBe(1);
    await ctx.db.mapImportJob.delete({ where: { id: job.id } });
  });

  it("does not count a finalised upload as a reference to its source", async () => {
    const src = await source(40);
    const upload = await ctx.db.mapUpload.create({ data: { fileName: `gc-${suffix}.ocd`, declaredBytes: 64, chunkBytes: 64, finalisedHash: src } });
    const result = await runStorageGc(ctx.db);
    expect(result.sources).toContain(src);
    expect((await ctx.db.mapUpload.findUniqueOrThrow({ where: { id: upload.id } })).finalisedHash).toBeNull();
  });

  it("is idempotent: a second run finds nothing of what the first deleted", async () => {
    const { src, doc } = await orphanPair();
    const first = await runStorageGc(ctx.db);
    expect(first.documents).toContain(doc);
    const second = await runStorageGc(ctx.db);
    expect(second.documents).not.toContain(doc);
    expect(second.sources).not.toContain(src);
  });

  it("a dry run lists what would go — the source as if its document were gone — and changes nothing", async () => {
    const { src, doc } = await orphanPair();
    const pinned = await orphanPair();
    await ctx.db.mapFile.create({ data: { eventId: ctx.eventId, fileName: "dry.ocd", fileData: randomBytes(4), sourceHash: pinned.src, documentHash: pinned.doc } });
    const before = await ctx.db.mapDocument.findUniqueOrThrow({ where: { hash: pinned.doc }, select: { lastReferencedAt: true } });
    const dry = await runStorageGc(ctx.db, { dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, touched: 0, uploads: 0, jobs: 0 });
    expect(dry.documents).toContain(doc);
    expect(dry.sources).toContain(src);
    expect(dry.documents).not.toContain(pinned.doc);
    expect(await docExists(doc)).toBe(true);
    expect(await srcExists(src)).toBe(true);
    const after = await ctx.db.mapDocument.findUniqueOrThrow({ where: { hash: pinned.doc }, select: { lastReferencedAt: true } });
    expect(after.lastReferencedAt.getTime()).toBe(before.lastReferencedAt.getTime());
    await ctx.db.mapFile.deleteMany({ where: { eventId: ctx.eventId } });
  });

  it("skips candidates that gain a reference or a touch after selection, and carries on with the rest", async () => {
    const pinned = await orphanPair();
    const touched = await orphanPair();
    const doomed = await orphanPair();
    let first = true;
    const result = await runStorageGc(ctx.db, {
      // Called before every delete — the first call comes after the candidate query saw all three unreferenced.
      shouldStop: async () => {
        if (first) {
          first = false;
          await ctx.db.mapImportJob.create({ data: { sourceHash: pinned.src, state: "done", documentHash: pinned.doc } });
          await ctx.db.mapDocument.update({ where: { hash: touched.doc }, data: { lastReferencedAt: new Date() } });
        }
        return false;
      },
    });
    expect(result.documents).toContain(doomed.doc);
    expect(result.documents).not.toContain(pinned.doc);
    expect(result.documents).not.toContain(touched.doc);
    expect(result.skipped).toBeGreaterThanOrEqual(2);
    expect(await docExists(pinned.doc)).toBe(true);
    expect(await docExists(touched.doc)).toBe(true);
    // Their sources stay: each still has its document (and one a job).
    expect(result.sources).not.toContain(pinned.src);
    expect(result.sources).not.toContain(touched.src);
    expect(result.sources).toContain(doomed.src);
  });

  it("stops between rows when asked, leaving every row either deleted or untouched", async () => {
    // Older than anything else here, so these two come first; the stop condition does not rely on it.
    const a = await orphanPair(400);
    const b = await orphanPair(400);
    const result = await runStorageGc(ctx.db, { shouldStop: async () => !((await docExists(a.doc)) && (await docExists(b.doc))) });
    expect(result.stopped).toBe(true);
    expect([await docExists(a.doc), await docExists(b.doc)].filter(Boolean)).toHaveLength(1);
    expect(result.sources).not.toContain(a.src);
    expect(result.sources).not.toContain(b.src);
    // The next run finishes the job.
    const next = await runStorageGc(ctx.db);
    expect(await docExists(a.doc)).toBe(false);
    expect(await docExists(b.doc)).toBe(false);
    expect(next.sources).toEqual(expect.arrayContaining([a.src, b.src]));
  });

  it("recognises the real RESTRICT violation Postgres raises for a referenced blob", async () => {
    const { src, doc } = await orphanPair();
    const clubMap = await ctx.db.clubMap.create({ data: { name: `GC restrict ${suffix}` } });
    await ctx.db.clubMapVersion.create({ data: { clubMapId: clubMap.id, seq: 1, sourceHash: src, documentHash: doc } });
    const err = await deleteBlob(ctx.db, "map_documents", doc).then(() => null, (e: unknown) => e);
    expect(err).not.toBeNull();
    expect(isForeignKeyViolation(err), inspect(err, { depth: 6 })).toBe(true);
  });

  it("runs the upload and job housekeeping as its last pass", async () => {
    const src = await source(0);
    const old = await ctx.db.mapUpload.create({ data: { fileName: `gc-${suffix}.ocd`, declaredBytes: 1, chunkBytes: 1, createdAt: new Date(Date.now() - 2 * DAY) } });
    const oldJob = await ctx.db.mapImportJob.create({ data: { sourceHash: src, state: "failed" } });
    await ctx.db.$executeRaw`UPDATE oxygen.map_import_jobs SET updated_at = now() - interval '8 days' WHERE id = ${oldJob.id}::uuid`;
    const result = await runStorageGc(ctx.db);
    expect(result.uploads).toBeGreaterThanOrEqual(1);
    expect(result.jobs).toBeGreaterThanOrEqual(1);
    expect(await ctx.db.mapUpload.count({ where: { id: old.id } })).toBe(0);
    expect(await ctx.db.mapImportJob.count({ where: { id: oldJob.id } })).toBe(0);
  });
});

describe("daily schedule (maybeStartStorageGc)", () => {
  beforeEach(async () => {
    _resetStorageGcSchedule();
    await setSetting(GC_SETTINGS.startedAt, null);
    await setSetting(GC_SETTINGS.finishedAt, null);
    await setSetting(GC_SETTINGS.lastResult, null);
    await setSetting(GC_SETTINGS.graceDays, null);
  });

  it("runs when it never ran, records start, finish and a count summary, then is not due for a day", async () => {
    const { doc } = await orphanPair();
    expect(await maybeStartStorageGc()).toBe(true);
    expect(await getSetting(GC_SETTINGS.startedAt)).not.toBeNull();
    const result = await currentStorageGc();
    expect(result?.documents).toContain(doc);
    expect(await getSetting(GC_SETTINGS.finishedAt)).not.toBeNull();
    const summary = JSON.parse((await getSetting(GC_SETTINGS.lastResult))!) as Record<string, unknown>;
    expect(summary).toMatchObject({ graceDays: 30, stopped: false });
    expect(summary.documents).toBeGreaterThanOrEqual(1);
    expect(summary).not.toHaveProperty("hashes");

    // Same instance within 15 minutes: no settings read at all. After that: read, not due.
    expect(await maybeStartStorageGc()).toBe(false);
    _resetStorageGcSchedule();
    expect(await maybeStartStorageGc()).toBe(false);
    // A day later it is due again.
    _resetStorageGcSchedule();
    expect(await maybeStartStorageGc(new Date(Date.now() + 25 * 3_600_000))).toBe(true);
    await currentStorageGc();
  });

  it("a run stopped by losing the lease stores its result and clears started_at, so the next leader is due at once", async () => {
    await orphanPair();
    expect(await maybeStartStorageGc()).toBe(true);
    stopStorageGc(); // what stopAll does on losing the lease; checked before the first delete
    const result = await currentStorageGc();
    expect(result?.stopped).toBe(true);
    expect(await getSetting(GC_SETTINGS.startedAt)).toBeNull();
    expect(await getSetting(GC_SETTINGS.finishedAt)).toBeNull();
    expect(JSON.parse((await getSetting(GC_SETTINGS.lastResult))!)).toMatchObject({ stopped: true });
    _resetStorageGcSchedule();
    expect(await maybeStartStorageGc()).toBe(true);
    expect((await currentStorageGc())?.stopped).toBe(false);
  });

  it("does not start while another instance's run started under an hour ago", async () => {
    await setSetting(GC_SETTINGS.startedAt, new Date(Date.now() - 10 * 60_000).toISOString());
    expect(await maybeStartStorageGc()).toBe(false);
    expect(currentStorageGc()).toBeNull();
  });

  it("uses the grace override from settings", async () => {
    const { doc } = await orphanPair(10);
    await setSetting(GC_SETTINGS.graceDays, "7");
    expect(await maybeStartStorageGc()).toBe(true);
    const result = await currentStorageGc();
    expect(result?.graceDays).toBe(7);
    expect(result?.documents).toContain(doc);
  });
});

describe("mapStorage.gcRun", () => {
  it("is admin-only and returns the run summary; a dry run deletes nothing", async () => {
    const { src, doc } = await orphanPair();
    await expect(makeCaller(null, { user: stranger, authEnabled: true, authMode: "proxy" }).mapStorage.gcRun({ dryRun: true })).rejects.toBeInstanceOf(TRPCError);
    const asAdmin = makeCaller(null, { user: admin, authEnabled: true, authMode: "proxy" });
    const dry = await asAdmin.mapStorage.gcRun({ dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.documents).toContain(doc);
    expect(dry.sources).toContain(src);
    expect(await docExists(doc)).toBe(true);
    const real = await asAdmin.mapStorage.gcRun();
    expect(real.documents).toContain(doc);
    expect(await docExists(doc)).toBe(false);
  });
});
