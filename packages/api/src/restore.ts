/**
 * Restore a per-event dump (packages/api/src/backup.ts) into a database on
 * the current schema (docs/ops/backup-restore.md "Restoring an event",
 * DB-14). The CLI is `src/cli/restore-event.ts`.
 *
 * The dump's sections are written as `<table>.csv` into a scratch
 * directory and loaded by psql in phases, each one transaction:
 *
 *   1. the event row (a fresh `events.id`) and every non-map section, in
 *      `BACKUP_TABLES` order, which is foreign-key order;
 *   2. the map blobs, symbol decisions and `map_files` through
 *      `scripts/restore-map-blobs.sql` (or, for a dump written before
 *      v0.6.1, `restore-legacy-map-files.sql`);
 *   3. the sections that need the blobs: per-document colour settings,
 *      the map patch and the event's colour settings;
 *   4. the GPS tracks (`restore-map-gps-tracks.sql`);
 *   5. the seq counters (`restore-event-seqs.sql`).
 *
 * Each section loads through a temp table built from its CSV header (all
 * `text`), so columns match by name and a dump from an older schema loads
 * (its extra columns are left out with a warning, missing ones take their
 * defaults). `event_id` is rewritten to the new event; every other key is
 * kept, and serial sequences are moved past the restored ids. A reference
 * to a row the dump does not carry (a user, a user group, a club map) is
 * kept only when the target holds that row, else handled as the foreign
 * key's ON DELETE action would: `SET NULL` clears it (a permission's
 * `granted_by`), `CASCADE` skips the row (the permission of a user this
 * database does not have), with a warning.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BACKUP_COMPLETE_MARKER,
  BACKUP_TABLES,
  parseDatabaseUrl,
  psqlInvocation,
  splitBackupSections,
  type BackupTable,
} from "./backup.js";

const SCRIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts");

/** Sections the dedicated scripts load (phases 2, 4, 5). */
const SCRIPT_SECTIONS: ReadonlySet<BackupTable> = new Set([
  "map_sources",
  "map_documents",
  "club_symbol_decisions",
  "map_files",
  "map_gps_tracks",
  "event_seqs",
]);

/** Sections that need the map blobs in place (phase 3). */
const MAP_EXTRA_SECTIONS: ReadonlySet<BackupTable> = new Set([
  "map_document_colour_settings",
  "map_patches",
  "map_colour_settings",
]);

/** Sections keyed by content, shared with other events: a row already present is kept. */
const SHARED_SECTIONS: ReadonlySet<BackupTable> = new Set(["map_document_colour_settings"]);

const KNOWN: ReadonlySet<string> = new Set(BACKUP_TABLES);

// ─── Checking the dump ─────────────────────────────────────

export interface CheckedDump {
  sections: Map<string, string>;
  /** Section tables this restore loads, in dump (foreign-key) order. */
  tables: BackupTable[];
  warnings: string[];
}

export type DumpCheck = { ok: true; dump: CheckedDump } | { ok: false; error: string };

/**
 * Split and vet a dump. A dump with a `-- BACKUP FAILED` trailer is
 * refused, and so is one without the completion marker that has a
 * `journal` section (written by a release that ends every dump with the
 * marker, so it was cut short). A dump from before the marker loads with
 * a warning. Sections this release does not know (`event_log`,
 * `rendered_maps` of older dumps) are skipped with a warning.
 */
export function checkDump(text: string): DumpCheck {
  if (/^-- BACKUP FAILED/m.test(text)) {
    return { ok: false, error: "the backup is incomplete: it ends with a BACKUP FAILED line (the dump failed while it was written)" };
  }
  const sections = splitBackupSections(text);
  const complete = text.split("\n").some((l) => l === BACKUP_COMPLETE_MARKER);
  const warnings: string[] = [];
  if (!complete) {
    if (sections.has("journal")) {
      return { ok: false, error: `the backup is incomplete: it does not end with "${BACKUP_COMPLETE_MARKER}" (the download was cut short)` };
    }
    warnings.push("this backup was written by an older release, which did not mark a complete dump: check that it is the whole file");
  }
  if (!sections.has("events")) return { ok: false, error: "not an Oxygen event backup: it has no events section" };
  for (const name of sections.keys()) {
    if (!KNOWN.has(name)) warnings.push(`section ${name} is not restored (no such table in this release)`);
  }
  for (const [name, csv] of sections) {
    if (!KNOWN.has(name)) continue;
    const header = csvHeader(csv);
    if (header === null) return { ok: false, error: `section ${name} has no header row` };
    const bad = header.find((c) => !/^[a-z_][a-z0-9_]*$/.test(c));
    if (bad !== undefined) return { ok: false, error: `section ${name} has an unexpected column name ${JSON.stringify(bad)}` };
  }
  const tables = BACKUP_TABLES.filter((t) => sections.has(t));
  return { ok: true, dump: { sections, tables, warnings } };
}

/** The column names of a section's CSV header row; null when the section is empty. */
export function csvHeader(csv: string): string[] | null {
  const first = csv.split("\n", 1)[0];
  if (!first) return null;
  return first.split(",").map((c) => (c.startsWith('"') && c.endsWith('"') ? c.slice(1, -1).replace(/""/g, '"') : c));
}

// ─── Generated psql scripts ────────────────────────────────

/**
 * `pg_temp.oxygen_restore_section(tbl, src, new_event, dumped, skip_conflicts)`:
 * insert the rows of temp table `src` (all text) into `oxygen.<tbl>`,
 * matching columns by name and casting to each target type. `event_id`
 * becomes `new_event`; for `events` the id is left to the sequence and
 * the new id is returned (else the row count). A single-column foreign
 * key to a table not in `dumped` is kept only when the target has the
 * row; otherwise the row is treated as if the referenced row had been
 * deleted: `ON DELETE SET NULL` clears the column, any other action
 * skips the row.
 */
const RESTORE_FUNCTION = String.raw`
CREATE FUNCTION pg_temp.oxygen_restore_section(tbl text, src text, new_event bigint, dumped text[], skip_conflicts boolean)
RETURNS bigint LANGUAGE plpgsql AS $fn$
DECLARE
  target oid := to_regclass(format('oxygen.%I', tbl));
  source oid := to_regclass(format('pg_temp.%I', src));
  r record;
  ref record;
  cols text[] := '{}';
  exprs text[] := '{}';
  conds text[] := '{}';
  e text;
  dropped text[];
  total bigint;
  n bigint;
  mx bigint;
  lv bigint;
  new_id bigint;
BEGIN
  IF target IS NULL THEN
    RAISE EXCEPTION 'table oxygen.% does not exist: run pnpm db:migrate on this database first', tbl;
  END IF;
  SELECT array_agg(s.attname::text ORDER BY s.attnum) INTO dropped
    FROM pg_attribute s
   WHERE s.attrelid = source AND s.attnum > 0 AND NOT s.attisdropped
     AND NOT EXISTS (SELECT 1 FROM pg_attribute a
                      WHERE a.attrelid = target AND a.attname = s.attname AND a.attnum > 0 AND NOT a.attisdropped);
  IF dropped IS NOT NULL THEN
    RAISE WARNING '%: columns of the backup this schema does not have, left out: %', tbl, array_to_string(dropped, ', ');
  END IF;
  FOR r IN
    SELECT a.attnum, a.attname, format_type(a.atttypid, a.atttypmod) AS typ, a.attnotnull
      FROM pg_attribute a
      JOIN pg_attribute s ON s.attrelid = source AND s.attname = a.attname AND s.attnum > 0 AND NOT s.attisdropped
     WHERE a.attrelid = target AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
     ORDER BY a.attnum
  LOOP
    IF tbl = 'events' AND r.attname = 'id' THEN CONTINUE; END IF;
    IF tbl <> 'events' AND r.attname = 'event_id' THEN
      e := format('%s::bigint', new_event);
    ELSE
      e := format('s.%I::%s', r.attname, r.typ);
    END IF;
    SELECT fc.relname AS reftbl, fa.attname AS refcol, c.confdeltype AS ondelete INTO ref
      FROM pg_constraint c
      JOIN pg_class fc ON fc.oid = c.confrelid
      JOIN pg_attribute fa ON fa.attrelid = c.confrelid AND fa.attnum = c.confkey[1]
     WHERE c.contype = 'f' AND c.conrelid = target AND cardinality(c.conkey) = 1 AND c.conkey[1] = r.attnum
       AND NOT (fc.relname::text = ANY (dumped))
     LIMIT 1;
    IF FOUND THEN
      -- As if the missing row had been deleted: ON DELETE SET NULL clears
      -- the reference, anything else (cascade, restrict) drops the row.
      IF r.attnotnull OR ref.ondelete <> 'n' THEN
        conds := conds || format('(%s IS NULL OR EXISTS (SELECT 1 FROM oxygen.%I x WHERE x.%I = %s))', e, ref.reftbl, ref.refcol, e);
      ELSE
        e := format('(SELECT x.%I FROM oxygen.%I x WHERE x.%I = %s)', ref.refcol, ref.reftbl, ref.refcol, e);
      END IF;
    END IF;
    cols := cols || quote_ident(r.attname);
    exprs := exprs || e;
  END LOOP;

  EXECUTE format('SELECT count(*) FROM pg_temp.%I', src) INTO total;
  IF tbl = 'events' THEN
    IF total <> 1 THEN
      RAISE EXCEPTION 'the events section holds % rows, expected 1', total;
    END IF;
    EXECUTE format('INSERT INTO oxygen.events (%s) SELECT %s FROM pg_temp.%I s RETURNING id',
                   array_to_string(cols, ', '), array_to_string(exprs, ', '), src) INTO new_id;
    RETURN new_id;
  END IF;

  EXECUTE format('INSERT INTO oxygen.%I (%s) SELECT %s FROM pg_temp.%I s%s%s',
                 tbl, array_to_string(cols, ', '), array_to_string(exprs, ', '), src,
                 CASE WHEN cardinality(conds) > 0 THEN ' WHERE ' || array_to_string(conds, ' AND ') ELSE '' END,
                 CASE WHEN skip_conflicts THEN ' ON CONFLICT DO NOTHING' ELSE '' END);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n < total THEN
    RAISE WARNING '%: % of % rows restored (% skipped: %)', tbl, n, total, total - n,
      CASE WHEN skip_conflicts THEN 'already present' ELSE 'they reference users or groups this database does not have' END;
  END IF;

  -- Kept serial ids: move each sequence past them.
  FOR r IN
    SELECT a.attname, pg_get_serial_sequence(format('oxygen.%I', tbl), a.attname) AS seq
      FROM pg_attribute a
     WHERE a.attrelid = target AND a.attnum > 0 AND NOT a.attisdropped
  LOOP
    CONTINUE WHEN r.seq IS NULL;
    EXECUTE format('SELECT max(%I)::bigint FROM oxygen.%I', r.attname, tbl) INTO mx;
    CONTINUE WHEN mx IS NULL;
    EXECUTE format('SELECT last_value FROM %s', r.seq) INTO lv;
    PERFORM setval(r.seq, GREATEST(mx, lv));
  END LOOP;
  RETURN n;
END
$fn$;
`;

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function sqlArray(names: readonly string[]): string {
  return `ARRAY[${names.map((n) => `'${n}'`).join(", ")}]::text[]`;
}

/** Create `restore_<t>` from the section's header and \copy `<t>.csv` into it. */
function loadSection(t: BackupTable, csv: string): string {
  const header = csvHeader(csv)!;
  return [
    `CREATE TEMP TABLE restore_${t} (${header.map((c) => `${quoteIdent(c)} text`).join(", ")}) ON COMMIT DROP;`,
    `\\copy restore_${t} FROM '${t}.csv' WITH (FORMAT csv, HEADER true)`,
  ].join("\n");
}

function insertSection(t: BackupTable, dumped: readonly string[]): string {
  return (
    `SELECT pg_temp.oxygen_restore_section('${t}', 'restore_${t}', :new_event_id, ${sqlArray(dumped)}, ` +
    `${SHARED_SECTIONS.has(t)}) AS restored_${t} \\gset`
  );
}

/** The tables whose rows are in the dump (references to them are restored, not looked up). */
function dumpedTables(dump: CheckedDump): string[] {
  return dump.tables.slice();
}

/** The marker phase 1 prints with the new event id. */
export const RESTORED_EVENT_ID_PREFIX = "restored-event-id ";

/**
 * Phase 1: the event row and every section not loaded by a dedicated
 * script or after the blobs. Refuses when the target already has an
 * event of the dump's `name_id`, unless `replace`, which deletes that
 * event (and, by cascade, all its rows) first. One transaction.
 */
export function buildCoreRestoreScript(dump: CheckedDump, opts: { replace: boolean }): string {
  const dumped = dumpedTables(dump);
  const parts: string[] = [`\\set ON_ERROR_STOP on`, `BEGIN;`, RESTORE_FUNCTION, loadSection("events", dump.sections.get("events")!)];
  if (opts.replace) {
    parts.push(`DELETE FROM oxygen.events e USING restore_events s WHERE e.name_id = s.name_id;`);
  } else {
    parts.push(
      `DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM oxygen.events e JOIN restore_events s ON s.name_id = e.name_id) THEN
    RAISE EXCEPTION 'event % already exists in this database: pass --replace to delete it and restore the backup in its place',
      (SELECT name_id FROM restore_events LIMIT 1);
  END IF;
END $$;`,
    );
  }
  parts.push(`SELECT pg_temp.oxygen_restore_section('events', 'restore_events', NULL, ${sqlArray(dumped)}, false) AS new_event_id \\gset`);
  for (const t of dump.tables) {
    if (t === "events" || SCRIPT_SECTIONS.has(t) || MAP_EXTRA_SECTIONS.has(t)) continue;
    parts.push(loadSection(t, dump.sections.get(t)!), insertSection(t, dumped));
  }
  parts.push(`COMMIT;`, `\\echo ${RESTORED_EVENT_ID_PREFIX}:new_event_id`, ``);
  return parts.join("\n");
}

/** Phase 3: the sections that need the map blobs. Null when the dump has none. Run with `-v new_event_id=<id>`. */
export function buildMapExtrasScript(dump: CheckedDump): string | null {
  const tables = dump.tables.filter((t) => MAP_EXTRA_SECTIONS.has(t));
  if (tables.length === 0) return null;
  const dumped = dumpedTables(dump);
  const parts: string[] = [`\\set ON_ERROR_STOP on`, `BEGIN;`, RESTORE_FUNCTION];
  for (const t of tables) parts.push(loadSection(t, dump.sections.get(t)!), insertSection(t, dumped));
  parts.push(`COMMIT;`, ``);
  return parts.join("\n");
}

// ─── Restore plan ──────────────────────────────────────────

export type RestoreStep =
  | { kind: "core" }
  | { kind: "script"; file: string; withEventId: boolean; label: string }
  | { kind: "map-extras" };

/** The phases for `dump`, in order. */
export function planRestore(dump: CheckedDump): { steps: RestoreStep[]; notes: string[] } {
  const has = (t: string) => dump.sections.has(t);
  const steps: RestoreStep[] = [{ kind: "core" }];
  const notes: string[] = [];
  const blobs = has("map_sources") && has("map_documents") && has("club_symbol_decisions");
  const legacyMapFiles = has("map_files") && (csvHeader(dump.sections.get("map_files")!) ?? []).includes("file_data");
  if (legacyMapFiles) {
    if (blobs) steps.push({ kind: "script", file: "restore-map-blobs.sql", withEventId: false, label: "map blobs" });
    steps.push({ kind: "script", file: "restore-legacy-map-files.sql", withEventId: true, label: "map file (pre-v0.6.1 backup)" });
    notes.push("the map was restored from a pre-v0.6.1 backup: run `pnpm map:rematch --event <name_id>` to import it");
  } else if (blobs && has("map_files")) {
    steps.push({ kind: "script", file: "restore-map-blobs.sql", withEventId: true, label: "map blobs and map file" });
  } else if (blobs) {
    steps.push({ kind: "script", file: "restore-map-blobs.sql", withEventId: false, label: "map blobs" });
  }
  if (dump.tables.some((t) => MAP_EXTRA_SECTIONS.has(t))) steps.push({ kind: "map-extras" });
  if (has("map_gps_tracks")) steps.push({ kind: "script", file: "restore-map-gps-tracks.sql", withEventId: true, label: "GPS tracks" });
  if (has("event_seqs")) steps.push({ kind: "script", file: "restore-event-seqs.sql", withEventId: true, label: "seq counters" });
  return { steps, notes };
}

// ─── Running it ────────────────────────────────────────────

export interface RestoreResult {
  eventId: bigint;
  warnings: string[];
  notes: string[];
}

export class RestoreError extends Error {}

export interface RestoreOptions {
  replace?: boolean;
  databaseUrl?: string;
  /** Called after each phase that succeeded, with its label and psql's stderr (warnings and notices). */
  onPhase?: (label: string, stderr: string) => void;
}

/**
 * Restore `text` (a whole dump) into the database at `databaseUrl`
 * (default `DATABASE_URL`). Throws `RestoreError` with psql's message
 * when a phase fails: phase 1 then left nothing behind; a later phase
 * leaves the event partly restored, and a rerun with `replace` starts
 * over.
 */
export function runRestore(text: string, opts: RestoreOptions = {}): RestoreResult {
  const checked = checkDump(text);
  if (!checked.ok) throw new RestoreError(checked.error);
  const dump = checked.dump;
  const { steps, notes } = planRestore(dump);
  const params = parseDatabaseUrl(opts.databaseUrl ?? process.env.DATABASE_URL ?? "");
  const dir = mkdtempSync(join(tmpdir(), "oxygen-restore-"));
  try {
    for (const [t, csv] of dump.sections) {
      if (KNOWN.has(t)) writeFileSync(join(dir, `${t}.csv`), csv);
    }
    let eventId: bigint | null = null;
    const psql = (label: string, extra: string[], input?: string): string => {
      const { args, env } = psqlInvocation(params, extra);
      const res = spawnSync("psql", args, { cwd: dir, env, input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      const stderr = res.stderr ?? "";
      if (res.error) throw new RestoreError(`${label}: could not run psql: ${res.error.message}`);
      if (res.status !== 0) {
        const where = eventId === null ? "nothing was restored" : `event ${eventId} is partly restored: rerun with --replace`;
        throw new RestoreError(`${label} failed (${where}): ${stderr.trim()}`);
      }
      opts.onPhase?.(label, stderr);
      return res.stdout ?? "";
    };
    for (const step of steps) {
      if (step.kind === "core") {
        const out = psql("event and race data", ["-f", "-"], buildCoreRestoreScript(dump, { replace: opts.replace === true }));
        const m = new RegExp(`^${RESTORED_EVENT_ID_PREFIX}(\\d+)$`, "m").exec(out);
        if (!m) throw new RestoreError(`event and race data: psql did not report the new event id (output: ${out.trim().slice(0, 200)})`);
        eventId = BigInt(m[1]);
      } else if (step.kind === "map-extras") {
        psql("map patch and colour settings", ["-v", `new_event_id=${eventId}`, "-f", "-"], buildMapExtrasScript(dump)!);
      } else {
        const extra = step.withEventId ? ["-v", `event_id=${eventId}`] : [];
        psql(step.label, [...extra, "-f", join(SCRIPTS_DIR, step.file)]);
      }
    }
    return { eventId: eventId!, warnings: dump.warnings, notes };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
