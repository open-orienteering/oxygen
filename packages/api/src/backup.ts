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
import type { FastifyInstance } from "fastify";
import { prisma } from "./db.js";

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

export function spawnPgDump(eventId: bigint): PgDumpProcess {
  const params = parseDatabaseUrl();
  // The per-event filter is done via --table=oxygen.events plus dependent
  // tables, then a post-process WHERE on each table. Simpler: emit each
  // entity table filtered by event_id via psql COPY. pg_dump itself can't
  // filter rows, so we wrap with psql.
  //
  // Tables that have an event_id column (single SELECT each).
  const tables = [
    "events",
    "controls",
    "courses",
    "course_controls",
    "classes",
    "class_course_pools",
    "runners",
    "teams",
    "cards",
    "card_readouts",
    "punches",
    "control_units",
    "event_log",
    "map_files",
    "rendered_maps",
    "map_tiles",
    "tracks",
    "routes",
    "event_seqs",
  ];

  // Build a single psql script that COPYs each table filtered by event_id
  // (or by foreign-key membership for tables without it).
  const copyStatements = tables
    .map((t) => {
      if (t === "events") {
        return `\\copy (SELECT * FROM oxygen.events WHERE id = ${eventId}) TO STDOUT WITH (FORMAT csv, HEADER true);`;
      }
      if (t === "event_seqs") {
        return `\\copy (SELECT * FROM oxygen.event_seqs WHERE event_id = ${eventId}) TO STDOUT WITH (FORMAT csv, HEADER true);`;
      }
      if (t === "course_controls") {
        return `\\copy (SELECT cc.* FROM oxygen.course_controls cc JOIN oxygen.courses c ON c.id = cc.course_id WHERE c.event_id = ${eventId}) TO STDOUT WITH (FORMAT csv, HEADER true);`;
      }
      if (t === "class_course_pools") {
        return `\\copy (SELECT ccp.* FROM oxygen.class_course_pools ccp JOIN oxygen.classes cl ON cl.id = ccp.class_id WHERE cl.event_id = ${eventId}) TO STDOUT WITH (FORMAT csv, HEADER true);`;
      }
      return `\\copy (SELECT * FROM oxygen.${t} WHERE event_id = ${eventId}) TO STDOUT WITH (FORMAT csv, HEADER true);`;
    })
    .map((stmt, i) => `\\echo --- ${tables[i]} ---\n${stmt}`)
    .join("\n");

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
