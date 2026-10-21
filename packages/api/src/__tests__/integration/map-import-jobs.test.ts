/**
 * Integration matrix for the import job model and the chunked upload
 * route (docs/map-storage.md §5–§6): jobs started by `applyEventMap` and
 * `clubMap.upload`, dedup against an existing document, failure and
 * stale-claim handling, the status poll as engine, the three upload
 * routes with their status codes, and the tRPC procedures that turn a
 * finalised source into an event or club map.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { createHash, randomBytes } from "crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { SYSTEM_GROUP_IDS } from "@oxygen/shared";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { grantSystemGroup } from "../../permissions.js";
import { applyEventMap, parseOcadMapMetadata } from "../../event-map.js";
import { documentFrameSchema, mapFileMetadataFor } from "../../map-store/map-file-metadata.js";
import { Prisma } from "../../generated/prisma/client.js";
import {
  applyJobResult,
  getImportJob,
  INSTANCE_ID,
  kickImportJobs,
  startImportJob,
  sweepImportHousekeeping,
  type ImportJobRow,
} from "../../map-store/jobs.js";
import { registerMapUploadRoutes } from "../../map-store/upload-routes.js";
import { resetDocumentAccessCache } from "../../map-store/routes.js";
import { MAX_UPLOAD_BYTES } from "../../map-store/uploads.js";
import { planBackfill } from "../../map-store/backfill.js";
import type { AuthUser } from "../../auth.js";

const FIXTURE = resolve(__dirname, "../../../../../e2e/test.ocd");
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

let ctx: TestEventContext;
let server: FastifyInstance;
let fixture: Buffer;
let fixtureHash: string;
let documentHash: string;
let admin: AuthUser;
let setter: AuthUser;
let stranger: AuthUser;
let previousAuthMode: string | undefined;
const suffix = randomBytes(3).toString("hex");
const EMAIL_DOMAIN = `@map-jobs-${suffix}.example`;
const createdSourceHashes = new Set<string>();

async function mkUser(name: string, isAdmin = false): Promise<AuthUser> {
  return ctx.db.user.create({ data: { email: `${name}${EMAIL_DOMAIN}`, displayName: name, isAdmin, active: true } });
}
const as = (u: AuthUser | null, extra: Record<string, string> = {}) => ({ ...(u ? { "x-forwarded-email": u.email } : {}), ...extra });
const eventHeaders = (u: AuthUser | null) => as(u, { "x-event-id": ctx.nameId });

async function waitForTerminal(id: string, ms = 20_000): Promise<ImportJobRow> {
  const until = Date.now() + ms;
  for (;;) {
    const row = await getImportJob(ctx.db, id);
    if (row && (row.state === "done" || row.state === "failed")) return row;
    if (Date.now() > until) throw new Error(`job ${id} still ${row?.state} after ${ms} ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** A source row of bytes the importer cannot read; the job must fail cleanly. */
async function garbageSource(kind: "ocad" | "omap" = "ocad"): Promise<string> {
  const bytes = Buffer.concat([Buffer.from([0xad, 0x0c]), randomBytes(64)]);
  const fileHash = sha256(bytes);
  await ctx.db.mapSource.create({ data: { fileHash, kind, bytes, sizeBytes: bytes.byteLength, fileName: `garbage-${fileHash.slice(0, 6)}.ocd` } });
  createdSourceHashes.add(fileHash);
  return fileHash;
}

beforeAll(async () => {
  ctx = await createTestEvent("map_jobs");
  // Sources and documents are content-addressed and global, so a suite
  // sharing the exact fixture bytes with another would share (and fight
  // over) their rows. The OCAD reader ignores trailing bytes: a per-run
  // trailer gives this suite its own hashes without changing the map.
  fixture = Buffer.concat([readFileSync(FIXTURE), Buffer.from(`map-jobs-${suffix}`)]);
  fixtureHash = sha256(fixture);
  createdSourceHashes.add(fixtureHash);
  admin = await mkUser("admin", true);
  setter = await mkUser("setter");
  stranger = await mkUser("stranger");
  await grantSystemGroup(ctx.db, { eventId: ctx.eventId, userId: setter.id, groupId: SYSTEM_GROUP_IDS.courseSetter, grantedBy: admin.id });
  await ctx.db.event.update({ where: { id: ctx.eventId }, data: { date: new Date("2099-06-01T00:00:00Z") } });
  ctx.event.date = new Date("2099-06-01T00:00:00Z");

  server = Fastify({ logger: false });
  registerMapUploadRoutes(server);
  await server.ready();
  previousAuthMode = process.env.AUTH_MODE;
  process.env.AUTH_MODE = "proxy";
  resetDocumentAccessCache();
}, 60_000);

afterAll(async () => {
  if (previousAuthMode === undefined) delete process.env.AUTH_MODE;
  else process.env.AUTH_MODE = previousAuthMode;
  await server?.close();
  await ctx.cleanup();
  await ctx.db.clubMapFile.deleteMany({ where: { name: { contains: suffix } } });
  await ctx.db.clubMap.deleteMany({ where: { name: { contains: suffix } } });
  await ctx.db.mapImportJob.deleteMany({ where: { sourceHash: { in: [...createdSourceHashes] } } });
  await ctx.db.mapUpload.deleteMany({ where: { OR: [{ finalisedHash: { in: [...createdSourceHashes] } }, { uploadedBy: { in: [admin.id, setter.id, stranger.id] } }] } });
  await ctx.db.mapDocument.deleteMany({ where: { sourceHash: { in: [...createdSourceHashes] } } });
  await ctx.db.mapSource.deleteMany({ where: { fileHash: { in: [...createdSourceHashes] } } });
  await ctx.db.user.deleteMany({ where: { email: { endsWith: EMAIL_DOMAIN } } });
  await disconnect();
}, 30_000);

describe("import jobs from applyEventMap", () => {
  it("runs the import as a job that finishes inside the hold, pins the document and persists the report", async () => {
    const applied = await applyEventMap(ctx.db, ctx.eventId, "test.ocd", fixture, { uploadedBy: setter.id, startedBy: setter.id });
    expect(applied.importJob?.state).toBe("done");
    expect(applied.documentHash).toMatch(/^[0-9a-f]{64}$/);
    documentHash = applied.documentHash!;

    const job = await ctx.db.mapImportJob.findUniqueOrThrow({ where: { id: applied.importJob!.id } });
    expect(job).toMatchObject({ state: "done", stage: "done", progress: 1, sourceHash: fixtureHash, documentHash, eventId: ctx.eventId, clubMapId: null, claimedBy: INSTANCE_ID, error: null, startedBy: setter.id });
    expect(job.heartbeatAt).not.toBeNull();

    const file = await ctx.db.mapFile.findFirstOrThrow({ where: { eventId: ctx.eventId }, select: { sourceHash: true, documentHash: true } });
    expect(file).toEqual({ sourceHash: fixtureHash, documentHash });
    const source = await ctx.db.mapSource.findUniqueOrThrow({ where: { fileHash: fixtureHash }, select: { kind: true, fileName: true, uploadedBy: true } });
    expect(source).toEqual({ kind: "ocad", fileName: "test.ocd", uploadedBy: setter.id });
    const doc = await ctx.db.mapDocument.findUniqueOrThrow({ where: { hash: documentHash }, select: { report: true, lastReferencedAt: true } });
    expect(doc.report).toMatchObject({ importer: "ocad-9", source: { fileName: "test.ocd", fileHash: fixtureHash }, counts: { objects: expect.any(Number) }, matching: { library: { id: "ISOM2017-2" } }, colourStack: { source: expect.any(Number) } });
  }, 60_000);

  it("re-uploading bytes already imported by this importer records a done job without running the worker", async () => {
    const before = await ctx.db.mapImportJob.count();
    const t = Date.now();
    await ctx.db.mapDocument.update({ where: { hash: documentHash }, data: { lastReferencedAt: new Date(Date.now() - 40 * 86_400_000) } });
    const applied = await applyEventMap(ctx.db, ctx.eventId, "renamed.ocd", fixture, { uploadedBy: admin.id });
    expect(applied.importJob?.state).toBe("done");
    expect(applied.documentHash).toBe(documentHash);
    expect(Date.now() - t).toBeLessThan(10_000);
    expect(await ctx.db.mapImportJob.count()).toBe(before + 1);
    const job = await ctx.db.mapImportJob.findUniqueOrThrow({ where: { id: applied.importJob!.id } });
    expect(job).toMatchObject({ state: "done", stage: "done", progress: 1, documentHash, startedBy: null });
    // The dedup hit touched the document before pinning it (docs/map-storage.md §6.1, §8.2).
    const touched = await ctx.db.mapDocument.findUniqueOrThrow({ where: { hash: documentHash }, select: { lastReferencedAt: true } });
    expect(Date.now() - touched.lastReferencedAt.getTime()).toBeLessThan(60_000);
    // The first upload's name stays on the source row; the pin follows the new map_files row.
    const source = await ctx.db.mapSource.findUniqueOrThrow({ where: { fileHash: fixtureHash }, select: { fileName: true } });
    expect(source.fileName).toBe("test.ocd");
    const file = await ctx.db.mapFile.findFirstOrThrow({ where: { eventId: ctx.eventId }, select: { fileName: true, documentHash: true } });
    expect(file).toEqual({ fileName: "renamed.ocd", documentHash });
  }, 30_000);

  it("pins the quick-access columns from the document, equal to the raster path's (docs/map-storage.md §6.4)", async () => {
    const doc = await ctx.db.mapDocument.findUniqueOrThrow({ where: { hash: documentHash }, select: { header: true, report: true } });
    const report = doc.report as { georeference?: { crs: string }; north?: { meridian: { medianTiltDeg: number } | null } };
    expect(report.georeference).toMatchObject({ crs: "EPSG:3006", projectable: true });
    expect(report.north?.meridian).toMatchObject({ code: "601.0", count: 12 });
    const expected = await parseOcadMapMetadata(fixture, 0);
    expect(expected.calibration).toHaveLength(4);
    const cols = { scale: true, bounds: true, northOffset: true, calibration: true } as const;
    const file = await ctx.db.mapFile.findFirstOrThrow({ where: { eventId: ctx.eventId }, select: { id: true, ...cols } });
    expect({ scale: file.scale, bounds: file.bounds, northOffset: file.northOffset, calibration: file.calibration }).toEqual(expected);
    expect(mapFileMetadataFor(documentFrameSchema.parse(doc.header), report.north!.meridian!.medianTiltDeg, 0)).toEqual(expected);

    // A row carrying an operator correction gets the corrected columns on (re-)pin; the pin is idempotent.
    await ctx.db.mapFile.update({ where: { id: file.id }, data: { rotationCorrection: 11, scale: null, bounds: Prisma.DbNull, northOffset: null, calibration: Prisma.DbNull } });
    const pin = { eventId: ctx.eventId, clubMapId: null, sourceHash: fixtureHash, documentHash };
    await applyJobResult(ctx.db, pin);
    await applyJobResult(ctx.db, pin);
    const corrected = await ctx.db.mapFile.findUniqueOrThrow({ where: { id: file.id }, select: cols });
    expect(corrected).toEqual(await parseOcadMapMetadata(fixture, 11));
    expect(corrected.northOffset! - file.northOffset!).toBeCloseTo(11, 1);
    await ctx.db.mapFile.update({ where: { id: file.id }, data: { rotationCorrection: 0, ...expected as object } });
  }, 60_000);

  it("leaves the columns alone when the document has no projectable CRS", async () => {
    const other = await createTestEvent("map_jobs_nocrs");
    try {
      // Grid 99999 is in no table: the document says crs null + CRS_UNRESOLVED, the raster path still infers SWEREF99 TM.
      const raw = readFileSync(FIXTURE);
      const at = raw.indexOf(Buffer.from("\ti13002"));
      expect(at).toBeGreaterThan(0);
      const bytes = Buffer.concat([raw.subarray(0, at), Buffer.from("\ti99999"), raw.subarray(at + 7), Buffer.from(`nocrs-${suffix}`)]);
      createdSourceHashes.add(sha256(bytes));
      const applied = await applyEventMap(ctx.db, other.eventId, "nocrs.ocd", bytes, {});
      expect(applied.importJob?.state).toBe("done");
      const doc = await ctx.db.mapDocument.findUniqueOrThrow({ where: { hash: applied.documentHash! }, select: { header: true, report: true } });
      expect((doc.header as { georeferencing: { crs: unknown } }).georeferencing.crs).toBeNull();
      expect((doc.report as { warnings: { code: string }[] }).warnings.map((w) => w.code)).toContain("CRS_UNRESOLVED");
      const file = await ctx.db.mapFile.findFirstOrThrow({ where: { eventId: other.eventId }, select: { scale: true, bounds: true, northOffset: true, calibration: true } });
      expect(file.calibration).not.toBeNull();
      expect(file).toEqual(await parseOcadMapMetadata(bytes, 0));
    } finally {
      await other.cleanup();
    }
  }, 60_000);

  it("fails cleanly on unreadable bytes of either kind", async () => {
    const bad = await startImportJob(ctx.db, { sourceHash: await garbageSource("ocad"), eventId: ctx.eventId });
    expect(bad.state).toBe("failed");
    expect(bad.error).toBeTruthy();
    expect(bad.documentHash).toBeNull();

    const omap = await startImportJob(ctx.db, { sourceHash: await garbageSource("omap"), eventId: ctx.eventId });
    expect(omap.state).toBe("failed");
    // Random bytes fail inside the XML reader (which error depends on the bytes), not with UNSUPPORTED_FORMAT.
    expect(omap.error).toBeTruthy();
    expect(omap.error).not.toMatch(/UNSUPPORTED_FORMAT/);
    expect(omap.documentHash).toBeNull();
    // The event's pin is untouched by a failed job.
    const file = await ctx.db.mapFile.findFirstOrThrow({ where: { eventId: ctx.eventId }, select: { documentHash: true } });
    expect(file.documentHash).toBe(documentHash);
  }, 60_000);

  it("imports a Mapper source through the same job path and dedups it against its own importer version", async () => {
    const xmap = readFileSync(resolve(__dirname, "../../../../../e2e/test.xmap"));
    const xmapHash = sha256(xmap);
    await ctx.db.mapSource.create({ data: { fileHash: xmapHash, kind: "omap", bytes: xmap, sizeBytes: xmap.byteLength, fileName: "test.xmap" } });
    createdSourceHashes.add(xmapHash);
    const job = await startImportJob(ctx.db, { sourceHash: xmapHash, clubMapId: null, eventId: null });
    expect(job.state).toBe("done");
    expect(job.documentHash).toBeTruthy();
    const doc = await ctx.db.mapDocument.findUniqueOrThrow({ where: { hash: job.documentHash! }, select: { importerVersion: true, header: true } });
    expect(doc.importerVersion).toBe("omap-3");
    expect((doc.header as { source: { kind: string } }).source.kind).toBe("omap");
    // A second job for the same source skips the worker and reuses the document.
    const again = await startImportJob(ctx.db, { sourceHash: xmapHash, clubMapId: null, eventId: null });
    expect(again).toMatchObject({ state: "done", documentHash: job.documentHash });
  }, 60_000);

  it("returns a still-queued row when the hold is zero, and the engine finishes it", async () => {
    const row = await startImportJob(ctx.db, { sourceHash: await garbageSource("ocad"), eventId: ctx.eventId, holdMs: 0 });
    expect(["queued", "running"]).toContain(row.state);
    const done = await waitForTerminal(row.id);
    expect(done.state).toBe("failed");
  }, 30_000);

  it("re-claims a running job whose heartbeat is stale, and leaves a live one alone", async () => {
    const stale = await ctx.db.mapImportJob.create({
      data: { eventId: ctx.eventId, sourceHash: fixtureHash, state: "running", stage: "parse", claimedBy: "other-instance", heartbeatAt: new Date(Date.now() - 120_000) },
    });
    const live = await ctx.db.mapImportJob.create({
      data: { eventId: ctx.eventId, sourceHash: fixtureHash, state: "running", stage: "parse", claimedBy: "other-instance", heartbeatAt: new Date() },
    });
    await kickImportJobs(ctx.db);
    const reclaimed = await waitForTerminal(stale.id);
    expect(reclaimed).toMatchObject({ state: "done", claimedBy: INSTANCE_ID, documentHash });
    const untouched = await ctx.db.mapImportJob.findUniqueOrThrow({ where: { id: live.id } });
    expect(untouched).toMatchObject({ state: "running", claimedBy: "other-instance" });
    await ctx.db.mapImportJob.delete({ where: { id: live.id } });
  }, 60_000);

  it("the status poll kicks a claimable job, enforces courses.view on event jobs, and returns the report when done", async () => {
    const queued = await ctx.db.mapImportJob.create({ data: { eventId: ctx.eventId, sourceHash: fixtureHash, state: "queued" } });

    const asStranger = makeCaller(null, { user: stranger, authEnabled: true, authMode: "proxy" });
    await expect(asStranger.mapImport.status({ jobId: queued.id })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const asSetter = makeCaller(null, { user: setter, authEnabled: true, authMode: "proxy" });
    const first = await asSetter.mapImport.status({ jobId: queued.id });
    expect(["queued", "running", "done"]).toContain(first.state);
    await waitForTerminal(queued.id);
    const after = await asSetter.mapImport.status({ jobId: queued.id });
    expect(after).toMatchObject({ state: "done", documentHash, eventId: Number(ctx.eventId) });
    expect(after.report).toMatchObject({ source: { fileHash: fixtureHash } });

    await expect(asSetter.mapImport.status({ jobId: "00000000-0000-7000-8000-000000000000" })).rejects.toMatchObject({ code: "NOT_FOUND" });

    const latest = await makeCaller(ctx.event, { user: setter, authEnabled: true, authMode: "proxy" }).mapImport.latestForEvent();
    expect(latest?.id).toBe(queued.id);
  }, 60_000);

  it("housekeeping drops uploads (abandoned or finalised) after 24 h and finished jobs after 7 days, nothing younger", async () => {
    const old = await ctx.db.mapUpload.create({ data: { eventId: ctx.eventId, fileName: "a.ocd", declaredBytes: 10, chunkBytes: 10, createdAt: new Date(Date.now() - 25 * 3_600_000) } });
    const oldFinalised = await ctx.db.mapUpload.create({ data: { eventId: ctx.eventId, fileName: "f.ocd", declaredBytes: 10, chunkBytes: 10, finalisedHash: fixtureHash, createdAt: new Date(Date.now() - 25 * 3_600_000) } });
    const freshFinalised = await ctx.db.mapUpload.create({ data: { eventId: ctx.eventId, fileName: "g.ocd", declaredBytes: 10, chunkBytes: 10, finalisedHash: fixtureHash } });
    const fresh = await ctx.db.mapUpload.create({ data: { eventId: ctx.eventId, fileName: "b.ocd", declaredBytes: 10, chunkBytes: 10 } });
    const oldJob = await ctx.db.mapImportJob.create({ data: { eventId: ctx.eventId, sourceHash: fixtureHash, state: "done", documentHash } });
    await ctx.db.$executeRaw`UPDATE oxygen.map_import_jobs SET updated_at = now() - interval '8 days' WHERE id = ${oldJob.id}::uuid`;
    const swept = await sweepImportHousekeeping(ctx.db);
    expect(swept.uploads).toBeGreaterThanOrEqual(1);
    expect(swept.jobs).toBeGreaterThanOrEqual(1);
    expect(await ctx.db.mapUpload.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await ctx.db.mapUpload.findUnique({ where: { id: fresh.id } })).not.toBeNull();
    expect(await ctx.db.mapUpload.findUnique({ where: { id: oldFinalised.id } })).toBeNull();
    expect(await ctx.db.mapUpload.findUnique({ where: { id: freshFinalised.id } })).not.toBeNull();
    // The source the finalised rows named is untouched (SET NULL side, and the sweep deletes uploads only).
    expect(await ctx.db.mapSource.count({ where: { fileHash: fixtureHash } })).toBe(1);
    expect(await ctx.db.mapImportJob.findUnique({ where: { id: oldJob.id } })).toBeNull();
  });
});

describe("club library on the series (§6.5)", () => {
  let clubMapId: string;

  it("clubMap.upload creates the series, the source and a done job that adds version 1", async () => {
    const caller = makeCaller(null, { user: admin, authEnabled: true, authMode: "proxy" });
    const created = await caller.clubMap.upload({ name: `Club ${suffix}`, fileName: "club.ocd", fileDataBase64: fixture.toString("base64") });
    clubMapId = created.id;
    expect(created).not.toHaveProperty("clubMapId");
    expect(created.importJob?.state).toBe("done");
    expect((await ctx.db.mapImportJob.findUniqueOrThrow({ where: { id: created.importJob!.id } })).startedBy).toBe(admin.id);

    const series = await ctx.db.clubMap.findUniqueOrThrow({ where: { id: clubMapId }, include: { versions: true, legacyRows: { select: { fileHash: true, name: true } } } });
    expect(series).toMatchObject({ name: `Club ${suffix}`, colourProfile: "auto", createdBy: admin.id });
    // The legacy row is written through for the raster consumers.
    expect(series.legacyRows).toEqual([{ fileHash: fixtureHash, name: `Club ${suffix}` }]);
    expect(series.versions).toHaveLength(1);
    // Label and uploader follow the library upload when the job finished
    // inside the hold (it did: the fixture imports in milliseconds).
    expect(series.versions[0]).toMatchObject({ seq: 1, sourceHash: fixtureHash, documentHash, label: "club.ocd", uploadedBy: admin.id });

    const listed = (await caller.clubMap.list()).find((m) => m.id === clubMapId);
    expect(listed).toMatchObject({
      version: { seq: 1, sourceHash: fixtureHash, documentHash, label: "club.ocd", uploadedBy: admin.id },
      versionCount: 1,
      importJob: null,
      previewUrl: `/api/map-documents/${documentHash}/thumbnail.png`,
    });
  }, 60_000);

  it("course.useClubMap pins the club version on the event's map row and reuses the document", async () => {
    const caller = makeCaller(ctx.event, { user: setter, authEnabled: true, authMode: "proxy" });
    const result = await caller.course.useClubMap({ clubMapId });
    expect(result.documentHash).toBe(documentHash);
    const version = await ctx.db.clubMapVersion.findFirstOrThrow({ where: { clubMapId }, select: { id: true } });
    const file = await ctx.db.mapFile.findFirstOrThrow({ where: { eventId: ctx.eventId }, select: { clubMapVersionId: true, documentHash: true, fromClubLibrary: true } });
    expect(file).toEqual({ clubMapVersionId: version.id, documentHash, fromClubLibrary: true });
  }, 60_000);

  it("rename, colour and rotation land on the series and are written through to the legacy row", async () => {
    const caller = makeCaller(null, { user: admin, authEnabled: true, authMode: "proxy" });
    const before = await ctx.db.clubMapFile.findFirstOrThrow({ where: { clubMapId }, select: { renderKey: true } });
    await caller.clubMap.rename({ id: clubMapId, name: `Club ${suffix} renamed` });
    await caller.clubMap.setColorStack({ id: clubMapId, profile: "issprom", northLinesBelow: false, overrides: { above: [2] } });
    await caller.clubMap.setRotation({ id: clubMapId, degrees: 2.5 });
    const series = await ctx.db.clubMap.findUniqueOrThrow({ where: { id: clubMapId } });
    expect(series).toMatchObject({ name: `Club ${suffix} renamed`, colourProfile: "issprom", northLinesBelow: false, colourOverrides: { above: [2] }, rotationCorrection: 2.5 });
    const legacy = await ctx.db.clubMapFile.findFirstOrThrow({ where: { clubMapId } });
    expect(legacy).toMatchObject({ name: `Club ${suffix} renamed`, colorProfile: "issprom", northLinesBelow: false, colorOverrides: { above: [2] }, rotationCorrection: 2.5 });
    expect(legacy.renderKey).not.toBe(before.renderKey);
    await expect(caller.clubMap.rename({ id: "00000000-0000-7000-8000-000000000000", name: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller.clubMap.setColorStack({ id: "00000000-0000-7000-8000-000000000000", profile: "isom" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  }, 30_000);

  it("addFromSource builds a library entry from a finalised source and dedups the import", async () => {
    const caller = makeCaller(null, { user: admin, authEnabled: true, authMode: "proxy" });
    const created = await caller.clubMap.addFromSource({ fileHash: fixtureHash, name: `Club ${suffix} from source` });
    expect(created.importJob?.state).toBe("done");
    const versions = await ctx.db.clubMapVersion.findMany({ where: { clubMapId: created.id } });
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ seq: 1, documentHash });
    expect(await ctx.db.clubMapFile.count({ where: { clubMapId: created.id } })).toBe(1);
    await expect(caller.clubMap.addFromSource({ fileHash: "0".repeat(64) })).rejects.toMatchObject({ code: "NOT_FOUND" });
  }, 30_000);

  it("remove deletes the legacy row and the series; event pins null out, blobs stay for the GC", async () => {
    const caller = makeCaller(null, { user: admin, authEnabled: true, authMode: "proxy" });
    const pendingBefore = (await planBackfill(ctx.db)).clubRows.length;
    await caller.clubMap.remove({ id: clubMapId });
    expect(await ctx.db.clubMap.findUnique({ where: { id: clubMapId } })).toBeNull();
    expect(await ctx.db.clubMapVersion.count({ where: { clubMapId } })).toBe(0);
    // No unlinked legacy row is left for the backfill to resurrect.
    expect(await ctx.db.clubMapFile.count({ where: { name: `Club ${suffix} renamed` } })).toBe(0);
    expect((await planBackfill(ctx.db)).clubRows.length).toBe(pendingBefore);
    const file = await ctx.db.mapFile.findFirstOrThrow({ where: { eventId: ctx.eventId }, select: { clubMapVersionId: true, documentHash: true, sourceHash: true } });
    expect(file).toEqual({ clubMapVersionId: null, documentHash, sourceHash: fixtureHash });
    expect(await ctx.db.mapDocument.findUnique({ where: { hash: documentHash }, select: { hash: true } })).not.toBeNull();
    expect(await ctx.db.mapSource.findUnique({ where: { fileHash: fixtureHash }, select: { fileHash: true } })).not.toBeNull();
    await expect(caller.clubMap.remove({ id: clubMapId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("chunked upload routes", () => {
  const CHUNK = 8192;
  const init = (headers: Record<string, string>, body: unknown = { fileName: "chunked.ocd", bytes: fixture.byteLength, chunkBytes: CHUNK }) =>
    server.inject({ method: "POST", url: "/api/map-uploads", headers, payload: body as Record<string, unknown> });
  const put = (id: string, n: number, bytes: Uint8Array, headers: Record<string, string>) =>
    server.inject({ method: "PUT", url: `/api/map-uploads/${id}/chunks/${n}`, headers: { ...headers, "content-type": "application/octet-stream" }, payload: Buffer.from(bytes) });
  const finalise = (id: string, headers: Record<string, string>) => server.inject({ method: "POST", url: `/api/map-uploads/${id}/finalise`, headers });
  const slice = (n: number, bytes: Uint8Array = fixture, chunk = CHUNK) => bytes.subarray(n * chunk, (n + 1) * chunk);

  it("init: 401 anonymous, 403 without courses.edit, 404 unknown event, 400/413 on bad bodies, 201 for a course setter", async () => {
    expect((await init(eventHeaders(null))).statusCode).toBe(401);
    expect((await init(eventHeaders(stranger))).statusCode).toBe(403);
    expect((await init(as(setter, { "x-event-id": "no_such_event_" + suffix }))).statusCode).toBe(404);
    expect((await init(eventHeaders(setter), { fileName: "", bytes: 1, chunkBytes: 1 })).statusCode).toBe(400);
    expect((await init(eventHeaders(setter), { fileName: "x.ocd", bytes: MAX_UPLOAD_BYTES + 1, chunkBytes: CHUNK })).statusCode).toBe(413);
    const ok = await init(eventHeaders(setter));
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ chunkCount: Math.ceil(fixture.byteLength / CHUNK), chunkBytes: CHUNK });
    expect(ok.json().uploadId).toMatch(/^[0-9a-f-]{36}$/);
    const row = await ctx.db.mapUpload.findUniqueOrThrow({ where: { id: ok.json().uploadId } });
    expect(row).toMatchObject({ eventId: ctx.eventId, fileName: "chunked.ocd", uploadedBy: setter.id, kind: null, finalisedHash: null });
  });

  it("chunks in any order, idempotent per index, with size, range and kind checks; finalise assembles, dedups and is idempotent", async () => {
    const { uploadId, chunkCount } = (await init(eventHeaders(setter))).json();
    expect(chunkCount).toBeGreaterThanOrEqual(3);

    expect((await put(uploadId, 0, slice(0).subarray(0, 100), eventHeaders(setter))).statusCode).toBe(400);
    expect((await put(uploadId, chunkCount, slice(0), eventHeaders(setter))).statusCode).toBe(400);
    expect((await put(uploadId, 0, Buffer.alloc(CHUNK, 0x41), eventHeaders(setter))).statusCode).toBe(415);
    expect((await put(uploadId, 1, slice(1), eventHeaders(stranger))).statusCode).toBe(403);
    expect((await put(uploadId, 1, slice(1), eventHeaders(null))).statusCode).toBe(401);

    const incomplete = await finalise(uploadId, eventHeaders(setter));
    expect(incomplete.statusCode).toBe(409);
    expect(incomplete.json().missing).toEqual([...Array(chunkCount).keys()]);

    // Last chunk first, then the rest; chunk 1 twice.
    for (const n of [chunkCount - 1, ...Array.from({ length: chunkCount - 1 }, (_, i) => i), 1]) {
      expect((await put(uploadId, n, slice(n), eventHeaders(setter))).statusCode).toBe(204);
    }
    expect((await ctx.db.mapUpload.findUniqueOrThrow({ where: { id: uploadId } })).kind).toBe("ocad");

    const done = await finalise(uploadId, eventHeaders(setter));
    expect(done.statusCode).toBe(200);
    expect(done.json()).toEqual({ fileHash: fixtureHash, bytes: fixture.byteLength, deduplicated: true });
    expect(await ctx.db.mapUploadChunk.count({ where: { uploadId } })).toBe(0);
    expect((await ctx.db.mapUpload.findUniqueOrThrow({ where: { id: uploadId } })).finalisedHash).toBe(fixtureHash);

    const again = await finalise(uploadId, eventHeaders(setter));
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ fileHash: fixtureHash, deduplicated: true });
    expect((await put(uploadId, 0, slice(0), eventHeaders(setter))).statusCode).toBe(409);
    expect((await finalise("00000000-0000-7000-8000-000000000000", eventHeaders(setter))).statusCode).toBe(404);
    expect((await finalise("not-a-uuid", eventHeaders(setter))).statusCode).toBe(404);
  });

  it("new bytes become a new source row; applyUploadedMap makes it the event map and reports the job", async () => {
    // A valid OCAD header prefix with random body: stored fine, import fails — that is the job's business, not the upload's.
    const bytes = Buffer.concat([fixture.subarray(0, 48), randomBytes(2000)]);
    const hash = sha256(bytes);
    createdSourceHashes.add(hash);
    const { uploadId, chunkCount } = (await init(eventHeaders(setter), { fileName: "fresh.ocd", bytes: bytes.byteLength, chunkBytes: 1024 })).json();
    expect(chunkCount).toBe(2);
    for (let n = 0; n < chunkCount; n++) expect((await put(uploadId, n, slice(n, bytes, 1024), eventHeaders(setter))).statusCode).toBe(204);
    const fin = await finalise(uploadId, eventHeaders(setter));
    expect(fin.json()).toEqual({ fileHash: hash, bytes: bytes.byteLength, deduplicated: false });
    const source = await ctx.db.mapSource.findUniqueOrThrow({ where: { fileHash: hash } });
    expect(source).toMatchObject({ kind: "ocad", fileName: "fresh.ocd", sizeBytes: bytes.byteLength, uploadedBy: setter.id });
    expect(Buffer.from(source.bytes).equals(bytes)).toBe(true);

    const caller = makeCaller(ctx.event, { user: setter, authEnabled: true, authMode: "proxy" });
    const good = await caller.course.applyUploadedMap({ fileHash: fixtureHash, fileName: "chunked.ocd" });
    expect(good).toMatchObject({ success: true, fileName: "chunked.ocd", documentHash });
    expect((await ctx.db.mapImportJob.findUniqueOrThrow({ where: { id: good.importJob!.id } })).startedBy).toBe(setter.id);
    const file = await ctx.db.mapFile.findFirstOrThrow({ where: { eventId: ctx.eventId }, select: { fileName: true, sourceHash: true, documentHash: true } });
    expect(file).toEqual({ fileName: "chunked.ocd", sourceHash: fixtureHash, documentHash });
    const byDefault = await caller.course.applyUploadedMap({ fileHash: fixtureHash });
    expect(byDefault.fileName).toBe("test.ocd");

    await expect(caller.course.applyUploadedMap({ fileHash: "f".repeat(64) })).rejects.toMatchObject({ code: "NOT_FOUND" });
  }, 60_000);

  it("club-library uploads need only a signed-in user and feed clubMap.addFromSource", async () => {
    expect((await init(as(null))).statusCode).toBe(401);
    const ok = await init(as(stranger), { fileName: "lib.ocd", bytes: fixture.byteLength, chunkBytes: CHUNK });
    expect(ok.statusCode).toBe(201);
    const { uploadId, chunkCount } = ok.json();
    expect((await ctx.db.mapUpload.findUniqueOrThrow({ where: { id: uploadId } })).eventId).toBeNull();
    for (let n = 0; n < chunkCount; n++) expect((await put(uploadId, n, slice(n), as(stranger))).statusCode).toBe(204);
    const fin = await finalise(uploadId, as(stranger));
    expect(fin.json()).toMatchObject({ fileHash: fixtureHash, deduplicated: true });

    const caller = makeCaller(null, { user: stranger, authEnabled: true, authMode: "proxy" });
    const created = await caller.clubMap.addFromSource({ fileHash: fixtureHash, fileName: "lib.ocd", name: `Club ${suffix} via chunks` });
    expect(created.importJob?.state).toBe("done");
    expect(created.fileName).toBe("lib.ocd");
  }, 60_000);
});

describe("applyJobResult", () => {
  it("is idempotent for club versions and only ever adds one per (series, source)", async () => {
    const series = await ctx.db.clubMap.create({ data: { name: `Club ${suffix} idem` }, select: { id: true } });
    const job = { eventId: null, clubMapId: series.id, sourceHash: fixtureHash, documentHash };
    await applyJobResult(ctx.db, job);
    await applyJobResult(ctx.db, job);
    expect(await ctx.db.clubMapVersion.count({ where: { clubMapId: series.id } })).toBe(1);
    await ctx.db.clubMap.delete({ where: { id: series.id } });
  });
});
