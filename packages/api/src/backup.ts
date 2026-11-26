/**
 * Event database backup endpoint.
 *
 * Streams a `pg_dump` of the active event's rows (filtered by event_id)
 * to the caller, prefixed with a header comment recording the event
 * metadata. The header includes a ready-to-run (commented) INSERT to
 * re-register the event after a restore.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { PassThrough, Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "./db.js";
import { assertRestAccess, assertRestAdmin } from "./restGuard.js";

// ─── Types ─────────────────────────────────────────────────

export interface BackupEvent {
  id: bigint;
  nameId: string;
  name: string;
  date: Date;
  zeroTime: number;
  /** IANA zone; absent on rows from before package 8 (then the default). */
  timeZone?: string;
  annotation: string;
}

// ─── Lookup ────────────────────────────────────────────────

export async function getBackupTarget(
  nameId: string,
): Promise<BackupEvent | null> {
  if (!nameId || !/^[A-Za-z0-9_-]+$/.test(nameId)) return null;
  const row = await prisma().event.findUnique({ where: { nameId } });
  if (!row || row.removed) return null;
  return {
    id: row.id,
    nameId: row.nameId,
    name: row.name,
    date: row.date,
    zeroTime: row.zeroTime,
    timeZone: row.timeZone,
    annotation: row.annotation,
  };
}

// ─── Filename + header ─────────────────────────────────────

export function buildBackupFilename(nameId: string, when: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts =
    `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}` +
    `_${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`;
  const safe = nameId.replace(/[^A-Za-z0-9_-]/g, "_");
  return `${safe}_backup_${ts}.sql`;
}

function sqlEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "''");
}

export function buildBackupHeader(row: BackupEvent, when: Date = new Date()): string {
  const dateStr = row.date.toISOString().slice(0, 10);
  const reInsert =
    `INSERT INTO oxygen.events (name_id, name, date, zero_time, time_zone, annotation) VALUES (` +
    `'${sqlEscape(row.nameId)}', ` +
    `'${sqlEscape(row.name)}', ` +
    `'${dateStr}', ` +
    `${row.zeroTime}, ` +
    `'${sqlEscape(row.timeZone ?? "Europe/Stockholm")}', ` +
    `'${sqlEscape(row.annotation)}');`;
  return [
    `-- Oxygen backup`,
    `-- Created:    ${when.toISOString()}`,
    `-- Event:      ${row.nameId}`,
    `-- Name:       ${row.name}`,
    `-- Date:       ${dateStr}`,
    `-- ZeroTime:   ${row.zeroTime}`,
    `-- TimeZone:   ${row.timeZone ?? "Europe/Stockholm"}`,
    `-- Annotation: ${row.annotation}`,
    `--`,
    `-- This is a per-event dump filtered to event_id = ${row.id}.`,
    `-- To restore (docs/ops/backup-restore.md "Restoring an event"):`,
    `--   pnpm db:migrate`,
    `--   pnpm event:restore <this file> [--replace]`,
    `-- The event row alone, for reference (the restore inserts it itself):`,
    `-- ${reInsert}`,
    ``,
    ``,
  ].join("\n");
}

// ─── pg_dump child process ─────────────────────────────────

export interface PgDumpProcess {
  child: ChildProcessByStdio<import("node:stream").Writable, Readable, Readable>;
  stdout: Readable;
  stderr: Readable;
  exited: Promise<{ code: number | null; stderr: string }>;
}

export interface PgConnectionParams {
  /** A host name or, from a `?host=` parameter, a unix socket directory. */
  host: string;
  port: number;
  user?: string;
  password?: string;
  database: string;
  schema: string;
  /** libpq `sslmode`, passed to psql as `PGSSLMODE`. */
  sslmode?: string;
}

/**
 * psql's connection from a Prisma-style `DATABASE_URL`. A `host` query
 * parameter wins over the URL's host name, as it does for `pg` and libpq:
 * on Cloud Run the URL is `…@localhost/db?host=/cloudsql/<connection>`
 * (scripts/gcp/provision.sh), and the socket directory is the only way
 * to the database (BLD-01).
 */
export function parseDatabaseUrl(raw: string = process.env.DATABASE_URL ?? ""): PgConnectionParams {
  const u = new URL(raw);
  const schema = u.searchParams.get("schema") ?? "oxygen";
  const socketHost = u.searchParams.get("host");
  const sslmode = u.searchParams.get("sslmode") ?? undefined;
  const portParam = u.searchParams.get("port");
  return {
    host: socketHost || u.hostname || "localhost",
    port: u.port ? parseInt(u.port, 10) : portParam ? parseInt(portParam, 10) : 5432,
    user: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    database: decodeURIComponent(u.pathname.replace(/^\//, "")),
    schema,
    ...(sslmode ? { sslmode } : {}),
  };
}

/** psql's argument list and environment for `params` (the password via `PGPASSWORD`, never argv). */
export function psqlInvocation(
  params: PgConnectionParams,
  extraArgs: string[],
): { args: string[]; env: NodeJS.ProcessEnv } {
  const args: string[] = ["-h", params.host, "-p", String(params.port), "-d", params.database];
  if (params.user) args.push("-U", params.user);
  // -X skips ~/.psqlrc, -q drops command tags.
  args.push("-X", "-q", ...extraArgs);
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (params.password) env.PGPASSWORD = params.password;
  if (params.sslmode) env.PGSSLMODE = params.sslmode;
  return { args, env };
}

/**
 * Tables in the per-event dump, in foreign-key order: every table comes
 * after each dumped table it references, so the sections restore in this
 * order (packages/api/src/restore.ts; an integration test checks it
 * against the migrated schema's constraints). The blob tables are not
 * event-scoped (content-addressed, shared by every pin); the dump carries
 * the rows this event's `map_files` and `map_patches` pin, ahead of
 * `map_files` (docs/map-storage.md §7.3), and the per-document colour
 * settings of those documents. `club_symbol_decisions` is club-level
 * state a restored event's re-match reads; it travels whole (no event
 * column, and its fingerprints are not derivable in SQL). The event's
 * `map_patches` row follows `map_files` (docs/map-patches.md §3.5), its
 * GPS tracks follow it (docs/map-gps-tracks.md §1.3). Event-scoped tables
 * left out are listed, with the reason, in `BACKUP_EXCLUDED`.
 */
export const BACKUP_TABLES = [
  "events",
  "controls",
  "courses",
  "course_controls",
  "map_templates",
  "classes",
  "class_course_pools",
  "course_objects",
  "course_maps",
  "card_readouts",
  "cards",
  "runners",
  "teams",
  "control_units",
  "punches",
  "card_readout_backups",
  "journal",
  "graphics",
  "map_sources",
  "map_documents",
  "map_document_colour_settings",
  "club_symbol_decisions",
  "map_files",
  "map_patches",
  "map_gps_tracks",
  "map_colour_settings",
  "tracks",
  "routes",
  "event_permissions",
  "event_seqs",
] as const;

export type BackupTable = (typeof BACKUP_TABLES)[number];

/**
 * Event-scoped tables (an `event_id` column) the dump leaves out, and why.
 * Every table with an `event_id` is in `BACKUP_TABLES` or here.
 */
export const BACKUP_EXCLUDED: Readonly<Record<string, string>> = {
  event_lease: "per-node sync state: which node holds the event; a restore would misstate it",
  journal_sync_state: "per-node shipping cursor; a restore would misstate what was shipped",
  course_presence: "ephemeral editor presence",
  map_uploads: "transient upload plumbing (chunks of an unfinished upload)",
  map_import_jobs: "transient import jobs; the restored document is already imported",
};

/** The event's map documents: pinned by `map_files` or patched by `map_patches`. */
function eventDocumentHashes(eventId: bigint): string {
  return (
    `SELECT f.document_hash FROM oxygen.map_files f WHERE f.event_id = ${eventId} AND f.document_hash IS NOT NULL ` +
    `UNION SELECT p.document_hash FROM oxygen.map_patches p WHERE p.event_id = ${eventId}`
  );
}

function backupSelect(t: BackupTable, eventId: bigint): string {
  switch (t) {
    case "events":
      return `SELECT * FROM oxygen.events WHERE id = ${eventId}`;
    case "course_controls":
      return `SELECT cc.* FROM oxygen.course_controls cc JOIN oxygen.courses c ON c.id = cc.course_id WHERE c.event_id = ${eventId}`;
    case "class_course_pools":
      return `SELECT ccp.* FROM oxygen.class_course_pools ccp JOIN oxygen.classes cl ON cl.id = ccp.class_id WHERE cl.event_id = ${eventId}`;
    case "map_sources":
      // The pins' sources, and the source of every pinned or patched
      // document, so the section is FK-complete even if a pin and its
      // document disagree.
      return (
        `SELECT s.* FROM oxygen.map_sources s WHERE s.file_hash IN (` +
        `SELECT f.source_hash FROM oxygen.map_files f WHERE f.event_id = ${eventId} AND f.source_hash IS NOT NULL ` +
        `UNION SELECT d.source_hash FROM oxygen.map_documents d JOIN oxygen.map_files f ON f.document_hash = d.hash WHERE f.event_id = ${eventId} ` +
        `UNION SELECT d.source_hash FROM oxygen.map_documents d JOIN oxygen.map_patches p ON p.document_hash = d.hash WHERE p.event_id = ${eventId}) ` +
        `ORDER BY s.file_hash`
      );
    case "map_documents":
      return `SELECT s.* FROM oxygen.map_documents s WHERE s.hash IN (${eventDocumentHashes(eventId)}) ORDER BY s.hash`;
    case "map_document_colour_settings":
      return (
        `SELECT s.* FROM oxygen.map_document_colour_settings s WHERE s.document_hash IN (${eventDocumentHashes(eventId)}) ` +
        `ORDER BY s.document_hash, s.colour_key`
      );
    case "club_symbol_decisions":
      return `SELECT * FROM oxygen.club_symbol_decisions ORDER BY fingerprint, library_version`;
    case "journal":
      return `SELECT * FROM oxygen.journal WHERE event_id = ${eventId} ORDER BY ingest_seq`;
    default:
      return `SELECT * FROM oxygen.${t} WHERE event_id = ${eventId}`;
  }
}

/** The last line of a complete dump: psql reached the end of the script and committed. */
export const BACKUP_COMPLETE_MARKER = "-- BACKUP COMPLETE";

/**
 * The psql script behind the dump: per table an `\echo --- <table> ---`
 * separator and a `\copy (SELECT …) TO STDOUT` in CSV with a header row.
 * pg_dump cannot filter rows, so the dump is psql COPYs. The script stops
 * at the first error (DB-13), and reads every section in one read-only
 * repeatable-read transaction, so a dump taken during readout is one
 * consistent snapshot. Its last line is `BACKUP_COMPLETE_MARKER`: a dump
 * without it was cut short.
 */
export function buildBackupScript(eventId: bigint): string {
  if (eventId < 0n) throw new Error(`invalid event id ${eventId}`);
  return [
    `\\set ON_ERROR_STOP on`,
    `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;`,
    ...BACKUP_TABLES.map(
      (t) => `\\echo --- ${t} ---\n\\copy (${backupSelect(t, eventId)}) TO STDOUT WITH (FORMAT csv, HEADER true);`,
    ),
    `COMMIT;`,
    `\\echo ${BACKUP_COMPLETE_MARKER}`,
    ``,
  ].join("\n");
}

/**
 * Split a dump back into its sections: table → CSV text (header row
 * first, trailing blank lines dropped). The header comment is skipped;
 * a `-- BACKUP FAILED` trailer or the completion marker ends the last
 * section.
 */
export function splitBackupSections(dump: string): Map<string, string> {
  const out = new Map<string, string>();
  let table: string | null = null;
  let lines: string[] = [];
  const flush = () => {
    if (table === null) return;
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    out.set(table, lines.map((l) => `${l}\n`).join(""));
  };
  // Inside a quoted CSV field that spans lines (a value with a newline),
  // a line is data even when it looks like a separator: CSV doubles a
  // quote inside a field, so an odd count of quotes on a line toggles.
  let inQuote = false;
  for (const line of dump.split("\n")) {
    if (inQuote) {
      lines.push(line);
      if ((line.split('"').length - 1) % 2 === 1) inQuote = false;
      continue;
    }
    const sep = /^--- (\S+) ---$/.exec(line);
    if (sep) {
      flush();
      table = sep[1];
      lines = [];
      continue;
    }
    if (line.startsWith("-- BACKUP FAILED") || line === BACKUP_COMPLETE_MARKER) break;
    if (table !== null) {
      lines.push(line);
      if ((line.split('"').length - 1) % 2 === 1) inQuote = true;
    }
  }
  flush();
  return out;
}

export function spawnPgDump(eventId: bigint): PgDumpProcess {
  const { args, env } = psqlInvocation(parseDatabaseUrl(), ["-f", "-"]);
  const child = spawn("psql", args, { env, stdio: ["pipe", "pipe", "pipe"] });
  // psql that fails to connect closes stdin early; the write error is the
  // exit's to report.
  child.stdin.on("error", () => {});
  // Feed the script via stdin so all \copy / \echo lines execute.
  child.stdin.end(buildBackupScript(eventId));

  let stderrText = "";
  child.stderr.on("data", (chunk) => {
    stderrText += String(chunk);
    if (stderrText.length > 4096) stderrText = stderrText.slice(-4096);
  });

  const exited = new Promise<{ code: number | null; stderr: string }>(
    (resolve) => {
      child.on("close", (code) => resolve({ code, stderr: stderrText }));
      child.on("error", (err) => {
        stderrText += `\n${err.message}`;
        resolve({ code: -1, stderr: stderrText });
      });
    },
  );

  return { child, stdout: child.stdout, stderr: child.stderr, exited };
}

// ─── Stream composition ────────────────────────────────────

/** Where the dump logs psql's stderr (Fastify's logger in the route). */
export interface BackupLogger {
  error(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export type BackupStart =
  | { ok: true; stream: Readable }
  | { ok: false; code: number | null; detail: string };

function oneLine(stderr: string): string {
  return stderr.trim().replace(/\n+/g, " ").slice(0, 500);
}

/**
 * Start the dump and wait for psql's first output (or its exit). A psql
 * that fails before writing anything (no connection, bad credentials)
 * resolves `{ ok: false }`, so the route answers an error instead of a
 * file (BLD-01). Once output flows the stream is returned: psql's stdout
 * is piped into it with backpressure, a later failure writes the
 * `-- BACKUP FAILED` trailer and then destroys the stream so the download
 * fails visibly, and a stream closed early (the client went away) kills
 * psql (SYNC-36). Any stderr is logged.
 */
export function startBackupStream(
  target: BackupEvent,
  log?: BackupLogger,
  when: Date = new Date(),
  spawnDump: (eventId: bigint) => PgDumpProcess = spawnPgDump,
): Promise<BackupStart> {
  const dump = spawnDump(target.id);
  let running = true;
  void dump.exited.then(({ code, stderr }) => {
    running = false;
    if (stderr.trim() && log) {
      (code === 0 ? log.warn : log.error).call(log, { event: target.nameId, code, stderr: oneLine(stderr) }, "event backup: psql stderr");
    }
  });

  return new Promise<BackupStart>((resolve) => {
    let started = false;
    const onFirst = (chunk: Buffer) => {
      started = true;
      const out = new PassThrough();
      out.write(buildBackupHeader(target, when));
      out.write(chunk);
      dump.stdout.pipe(out, { end: false });
      out.on("close", () => {
        if (running) dump.child.kill("SIGTERM");
      });
      void dump.exited.then(({ code, stderr }) => {
        if (out.destroyed) return;
        if (code === 0) {
          out.end();
          return;
        }
        out.write(`\n-- BACKUP FAILED (exit ${code}): ${oneLine(stderr)}\n`);
        // Let the trailer flush, then fail the transfer.
        setImmediate(() => out.destroy(new Error(`event backup failed (psql exit ${code})`)));
      });
      resolve({ ok: true, stream: out });
    };
    dump.stdout.once("data", onFirst);
    void dump.exited.then(({ code, stderr }) => {
      if (started) return;
      dump.stdout.off("data", onFirst);
      resolve({ ok: false, code, detail: oneLine(stderr) });
    });
  });
}

// ─── Fastify route ─────────────────────────────────────────

async function authorizeEventBackup(
  req: FastifyRequest,
  reply: FastifyReply,
  name: string,
): Promise<boolean> {
  if (
    !(await assertRestAccess(req, reply, { nameId: name, cap: "event.manage" }))
  ) {
    return false;
  }
  const event = await prisma().event.findUnique({
    where: { nameId: name },
    select: { id: true },
  });
  if (!event) return true;
  const map = await prisma().mapFile.findFirst({
    where: { eventId: event.id },
    orderBy: { uploadedAt: "desc" },
    select: { fromClubLibrary: true },
  });
  if (map?.fromClubLibrary !== true) return true;
  // The dump contains the OCAD blob. Club-library copies stay club
  // property — event.manage is not enough.
  return assertRestAdmin(req, reply);
}

export function registerBackupRoute(
  server: FastifyInstance,
  opts: { spawnDump?: (eventId: bigint) => PgDumpProcess } = {},
): void {
  const handler = async (
    req: FastifyRequest<{ Querystring: { name?: string } }>,
    reply: FastifyReply,
  ) => {
    const name = (req.query.name ?? "").trim();
    if (!name) {
      return reply.code(400).send({ error: "Missing 'name' query parameter" });
    }
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      return reply.code(400).send({ error: "Invalid event name" });
    }
    if (!(await authorizeEventBackup(req, reply, name))) {
      return;
    }
    const target = await getBackupTarget(name);
    if (!target) {
      return reply.code(404).send({ error: `Event "${name}" not found` });
    }
    const started = await startBackupStream(target, req.log, new Date(), opts.spawnDump);
    if (!started.ok) {
      return reply
        .code(502)
        .header("Cache-Control", "no-store")
        .send({ error: `Backup failed: the database dump could not start (psql exit ${started.code}). See the server log.` });
    }
    const filename = buildBackupFilename(name);
    return reply
      .header("Content-Type", "application/sql; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .header("Cache-Control", "no-store")
      .send(started.stream);
  };
  server.get<{ Querystring: { name?: string } }>("/api/backup/event", handler);
  // Legacy alias kept for one transition release.
  server.get<{ Querystring: { name?: string } }>("/api/backup/competition", handler);
}
