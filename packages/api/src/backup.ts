/**
 * Competition database backup.
 *
 * Streams a `mysqldump` of a competition database to the caller, prefixed
 * with a header comment that records which `MeOSMain.oEvent` row this
 * backup was taken for. The header also includes a ready-to-run (commented)
 * INSERT statement so the user can re-register the competition in MeOSMain
 * after a restore — important because Oxygen drops the registry pointer on
 * delete/purge, so a raw `mysql < backup.sql` restore would otherwise leave
 * the database invisible to the UI.
 *
 * Output format:
 *
 *     -- Oxygen backup
 *     -- Created:    <ISO timestamp>
 *     -- Database:   <NameId>
 *     -- Name:       <Name>
 *     -- Date:       <Date>
 *     ...
 *     -- To restore:
 *     --   mysql -u <user> <NameId> < this-file.sql
 *     --   <run the INSERT below against MeOSMain to re-register>
 *     --
 *     -- INSERT INTO MeOSMain.oEvent (...) VALUES (...);
 *
 *     <mysqldump output>
 *
 * On a non-zero `mysqldump` exit code the stream is terminated with a
 * trailing `-- BACKUP FAILED: ...` line so a partial download can be
 * detected after the fact.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { PassThrough, Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import type { RowDataPacket } from "mysql2/promise";
import {
  getCompetitionConnectionParams,
  getMainDbConnection,
} from "./db.js";

// ─── Types ─────────────────────────────────────────────────

export interface BackupRow {
  Id: number;
  Name: string;
  NameId: string;
  Date: string;
  ZeroTime: number;
  Annotation: string;
  Version: number;
}

export interface BackupConnectionParams {
  host: string;
  port: number;
  user?: string;
  password?: string;
  database: string;
}

export interface BackupTarget {
  row: BackupRow;
  params: BackupConnectionParams;
}

// ─── Metadata lookup ───────────────────────────────────────

/**
 * Look up the live `MeOSMain.oEvent` row + connection parameters for a
 * given competition NameId. Returns null if the row does not exist or is
 * soft-deleted (Removed=1) — soft-deleted competitions are not safe to
 * back up because the underlying database may already have been dropped.
 */
export async function getBackupTarget(
  nameId: string,
): Promise<BackupTarget | null> {
  if (!nameId || !/^[A-Za-z0-9_]+$/.test(nameId)) {
    return null;
  }
  const conn = await getMainDbConnection();
  let row: BackupRow | null = null;
  try {
    const [rows] = await conn.execute<RowDataPacket[]>(
      `SELECT Id, Name, NameId, Date, ZeroTime, Annotation, Version
         FROM oEvent
        WHERE NameId = ? AND Removed = 0`,
      [nameId],
    );
    if (Array.isArray(rows) && rows.length > 0) {
      const r = rows[0];
      row = {
        Id: Number(r.Id),
        Name: String(r.Name ?? ""),
        NameId: String(r.NameId ?? ""),
        Date: String(r.Date ?? ""),
        ZeroTime: Number(r.ZeroTime ?? 0),
        Annotation: String(r.Annotation ?? ""),
        Version: Number(r.Version ?? 0),
      };
    }
  } finally {
    await conn.end();
  }

  if (!row) return null;

  const params = await getCompetitionConnectionParams(nameId);
  return { row, params };
}

// ─── Filename + header ────────────────────────────────────

/**
 * Build the suggested download filename: `<NameId>_backup_<YYYYMMDD_HHMMSS>.sql`.
 * Uses local time so the filename matches existing manual backups in the
 * `~/backup/mysql/` convention.
 */
export function buildBackupFilename(nameId: string, when: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts =
    `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}` +
    `_${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`;
  // Strip anything that's not safe in a filename — NameId is already
  // sanitised at creation time but be defensive.
  const safe = nameId.replace(/[^A-Za-z0-9_-]/g, "_");
  return `${safe}_backup_${ts}.sql`;
}

/** Escape a string literal for inclusion in a SQL `'...'` value. */
function sqlEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * Build the SQL header (comment block + commented MeOSMain INSERT) that
 * precedes the mysqldump output.
 */
export function buildBackupHeader(row: BackupRow, when: Date = new Date()): string {
  const insert =
    `INSERT INTO MeOSMain.oEvent (Name, Date, NameId, Annotation, ZeroTime, Version, Removed) VALUES (` +
    `'${sqlEscape(row.Name)}', ` +
    `'${sqlEscape(row.Date)}', ` +
    `'${sqlEscape(row.NameId)}', ` +
    `'${sqlEscape(row.Annotation)}', ` +
    `${row.ZeroTime}, ` +
    `${row.Version}, ` +
    `0);`;

  return [
    `-- Oxygen backup`,
    `-- Created:    ${when.toISOString()}`,
    `-- Database:   ${row.NameId}`,
    `-- Name:       ${row.Name}`,
    `-- Date:       ${row.Date}`,
    `-- ZeroTime:   ${row.ZeroTime}`,
    `-- Version:    ${row.Version}`,
    `-- Annotation: ${row.Annotation}`,
    `--`,
    `-- To restore:`,
    `--   1. Recreate the database (drop first if it exists):`,
    `--        mysql -e "CREATE DATABASE \\\`${row.NameId}\\\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"`,
    `--   2. Load the dump:`,
    `--        mysql ${row.NameId} < this-file.sql`,
    `--   3. Re-register in MeOSMain by uncommenting and running the INSERT below:`,
    `--`,
    `-- ${insert}`,
    ``,
    ``,
  ].join("\n");
}

// ─── mysqldump child process ──────────────────────────────

export interface MysqldumpProcess {
  child: ChildProcessByStdio<null, Readable, Readable>;
  stdout: Readable;
  stderr: Readable;
  /** Resolves with the exit code and captured stderr text after the child exits. */
  exited: Promise<{ code: number | null; stderr: string }>;
}

/**
 * Spawn `mysqldump` for the given connection params. The password (if any)
 * is passed via the `MYSQL_PWD` environment variable so it does not appear
 * on the command line / in process listings.
 */
export function spawnMysqldump(params: BackupConnectionParams): MysqldumpProcess {
  const args: string[] = [
    "--no-tablespaces",
    "--routines=0",
    "--triggers=0",
    "--default-character-set=utf8mb4",
    `-h${params.host}`,
    `-P${String(params.port)}`,
  ];
  if (params.user) args.push(`-u${params.user}`);
  args.push(params.database);

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (params.password) env.MYSQL_PWD = params.password;
  else delete env.MYSQL_PWD;

  const child = spawn("mysqldump", args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderrText = "";
  child.stderr.on("data", (chunk) => {
    stderrText += String(chunk);
    if (stderrText.length > 4096) {
      stderrText = stderrText.slice(-4096);
    }
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

// ─── Stream composition ───────────────────────────────────

/**
 * Build a Readable stream that emits the header followed by the mysqldump
 * output for the given target. On dump failure, a trailing
 * `-- BACKUP FAILED: <stderr>` marker is appended before the stream ends.
 */
export function createBackupStream(
  target: BackupTarget,
  when: Date = new Date(),
): Readable {
  const out = new PassThrough();
  out.write(buildBackupHeader(target.row, when));

  const dump = spawnMysqldump(target.params);
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

// ─── Fastify route ────────────────────────────────────────

/**
 * Register `GET /api/backup/competition?name=<NameId>` on the given server.
 * Streams a `.sql` backup to the caller as a file download.
 */
export function registerBackupRoute(server: FastifyInstance): void {
  server.get<{ Querystring: { name?: string } }>(
    "/api/backup/competition",
    async (req, reply) => {
      const name = (req.query.name ?? "").trim();
      if (!name) {
        return reply.code(400).send({ error: "Missing 'name' query parameter" });
      }
      if (!/^[A-Za-z0-9_]+$/.test(name)) {
        return reply.code(400).send({ error: "Invalid competition name" });
      }

      const target = await getBackupTarget(name);
      if (!target) {
        return reply
          .code(404)
          .send({ error: `Competition "${name}" not found` });
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
