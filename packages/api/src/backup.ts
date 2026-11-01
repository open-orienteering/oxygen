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
    `INSERT INTO oxygen.events (name_id, name, date, zero_time, annotation) VALUES (` +
    `'${sqlEscape(row.nameId)}', ` +
    `'${sqlEscape(row.name)}', ` +
    `'${dateStr}', ` +
    `${row.zeroTime}, ` +
    `'${sqlEscape(row.annotation)}');`;
  return [
    `-- Oxygen backup`,
    `-- Created:    ${when.toISOString()}`,
    `-- Event:      ${row.nameId}`,
    `-- Name:       ${row.name}`,
    `-- Date:       ${dateStr}`,
    `-- ZeroTime:   ${row.zeroTime}`,
    `-- Annotation: ${row.annotation}`,
    `--`,
    `-- This is a per-event dump filtered to event_id = ${row.id}.`,
    `-- To restore:`,
    `--   1. Apply the latest oxygen schema migration on a fresh database.`,
    `--   2. Run the INSERT below to recreate the event row, capturing the`,
    `--      new id (BIGSERIAL): the dump references the original id, which`,
    `--      you'll need to rewrite via sed before loading the data.`,
    `--`,
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

interface PgConnectionParams {
  host: string;
  port: number;
  user?: string;
  password?: string;
  database: string;
  schema: string;
}

function parseDatabaseUrl(): PgConnectionParams {
  const raw = process.env.DATABASE_URL ?? "";
  const u = new URL(raw);
  const schema = u.searchParams.get("schema") ?? "oxygen";
  return {
    host: u.hostname,
    port: u.port ? parseInt(u.port, 10) : 5432,
    user: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    database: u.pathname.replace(/^\//, ""),
    schema,
  };
}

/**
 * Tables in the per-event dump, in FK-safe restore order. The blob tables
 * are not event-scoped (content-addressed, shared by every pin); the dump
 * carries the rows this event's `map_files` pin, ahead of `map_files`
 * (docs/map-storage.md §7.3). `club_symbol_decisions` is club-level state
 * a restored event's re-match reads; it travels whole (no event column,
 * and its fingerprints are not derivable in SQL). `map_previews` are a
 * cache and stay out.
 */
export const BACKUP_TABLES = [
  "events",
  "controls",
  "courses",
  "course_controls",
  "classes",
  "class_course_pools",
  "course_objects",
  "runners",
  "teams",
  "cards",
  "card_readouts",
  "punches",
  "control_units",
  "event_log",
  "map_sources",
  "map_documents",
  "club_symbol_decisions",
  "map_files",
  "rendered_maps",
  "tracks",
  "routes",
  "event_seqs",
] as const;

export type BackupTable = (typeof BACKUP_TABLES)[number];

function backupSelect(t: BackupTable, eventId: bigint): string {
  switch (t) {
    case "events":
      return `SELECT * FROM oxygen.events WHERE id = ${eventId}`;
    case "course_controls":
      return `SELECT cc.* FROM oxygen.course_controls cc JOIN oxygen.courses c ON c.id = cc.course_id WHERE c.event_id = ${eventId}`;
    case "class_course_pools":
      return `SELECT ccp.* FROM oxygen.class_course_pools ccp JOIN oxygen.classes cl ON cl.id = ccp.class_id WHERE cl.event_id = ${eventId}`;
    case "map_sources":
      // The pins' sources, and the source of every pinned document, so the
      // section is FK-complete even if a pin and its document disagree.
      return (
        `SELECT s.* FROM oxygen.map_sources s WHERE s.file_hash IN (` +
        `SELECT f.source_hash FROM oxygen.map_files f WHERE f.event_id = ${eventId} AND f.source_hash IS NOT NULL ` +
        `UNION SELECT d.source_hash FROM oxygen.map_documents d JOIN oxygen.map_files f ON f.document_hash = d.hash WHERE f.event_id = ${eventId}) ` +
        `ORDER BY s.file_hash`
      );
    case "map_documents":
      return (
        `SELECT s.* FROM oxygen.map_documents s WHERE s.hash IN (` +
        `SELECT f.document_hash FROM oxygen.map_files f WHERE f.event_id = ${eventId} AND f.document_hash IS NOT NULL) ` +
        `ORDER BY s.hash`
      );
    case "club_symbol_decisions":
      return `SELECT * FROM oxygen.club_symbol_decisions ORDER BY fingerprint, library_version`;
    default:
      return `SELECT * FROM oxygen.${t} WHERE event_id = ${eventId}`;
  }
}

/**
 * The psql script behind the dump: per table an `\echo --- <table> ---`
 * separator and a `\copy (SELECT …) TO STDOUT` in CSV with a header row.
 * pg_dump cannot filter rows, so the dump is psql COPYs.
 */
export function buildBackupScript(eventId: bigint): string {
  if (eventId < 0n) throw new Error(`invalid event id ${eventId}`);
  return BACKUP_TABLES.map(
    (t) => `\\echo --- ${t} ---\n\\copy (${backupSelect(t, eventId)}) TO STDOUT WITH (FORMAT csv, HEADER true);`,
  ).join("\n");
}

/**
 * Split a dump back into its sections: table → CSV text (header row
 * first, trailing blank lines dropped). The header comment is skipped;
 * a `-- BACKUP FAILED` trailer ends the last section.
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
  for (const line of dump.split("\n")) {
    const sep = /^--- (\S+) ---$/.exec(line);
    if (sep) {
      flush();
      table = sep[1];
      lines = [];
      continue;
    }
    if (line.startsWith("-- BACKUP FAILED")) break;
    if (table !== null) lines.push(line);
  }
  flush();
  return out;
}

export function spawnPgDump(eventId: bigint): PgDumpProcess {
  const params = parseDatabaseUrl();
  const copyStatements = buildBackupScript(eventId);

  const args: string[] = [
    "-h",
    params.host,
    "-p",
    String(params.port),
    "-d",
    params.database,
    // -q suppresses noisy headers; -X skips ~/.psqlrc; -A forces unaligned
    // output (no padding); -t hides table headers from non-\copy queries;
    // -P pager=off prevents paging.
    "-q",
    "-X",
    "-f",
    "-",
  ];
  if (params.user) args.unshift("-U", params.user);

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (params.password) env.PGPASSWORD = params.password;

  const child = spawn("psql", args, { env, stdio: ["pipe", "pipe", "pipe"] });
  // Feed the script via stdin so all \copy / \echo lines execute.
  child.stdin.end(copyStatements);

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

export function createBackupStream(
  target: BackupEvent,
  when: Date = new Date(),
): Readable {
  const out = new PassThrough();
  out.write(buildBackupHeader(target, when));

  const dump = spawnPgDump(target.id);
  dump.stdout.on("data", (chunk) => out.write(chunk));
  dump.stdout.on("error", (err) => {
    out.write(`\n-- BACKUP FAILED: ${String(err.message ?? err).slice(0, 500)}\n`);
    out.end();
  });
  void dump.exited.then(({ code, stderr }) => {
    if (code === 0) {
      out.end();
    } else {
      const detail = stderr.trim().replace(/\n+/g, " ").slice(0, 500);
      out.write(`\n-- BACKUP FAILED (exit ${code}): ${detail}\n`);
      out.end();
    }
  });
  return out;
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

export function registerBackupRoute(server: FastifyInstance): void {
  server.get<{ Querystring: { name?: string } }>(
    "/api/backup/event",
    async (req, reply) => {
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
      const filename = buildBackupFilename(name);
      const stream = createBackupStream(target);
      return reply
        .header("Content-Type", "application/sql; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="${filename}"`)
        .header("Cache-Control", "no-store")
        .send(stream);
    },
  );
  // Legacy alias kept for one transition release.
  server.get<{ Querystring: { name?: string } }>(
    "/api/backup/competition",
    async (req, reply) => {
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
      const filename = buildBackupFilename(name);
      const stream = createBackupStream(target);
      return reply
        .header("Content-Type", "application/sql; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="${filename}"`)
        .header("Cache-Control", "no-store")
        .send(stream);
    },
  );
}
