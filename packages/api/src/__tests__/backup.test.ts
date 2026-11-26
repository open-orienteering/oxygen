/**
 * The per-event dump script (docs/ops/backup-restore.md, docs/map-storage.md
 * §7.3): table order, per-table filters, and splitting a dump back into
 * its sections.
 */

import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import {
  BACKUP_COMPLETE_MARKER,
  BACKUP_EXCLUDED,
  BACKUP_TABLES,
  buildBackupScript,
  parseDatabaseUrl,
  psqlInvocation,
  splitBackupSections,
  startBackupStream,
  type BackupEvent,
  type PgDumpProcess,
} from "../backup.js";

describe("BACKUP_TABLES", () => {
  it("puts the blob tables before map_files (FK order: sources, documents, map_files)", () => {
    const i = (t: string) => BACKUP_TABLES.indexOf(t as (typeof BACKUP_TABLES)[number]);
    expect(i("map_sources")).toBeGreaterThan(-1);
    expect(i("map_sources")).toBeLessThan(i("map_documents"));
    expect(i("map_documents")).toBeLessThan(i("map_files"));
    expect(i("club_symbol_decisions")).toBeGreaterThan(-1);
    expect(BACKUP_TABLES[0]).toBe("events");
  });

  it("puts the map patch directly after map_files (its document is restored before it)", () => {
    const i = (t: string) => BACKUP_TABLES.indexOf(t as (typeof BACKUP_TABLES)[number]);
    expect(i("map_patches")).toBe(i("map_files") + 1);
  });

  it("carries the GPS tracks after the map patch, filtered by event (map-gps-tracks.md §1.3)", () => {
    const i = (t: string) => BACKUP_TABLES.indexOf(t as (typeof BACKUP_TABLES)[number]);
    expect(i("map_gps_tracks")).toBe(i("map_patches") + 1);
    expect(buildBackupScript(42n)).toContain("\\copy (SELECT * FROM oxygen.map_gps_tracks WHERE event_id = 42) TO STDOUT");
  });

  it("does not carry previews or height fields (caches) or the global tile cache", () => {
    expect(BACKUP_TABLES).not.toContain("map_previews");
    // The height field is cache too: a restore derives its own (map-storage.md §4.7).
    expect(BACKUP_TABLES).not.toContain("map_heightfields");
    // So is the DEM job's state: a restore fetches its own (map-storage.md §4.7).
    expect(BACKUP_TABLES).not.toContain("map_dem_jobs");
    expect(BACKUP_TABLES).not.toContain("map_tiles");
    // Dropped with the raster pipeline (E5).
    expect(BACKUP_TABLES).not.toContain("rendered_maps");
  });
});

describe("buildBackupScript", () => {
  const script = buildBackupScript(42n);

  it("emits one separator and one \\copy per table, in order", () => {
    const separators = [...script.matchAll(/^\\echo --- (\S+) ---$/gm)].map((m) => m[1]);
    expect(separators).toEqual([...BACKUP_TABLES]);
    expect(script.match(/^\\copy /gm)).toHaveLength(BACKUP_TABLES.length);
  });

  it("filters map_sources to the event's pins and their documents' sources", () => {
    const line = script.split("\n").find((l) => l.includes("FROM oxygen.map_sources"))!;
    expect(line).toContain("f.source_hash FROM oxygen.map_files f WHERE f.event_id = 42");
    expect(line).toContain("d.source_hash FROM oxygen.map_documents d JOIN oxygen.map_files f ON f.document_hash = d.hash WHERE f.event_id = 42");
    expect(line).toContain("d.source_hash FROM oxygen.map_documents d JOIN oxygen.map_patches p ON p.document_hash = d.hash WHERE p.event_id = 42");
  });

  it("filters map_documents to the event's document pins", () => {
    const line = script.split("\n").find((l) => l.includes("FROM oxygen.map_documents s"))!;
    expect(line).toContain("f.document_hash FROM oxygen.map_files f WHERE f.event_id = 42");
    // A dormant patch's document (docs/map-patches.md §3.5).
    expect(line).toContain("p.document_hash FROM oxygen.map_patches p WHERE p.event_id = 42");
  });

  it("carries the club's symbol decisions whole (instance-global)", () => {
    expect(script).toContain("SELECT * FROM oxygen.club_symbol_decisions ORDER BY fingerprint, library_version");
  });

  it("keeps the event-scoped filters", () => {
    expect(script).toContain("SELECT * FROM oxygen.events WHERE id = 42");
    expect(script).toContain("SELECT * FROM oxygen.map_files WHERE event_id = 42");
    expect(script).toContain("SELECT * FROM oxygen.map_patches WHERE event_id = 42");
    expect(script).toContain("JOIN oxygen.courses c ON c.id = cc.course_id WHERE c.event_id = 42");
  });

  it("stops at the first error and reads every section in one read-only snapshot (DB-13)", () => {
    const lines = script.split("\n");
    expect(lines[0]).toBe("\\set ON_ERROR_STOP on");
    expect(lines[1]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;");
    expect(lines.indexOf("COMMIT;")).toBeGreaterThan(lines.findLastIndex((l) => l.startsWith("\\copy ")));
    expect(lines.filter(Boolean).at(-1)).toBe(`\\echo ${BACKUP_COMPLETE_MARKER}`);
  });

  it("dumps the journal, not the renamed event_log (DB-13)", () => {
    expect(BACKUP_TABLES).toContain("journal");
    expect(BACKUP_TABLES).not.toContain("event_log" as never);
    expect(script).toContain("SELECT * FROM oxygen.journal WHERE event_id = 42 ORDER BY ingest_seq");
  });

  it("filters the per-document colour settings to the event's documents", () => {
    const line = script.split("\n").find((l) => l.includes("FROM oxygen.map_document_colour_settings"))!;
    expect(line).toContain("f.document_hash FROM oxygen.map_files f WHERE f.event_id = 42");
    expect(line).toContain("p.document_hash FROM oxygen.map_patches p WHERE p.event_id = 42");
  });

  it("restores in foreign-key order: readouts, cards, runners; units, punches; templates, classes (DB-14)", () => {
    const i = (t: string) => BACKUP_TABLES.indexOf(t as (typeof BACKUP_TABLES)[number]);
    expect(i("card_readouts")).toBeLessThan(i("cards"));
    expect(i("cards")).toBeLessThan(i("runners"));
    expect(i("control_units")).toBeLessThan(i("punches"));
    expect(i("map_templates")).toBeLessThan(i("classes"));
    expect(i("controls")).toBeLessThan(i("courses"));
  });

  it("never both dumps and excludes a table", () => {
    for (const t of Object.keys(BACKUP_EXCLUDED)) expect(BACKUP_TABLES).not.toContain(t as never);
  });

  it("rejects a non-integer id", () => {
    expect(() => buildBackupScript(-1n)).toThrow();
  });
});

describe("splitBackupSections", () => {
  it("returns each section's CSV keyed by table, header comment ignored", () => {
    const dump = [
      "-- Oxygen backup",
      "-- Event: x",
      "",
      "--- events ---",
      "id,name_id",
      "7,x",
      "--- map_sources ---",
      "file_hash,kind,bytes",
      'aa,ocad,\\x0102',
      "--- map_documents ---",
      "hash,bytes",
      "",
    ].join("\n");
    const sections = splitBackupSections(dump);
    expect([...sections.keys()]).toEqual(["events", "map_sources", "map_documents"]);
    expect(sections.get("events")).toBe("id,name_id\n7,x\n");
    expect(sections.get("map_sources")).toBe("file_hash,kind,bytes\naa,ocad,\\x0102\n");
    expect(sections.get("map_documents")).toBe("hash,bytes\n");
  });

  it("keeps a quoted value that spans lines, even one that looks like a separator", () => {
    const sections = splitBackupSections('--- runners ---\nid,club_name\n1,"OK ""Linné""\n--- teams ---\n-- BACKUP COMPLETE"\n--- teams ---\nid\n');
    expect(sections.get("runners")).toBe('id,club_name\n1,"OK ""Linné""\n--- teams ---\n-- BACKUP COMPLETE"\n');
    expect(sections.get("teams")).toBe("id\n");
  });

  it("stops at the completion marker", () => {
    const sections = splitBackupSections(`--- events ---\nid\n1\n${BACKUP_COMPLETE_MARKER}\n`);
    expect(sections.get("events")).toBe("id\n1\n");
  });

  it("stops at a failure trailer", () => {
    const sections = splitBackupSections("--- events ---\nid\n1\n\n-- BACKUP FAILED (exit 2): nope\n");
    expect(sections.get("events")).toBe("id\n1\n");
  });
});

describe("parseDatabaseUrl (BLD-01)", () => {
  it("takes the Cloud SQL socket directory from ?host= (scripts/gcp/provision.sh)", () => {
    const p = parseDatabaseUrl("postgresql://oxygen:p%40ss@localhost/oxygen?host=/cloudsql/proj:europe-north1:oxygen-db&schema=oxygen");
    expect(p.host).toBe("/cloudsql/proj:europe-north1:oxygen-db");
    expect(p.port).toBe(5432);
    expect(p.user).toBe("oxygen");
    expect(p.password).toBe("p@ss");
    expect(p.database).toBe("oxygen");
    expect(p.schema).toBe("oxygen");
  });

  it("reads a plain TCP URL", () => {
    const p = parseDatabaseUrl("postgresql://u:pw@db.example:6543/oxy?schema=oxygen");
    expect(p).toMatchObject({ host: "db.example", port: 6543, user: "u", password: "pw", database: "oxy" });
    expect(p.sslmode).toBeUndefined();
  });

  it("passes sslmode and the password through the environment, never argv", () => {
    const p = parseDatabaseUrl("postgresql://u:secret@db.example/oxy?sslmode=require");
    const { args, env } = psqlInvocation(p, ["-f", "-"]);
    expect(args).toEqual(["-h", "db.example", "-p", "5432", "-d", "oxy", "-U", "u", "-X", "-q", "-f", "-"]);
    expect(args.join(" ")).not.toContain("secret");
    expect(env.PGPASSWORD).toBe("secret");
    expect(env.PGSSLMODE).toBe("require");
  });
});

/** A stand-in psql: the test drives its stdout and exit. */
function fakeDump() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
  let exit!: (r: { code: number | null; stderr: string }) => void;
  const exited = new Promise<{ code: number | null; stderr: string }>((r) => (exit = r));
  const proc = { child, stdout, stderr, exited } as unknown as PgDumpProcess;
  return { proc, stdout, child, exit };
}

const TARGET: BackupEvent = {
  id: 7n, nameId: "x", name: "X", date: new Date("2026-05-01T00:00:00Z"), zeroTime: 0, timeZone: "Europe/Stockholm", annotation: "",
};

async function collect(stream: Readable): Promise<{ text: string; error: Error | null }> {
  let text = "";
  try {
    for await (const chunk of stream) text += String(chunk);
    return { text, error: null };
  } catch (err) {
    return { text, error: err as Error };
  }
}

describe("startBackupStream", () => {
  it("answers a failure, not a file, when psql exits before any output (BLD-01)", async () => {
    const f = fakeDump();
    const log = { error: vi.fn(), warn: vi.fn() };
    const started = startBackupStream(TARGET, log, new Date(), () => f.proc);
    f.stdout.end();
    f.exit({ code: 2, stderr: "psql: error: connection to server failed: Connection refused\n" });
    const res = await started;
    expect(res).toEqual({ ok: false, code: 2, detail: "psql: error: connection to server failed: Connection refused" });
    expect(log.error).toHaveBeenCalledOnce();
  });

  it("streams header then psql's output, and ends on a clean exit", async () => {
    const f = fakeDump();
    const started = startBackupStream(TARGET, undefined, new Date(), () => f.proc);
    f.stdout.write("--- events ---\n");
    const res = await started;
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const body = collect(res.stream);
    f.stdout.end(`id\n7\n${BACKUP_COMPLETE_MARKER}\n`);
    f.exit({ code: 0, stderr: "" });
    const { text, error } = await body;
    expect(error).toBeNull();
    expect(text.startsWith("-- Oxygen backup")).toBe(true);
    expect(text).toContain("--- events ---\nid\n7\n");
    expect(text.trimEnd().endsWith(BACKUP_COMPLETE_MARKER)).toBe(true);
  });

  it("writes the trailer and then fails the stream when psql fails mid-dump (DB-13)", async () => {
    const f = fakeDump();
    const log = { error: vi.fn(), warn: vi.fn() };
    const started = startBackupStream(TARGET, log, new Date(), () => f.proc);
    f.stdout.write("--- events ---\nid\n7\n");
    const res = await started;
    if (!res.ok) throw new Error("expected a stream");
    const body = collect(res.stream);
    f.stdout.end();
    f.exit({ code: 3, stderr: 'psql:<stdin>:9: ERROR:  relation "oxygen.event_log" does not exist\n' });
    const { text, error } = await body;
    expect(text).toContain('-- BACKUP FAILED (exit 3): psql:<stdin>:9: ERROR:  relation "oxygen.event_log" does not exist');
    expect(error).not.toBeNull();
    expect(log.error).toHaveBeenCalledOnce();
  });

  it("kills psql when the client goes away (SYNC-36)", async () => {
    const f = fakeDump();
    const started = startBackupStream(TARGET, undefined, new Date(), () => f.proc);
    f.stdout.write("--- events ---\n");
    const res = await started;
    if (!res.ok) throw new Error("expected a stream");
    res.stream.destroy();
    await new Promise((r) => setImmediate(r));
    expect(f.child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("pipes with backpressure: psql's stdout pauses while the client is not reading (SYNC-36)", async () => {
    const f = fakeDump();
    const started = startBackupStream(TARGET, undefined, new Date(), () => f.proc);
    f.stdout.write("x");
    const res = await started;
    if (!res.ok) throw new Error("expected a stream");
    // Nobody reads the response: once its buffer is full, the pipe stops reading psql.
    const big = "y".repeat(64 * 1024);
    for (let i = 0; i < 16; i++) f.stdout.write(big);
    await new Promise((r) => setImmediate(r));
    expect(f.stdout.isPaused() || f.stdout.readableFlowing === false).toBe(true);
    res.stream.destroy();
  });
});
