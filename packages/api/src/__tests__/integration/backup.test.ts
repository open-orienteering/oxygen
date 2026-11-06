/**
 * Per-event dump and the map part of its restore (docs/backup-restore.md,
 * docs/map-storage.md §7.3): the dump carries the event's `map_sources`
 * and `map_documents` rows by hash ahead of `map_files`; the restore
 * script loads them into a database that lost them, re-points a new
 * event's `map_files`, refuses bytes that do not match their hash, and is
 * a no-op the second time. `club_symbol_decisions` travels whole and
 * merges by key, the newer `decided_at` winning. The `map_files` section
 * of a dump written before v0.6.1 (bytes in `file_data`) restores through
 * `restore-legacy-map-files.sql`, and the re-match imports what has no
 * document (E5).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";
import { applyEventMap } from "../../event-map.js";
import { registerBackupRoute, splitBackupSections } from "../../backup.js";
import { runRematch } from "../../map-store/rematch.js";

const FIXTURE = resolve(__dirname, "../../../../../e2e/test.ocd");
const RESTORE_SCRIPT = resolve(__dirname, "../../../scripts/restore-map-blobs.sql");
const LEGACY_RESTORE_SCRIPT = resolve(__dirname, "../../../scripts/restore-legacy-map-files.sql");
const suffix = randomBytes(4).toString("hex");
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

let source: TestEventContext; // the event that is backed up, then lost
let target: TestEventContext; // the event the dump is restored into
let server: FastifyInstance;
let dir: string;
let fixture: Buffer;
let sourceHash: string;
let documentHash: string;
let documentBytes: Buffer;
let dump: string;
let uploaderId: string;
let originalFile: Record<string, unknown>;
let courseObjectId: string;
// Fingerprints no real symbol has: decisions are instance-global and keyed
// by symbol geometry, so a real one would change other suites' imports.
const FP = (k: string) => `ocad:999.9:bk${suffix}${k}`;
const LIB = "ISOM2017-2@2026.10.1";
const T0 = new Date("2026-05-01T10:00:00Z");

/** Run a restore script as documented: from the directory holding the `<table>.csv` sections. */
function psqlRestore(cwd: string, eventId?: bigint, script = RESTORE_SCRIPT): void {
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.delete("schema");
  const args = [url.toString(), "-X", "-q"];
  if (eventId !== undefined) args.push("-v", `event_id=${eventId}`);
  args.push("-f", script);
  execFileSync("psql", args, { stdio: "pipe", cwd });
}

/** Write the map sections of `text` as `<table>.csv` into a new directory under `dir`. */
function sectionsOf(name: string, text: string): string {
  return writeSections(name, text);
}

/** Write the map sections of `text` as `<table>.csv` into a new directory under `dir`. */
function writeSections(name: string, text: string, edit: (t: string, csv: string) => string = (_t, csv) => csv): string {
  const out = join(dir, name);
  mkdirSync(out);
  const sections = splitBackupSections(text);
  for (const t of ["map_sources", "map_documents", "club_symbol_decisions", "map_files"]) writeFileSync(join(out, `${t}.csv`), edit(t, sections.get(t)!));
  return out;
}

beforeAll(async () => {
  source = await createTestEvent("backup_src");
  target = await createTestEvent("backup_dst");
  dir = mkdtempSync(join(tmpdir(), "oxygen-backup-"));
  // Per-run trailer: content-addressed rows are global (see map-documents.test.ts).
  fixture = Buffer.concat([readFileSync(FIXTURE), Buffer.from(`backup-${suffix}`)]);
  const uploader = await source.db.user.create({
    data: { email: `uploader@backup-${suffix}.example`, displayName: "Uploader", active: true },
  });
  uploaderId = uploader.id;
  const applied = await applyEventMap(source.db, source.eventId, "backup.ocd", fixture, { uploadedBy: uploader.id });
  documentHash = applied.documentHash!;
  const row = await source.db.mapFile.findFirstOrThrow({ where: { eventId: source.eventId } });
  sourceHash = row.sourceHash!;
  originalFile = row as unknown as Record<string, unknown>;
  await source.db.clubSymbolDecision.createMany({
    data: ["lost", "newer", "older"].map((k) => ({ fingerprint: FP(k), libraryVersion: LIB, canonicalId: `dump-${k}`, decidedBy: uploader.id, decidedAt: T0 })),
  });
  documentBytes = Buffer.from((await source.db.mapDocument.findUniqueOrThrow({ where: { hash: documentHash } })).bytes);
  courseObjectId = (await source.db.courseObject.create({
    data: { eventId: source.eventId, kind: "oob_area", geometry: [{ x: 1, y: 1 }, { x: 5, y: 1 }, { x: 5, y: 5 }], scope: { all: true } },
  })).id;

  server = Fastify({ logger: false });
  registerBackupRoute(server);
  await server.ready();
  const res = await server.inject({ method: "GET", url: `/api/backup/event?name=${source.nameId}` });
  expect(res.statusCode).toBe(200);
  dump = res.body;
}, 60_000);

afterAll(async () => {
  await server?.close();
  await source?.cleanup();
  await target?.cleanup();
  await target.db.mapDocument.deleteMany({ where: { sourceHash } });
  await target.db.mapSource.deleteMany({ where: { fileHash: sourceHash } });
  await target.db.clubSymbolDecision.deleteMany({ where: { fingerprint: { contains: `bk${suffix}` } } });
  await target.db.user.deleteMany({ where: { email: { endsWith: `@backup-${suffix}.example` } } });
  if (dir) rmSync(dir, { recursive: true, force: true });
  await disconnect();
}, 30_000);

describe("per-event dump", () => {
  it("completes and carries the blob sections before map_files", () => {
    expect(dump).not.toContain("-- BACKUP FAILED");
    const order = [...splitBackupSections(dump).keys()];
    expect(order.indexOf("map_sources")).toBeLessThan(order.indexOf("map_documents"));
    expect(order.indexOf("map_documents")).toBeLessThan(order.indexOf("map_files"));
  });

  it("holds exactly the event's source and document, bytes as \\x hex", () => {
    const sections = splitBackupSections(dump);
    const sources = sections.get("map_sources")!.trim().split("\n");
    const documents = sections.get("map_documents")!.trim().split("\n");
    expect(sources).toHaveLength(2); // header + one row
    expect(documents).toHaveLength(2);
    expect(sources[1].startsWith(`${sourceHash},`)).toBe(true);
    expect(documents[1].startsWith(`${documentHash},`)).toBe(true);
    expect(sources[1]).toContain(`\\x${fixture.subarray(0, 16).toString("hex")}`);
    expect(documents[1]).toContain(`\\x${documentBytes.subarray(0, 16).toString("hex")}`);
  });

  it("carries the club's symbol decisions", () => {
    const rows = splitBackupSections(dump).get("club_symbol_decisions")!;
    for (const k of ["lost", "newer", "older"]) expect(rows).toContain(`${FP(k)},${LIB},dump-${k},`);
  });

  it("carries the event's course objects (course-layer.md §8)", () => {
    const rows = splitBackupSections(dump).get("course_objects")!.trim().split("\n");
    expect(rows).toHaveLength(2);
    expect(rows[1].startsWith(`${courseObjectId},`)).toBe(true);
  });

  it("omits previews", () => {
    expect(splitBackupSections(dump).has("map_previews")).toBe(false);
  });
});

describe("restore-map-blobs.sql", () => {
  let sectionsDir: string;

  beforeAll(async () => {
    sectionsDir = writeSections("dump", dump);
    // Lose the event, then its blobs (now unreferenced) and the uploader:
    // the target database holds none of what the dump carries.
    await source.db.event.delete({ where: { id: source.eventId } });
    await source.db.mapDocument.deleteMany({ where: { hash: documentHash } });
    await source.db.mapSource.deleteMany({ where: { fileHash: sourceHash } });
    await source.db.user.delete({ where: { id: uploaderId } });
    // Decisions: one lost, one decided again since the dump, one older here than in the dump.
    await source.db.clubSymbolDecision.delete({ where: { fingerprint_libraryVersion: { fingerprint: FP("lost"), libraryVersion: LIB } } });
    await source.db.clubSymbolDecision.update({
      where: { fingerprint_libraryVersion: { fingerprint: FP("newer"), libraryVersion: LIB } },
      data: { canonicalId: "live-newer", decidedAt: new Date("2026-09-01T10:00:00Z") },
    });
    await source.db.clubSymbolDecision.update({
      where: { fingerprint_libraryVersion: { fingerprint: FP("older"), libraryVersion: LIB } },
      data: { canonicalId: "live-older", decidedAt: new Date("2026-01-01T10:00:00Z") },
    });
  }, 30_000);

  it("refuses bytes that do not match their hash and writes nothing", async () => {
    const tampered = writeSections("tampered", dump, (t, csv) => {
      if (t !== "map_sources") return csv;
      // Flip one hex digit inside the bytea column (after the `\x`).
      const at = csv.indexOf("\\x") + 10;
      return csv.slice(0, at) + (csv[at] === "0" ? "1" : "0") + csv.slice(at + 1);
    });
    expect(() => psqlRestore(tampered, target.eventId)).toThrow(/do not match/);
    expect(await target.db.mapSource.count({ where: { fileHash: sourceHash } })).toBe(0);
    expect(await target.db.mapFile.count({ where: { eventId: target.eventId } })).toBe(0);
  });

  it("restores the blobs byte-exact and pins them from the new event", async () => {
    psqlRestore(sectionsDir, target.eventId);

    const src = await target.db.mapSource.findUniqueOrThrow({ where: { fileHash: sourceHash } });
    expect(sha256(src.bytes)).toBe(sourceHash);
    expect(src.uploadedBy).toBeNull(); // the uploader is gone from this database
    const doc = await target.db.mapDocument.findUniqueOrThrow({ where: { hash: documentHash } });
    expect(Buffer.from(doc.bytes).equals(documentBytes)).toBe(true);
    expect(doc.sourceHash).toBe(sourceHash);
    // The grace restarts at the restore.
    expect(Date.now() - doc.lastReferencedAt.getTime()).toBeLessThan(60_000);

    const files = await target.db.mapFile.findMany({ where: { eventId: target.eventId } });
    expect(files).toHaveLength(1);
    expect(files[0].sourceHash).toBe(sourceHash);
    expect(files[0].documentHash).toBe(documentHash);
    expect(files[0].clubMapVersionId).toBeNull();
    // Every column survives except the local identity: catches a map_files
    // column added later but missing from the script's INSERT list.
    const strip = (r: Record<string, unknown>) => {
      const { id: _id, eventId: _eventId, clubMapVersionId: _v, ...rest } = r;
      return rest;
    };
    expect(strip(files[0] as unknown as Record<string, unknown>)).toEqual(strip(originalFile));
  });

  it("merges the decisions: a lost row returns, the newer decided_at wins", async () => {
    const rows = await target.db.clubSymbolDecision.findMany({ where: { fingerprint: { contains: `bk${suffix}` } }, orderBy: { fingerprint: "asc" } });
    const byKey = Object.fromEntries(rows.map((r) => [r.fingerprint, r]));
    expect(byKey[FP("lost")]).toMatchObject({ canonicalId: "dump-lost", decidedBy: null, decidedAt: T0 });
    expect(byKey[FP("newer")]).toMatchObject({ canonicalId: "live-newer" });
    expect(byKey[FP("older")]).toMatchObject({ canonicalId: "dump-older", decidedAt: T0 });
  });

  it("is a no-op the second time", async () => {
    const before = await target.db.mapDocument.findUniqueOrThrow({ where: { hash: documentHash }, select: { createdAt: true } });
    psqlRestore(sectionsDir, target.eventId);
    expect(await target.db.mapFile.count({ where: { eventId: target.eventId } })).toBe(1);
    expect(await target.db.mapSource.count({ where: { fileHash: sourceHash } })).toBe(1);
    const after = await target.db.mapDocument.findUniqueOrThrow({ where: { hash: documentHash }, select: { createdAt: true } });
    expect(after.createdAt).toEqual(before.createdAt); // existing rows are never rewritten
  });

  it("loads the blobs alone without an event id", () => {
    expect(() => psqlRestore(sectionsDir)).not.toThrow();
  });
});

describe("restore-legacy-map-files.sql (a dump written before v0.6.1)", () => {
  let legacy: TestEventContext;
  // Bytes of their own, so the restore has to create the source rows.
  const oldBytes = Buffer.concat([readFileSync(FIXTURE), Buffer.from(`backup-legacy-old-${suffix}`)]);
  const sliceBytes = Buffer.concat([readFileSync(FIXTURE), Buffer.from(`backup-legacy-slice-${suffix}`)]);
  const hex = (b: Buffer) => `\\x${b.toString("hex")}`;

  /** A directory holding one `map_files.csv`. */
  function legacySection(name: string, csv: string): string {
    const out = join(dir, name);
    mkdirSync(out);
    writeFileSync(join(out, "map_files.csv"), csv);
    return out;
  }

  beforeAll(async () => {
    legacy = await createTestEvent("backup_legacy");
  });

  afterAll(async () => {
    await legacy?.cleanup();
    for (const b of [oldBytes, sliceBytes]) {
      await legacy.db.mapImportJob.deleteMany({ where: { sourceHash: sha256(b) } });
      await legacy.db.mapDocument.deleteMany({ where: { sourceHash: sha256(b) } });
      await legacy.db.mapSource.deleteMany({ where: { fileHash: sha256(b) } });
    }
  }, 30_000);

  it("refuses a v0.6.1 dump's section, which restore-map-blobs.sql loads", () => {
    expect(() => psqlRestore(sectionsOf("current", dump), legacy.eventId, LEGACY_RESTORE_SCRIPT)).toThrow(/no file_data column/);
  });

  it("refuses a row whose file_data does not match its source_hash", async () => {
    const csv = `id,event_id,file_name,file_data,uploaded_at,source_hash\n3,9,x.ocd,${hex(sliceBytes)},2026-10-01 10:00:00+00,${"0".repeat(64)}\n`;
    expect(() => psqlRestore(legacySection("legacy-tampered", csv), legacy.eventId, LEGACY_RESTORE_SCRIPT)).toThrow(/does not match its source_hash/);
    expect(await legacy.db.mapSource.count({ where: { fileHash: sha256(sliceBytes) } })).toBe(0);
  });

  it("makes a pre-vector row's bytes a source, pins it, and the re-match imports it", async () => {
    // The shape of a dump from before the vector pipeline: no hashes at all.
    const csv = [
      "id,event_id,file_name,file_data,uploaded_at,scale,bounds,north_offset",
      `7,42,old.ocd,${hex(oldBytes)},2026-03-01 10:00:00+00,10000,,`,
    ].join("\n") + "\n";
    const at = legacySection("legacy-prevector", csv);
    psqlRestore(at, legacy.eventId, LEGACY_RESTORE_SCRIPT);
    psqlRestore(at, legacy.eventId, LEGACY_RESTORE_SCRIPT); // idempotent

    const src = await legacy.db.mapSource.findUniqueOrThrow({ where: { fileHash: sha256(oldBytes) } });
    expect(src).toMatchObject({ kind: "ocad", fileName: "old.ocd", sizeBytes: oldBytes.byteLength });
    expect(Buffer.from(src.bytes).equals(oldBytes)).toBe(true);
    const rows = await legacy.db.mapFile.findMany({ where: { eventId: legacy.eventId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fileName: "old.ocd", sourceHash: sha256(oldBytes), documentHash: null, scale: 10000, rotationCorrection: 0, fromClubLibrary: false });
    expect(rows[0].uploadedAt.toISOString()).toBe("2026-03-01T10:00:00.000Z");

    const run = await runRematch(legacy.db, { eventId: legacy.eventId });
    expect(run).toMatchObject({ total: 1, done: 1, failed: 0 });
    const pinned = await legacy.db.mapFile.findFirstOrThrow({ where: { eventId: legacy.eventId }, select: { documentHash: true, bounds: true } });
    expect(pinned.documentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(pinned.bounds).not.toBeNull();
  }, 120_000);

  it("keeps a slice-A-or-later row's document when this database holds it, and drops the columns v0.6.1 has not", async () => {
    // The v0.6.0 column order; `document_hash` names the document the
    // pre-vector case above just imported (a document of another source is not taken).
    const other = await createTestEvent("backup_legacy_slice");
    try {
      const doc = (await legacy.db.mapFile.findFirstOrThrow({ where: { eventId: legacy.eventId }, select: { documentHash: true } })).documentHash!;
      const header = "id,event_id,file_name,file_data,uploaded_at,scale,bounds,north_offset,calibration,from_club_library,rotation_correction,north_detection,color_profile,color_overrides,north_lines_below,file_hash,render_key,source_hash,document_hash,club_map_version_id";
      const row = (bytes: Buffer, uploaded: string, documentHashCol: string) =>
        `11,9,slice.ocd,${hex(bytes)},${uploaded},10000,,,,f,1.5,,auto,{},t,${sha256(bytes)},rk,${sha256(bytes)},${documentHashCol},`;
      const csv = [header, row(oldBytes, "2026-10-01 10:00:00+00", doc), row(sliceBytes, "2026-10-02 10:00:00+00", doc)].join("\n") + "\n";
      psqlRestore(legacySection("legacy-slice", csv), other.eventId, LEGACY_RESTORE_SCRIPT);
      const rows = await other.db.mapFile.findMany({ where: { eventId: other.eventId }, orderBy: { uploadedAt: "asc" } });
      expect(rows.map((r) => [r.sourceHash, r.documentHash, r.rotationCorrection])).toEqual([
        [sha256(oldBytes), doc, 1.5],
        [sha256(sliceBytes), null, 1.5],
      ]);
    } finally {
      await other.cleanup();
    }
  }, 60_000);
});
