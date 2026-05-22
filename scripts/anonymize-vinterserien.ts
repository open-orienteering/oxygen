#!/usr/bin/env tsx
/**
 * Generate docs/screenshots/fixtures/showcase.sql from the live local
 * Vinterserien event in PostgreSQL.
 *
 * Strictly read-only on the source DB. The output is a portable SQL
 * script that scripts/load-showcase.sh feeds to `psql` to seed a fresh
 * "Demo Competition" event into the `oxygen` schema.
 *
 * Usage:
 *   pnpm tsx scripts/anonymize-vinterserien.ts
 *
 * Environment:
 *   DATABASE_URL   — source / target connection string (default:
 *                     packages/api/.env's value, or
 *                     postgresql://oxygen:oxygen@localhost:5432/oxygen?schema=oxygen)
 *   SRC_NAME_ID    — source event name_id (default: Vinterserien)
 *   MAX_ZOOM       — maximum cached tile zoom to include (default: 13).
 *                     Deeper tiles render on demand from the OCAD blob.
 *
 * Transformations:
 *   - events: rename to "Demo Competition" / "demo_competition",
 *     zero organizer contact fields, force a fresh event id.
 *   - runners: deterministic pseudonymous names, card_no remapped,
 *     PII fields (phone, eventor_person_id, …) zeroed.
 *   - cards / card_readouts / punches: card_no remapped symmetrically
 *     so card↔punch links stay intact.
 *   - card_readouts.owner_data: replaced with the runner's pseudonym
 *     (or a generic fallback).
 *   - club_directory: filtered to the subset of clubs referenced by
 *     the demo runners, with logos preserved. Emitted ON CONFLICT DO
 *     NOTHING so it never overwrites an operator's real club rows.
 *   - map_tiles: filtered to z <= MAX_ZOOM.
 *   - All BIGSERIAL ids on map_files / rendered_maps / tracks / routes
 *     are stripped from the INSERTs so Postgres allocates fresh ones
 *     against the freshly-created demo event.
 */

import { Client } from "pg";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  MALE_FIRST_NAMES,
  FEMALE_FIRST_NAMES,
  LAST_NAMES,
} from "../packages/api/src/routers/fictional-names.js";

// ─── Config ──────────────────────────────────────────────────

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://oxygen:oxygen@localhost:5432/oxygen?schema=oxygen";
const SRC_NAME_ID = process.env.SRC_NAME_ID ?? "Vinterserien";
const MAX_ZOOM = parseInt(process.env.MAX_ZOOM ?? "13", 10);
const OUT_PATH = path.resolve("docs/screenshots/fixtures/showcase.sql");
const CARD_REMAP_OFFSET = 9_000_000;

/**
 * Sentinel event id used by the fixture. High enough to never collide
 * with a real event in a long-running production database; idempotent
 * loads work by `DELETE FROM events WHERE name_id = 'demo_competition'`
 * before the INSERTs, so re-running the loader is safe.
 */
const DEMO_EVENT_ID = 9_876_543n;
const DEMO_NAME_ID = "demo_competition";
const DEMO_NAME = "Demo Competition";

// Tables we copy into the fixture, in dependency order, with the
// transform mode for each. Tables not listed here are intentionally
// excluded (event_log, eventor_event_meta, …).
type Mode =
  | "keep"
  | "anonymizeRunner"
  | "anonymizeTeam"
  | "remapCard"
  | "remapCardReadout"
  | "remapPunch"
  | "filterTiles"
  | "anonymizeEvent"
  | "stripSerialId";

/**
 * Table emission order. Each child table must come after its UUID
 * parents so the in-memory `uuidRemap` has already minted the new
 * id for every FK it references. Mismatches surface as a
 * `Cannot remap FK` exception at dump time, not as a load-time error.
 */
const TABLES: { name: string; mode: Mode; whereExtra?: string }[] = [
  { name: "events", mode: "anonymizeEvent" },
  { name: "event_seqs", mode: "keep" },
  // Geometry, courses, classes.
  { name: "controls", mode: "keep" },
  { name: "courses", mode: "keep" },
  { name: "course_controls", mode: "keep" },
  { name: "classes", mode: "keep" },
  { name: "class_course_pools", mode: "keep" },
  // Card-readout graph: card_readouts → cards → control_units →
  // punches. Runners reference cards.id so they come after.
  { name: "card_readouts", mode: "remapCardReadout" },
  { name: "cards", mode: "remapCard" },
  { name: "control_units", mode: "keep" },
  { name: "punches", mode: "remapPunch" },
  { name: "runners", mode: "anonymizeRunner" },
  { name: "teams", mode: "anonymizeTeam" },
  // Map / GPS.
  { name: "map_files", mode: "stripSerialId" },
  { name: "map_tiles", mode: "filterTiles" },
  { name: "tracks", mode: "stripSerialId" },
  { name: "routes", mode: "stripSerialId" },
];

/**
 * Per-source-UUID → per-demo-UUID rewrite table, populated lazily as
 * we emit PK rows. FK columns look up the mapping; encountering an
 * unmapped UUID throws (the table ordering is wrong).
 */
const uuidRemap = new Map<string, string>();
function remapUuid(src: string): string {
  let demo = uuidRemap.get(src);
  if (!demo) {
    demo = randomUUID();
    uuidRemap.set(src, demo);
  }
  return demo;
}
function lookupUuid(src: string): string {
  const demo = uuidRemap.get(src);
  if (!demo) {
    throw new Error(
      `Cannot remap FK uuid '${src}' — parent table emitted after child? Reorder TABLES.`,
    );
  }
  return demo;
}

// ─── Deterministic PRNG + pseudonym generator ────────────────

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickByHash<T>(arr: T[], seed: number): T {
  const rng = mulberry32(seed);
  return arr[Math.floor(rng() * arr.length)]!;
}

/**
 * Deterministic pseudonym derived from the runner's UUID. Same UUID
 * always yields the same name across regenerations so screenshots
 * stay stable.
 */
function pseudonymForUuid(uuid: string, sex: string): string {
  // Reduce the UUID hex (sans dashes) to a 32-bit seed by XOR-folding.
  const hex = uuid.replace(/-/g, "");
  let seed = 0;
  for (let i = 0; i < hex.length; i += 8) {
    seed ^= parseInt(hex.slice(i, i + 8), 16) | 0;
  }
  const firstPool =
    sex === "F" || sex === "f" ? FEMALE_FIRST_NAMES : MALE_FIRST_NAMES;
  const first = pickByHash(firstPool, seed);
  const last = pickByHash(LAST_NAMES, (seed * 40503 + 17) | 0);
  return `${first} ${last}`;
}

function remapCard(n: number | null): number {
  if (!n || n <= 0) return 0;
  return CARD_REMAP_OFFSET + (n % 900_000);
}

// ─── PostgreSQL literal escaping ─────────────────────────────

type ColumnInfo = { name: string; udt: string; dataType: string };

function escapeStringLiteral(s: string): string {
  // Use Postgres E'...' escaped strings to handle embedded newlines,
  // single quotes and backslashes uniformly.
  const escaped = s
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "''")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `E'${escaped}'`;
}

function pgLiteral(value: unknown, col: ColumnInfo): string {
  if (value === null || value === undefined) return "NULL";

  // Byte arrays → \x<hex> bytea literal.
  if (Buffer.isBuffer(value)) {
    if (value.length === 0) return "''::bytea";
    return `'\\x${value.toString("hex")}'::bytea`;
  }

  // Date/Time
  if (value instanceof Date) {
    const iso = value.toISOString();
    if (col.dataType === "date") {
      return `'${iso.slice(0, 10)}'`;
    }
    // timestamptz / timestamp
    return `'${iso}'`;
  }

  // Numbers / booleans
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "NULL";
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "boolean") {
    return value ? "TRUE" : "FALSE";
  }

  // JSON / JSONB columns come back as parsed JS objects from pg.
  if (col.udt === "jsonb" || col.udt === "json") {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return `${escapeStringLiteral(text)}::${col.udt}`;
  }

  // Enum columns: cast to `oxygen.<udt>`.
  if (col.dataType === "USER-DEFINED") {
    return `${escapeStringLiteral(String(value))}::oxygen.${col.udt}`;
  }

  // UUID / text / varchar / char / inet …
  const s = String(value);
  if (col.udt === "uuid") {
    return `'${s}'::uuid`;
  }
  return escapeStringLiteral(s);
}

// ─── Main ────────────────────────────────────────────────────

async function main(): Promise<void> {
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });

  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  await client.query("SET search_path = oxygen");

  console.log(`Connected: ${DATABASE_URL.replace(/:[^:@/]+@/, ":***@")}`);

  // ─── Find source event ───────────────────────────────
  const srcEvent = await client.query<{ id: string }>(
    "SELECT id::text FROM events WHERE name_id = $1 AND NOT removed",
    [SRC_NAME_ID],
  );
  if (srcEvent.rows.length === 0) {
    console.error(`Source event "${SRC_NAME_ID}" not found.`);
    process.exit(1);
  }
  const srcEventId = BigInt(srcEvent.rows[0]!.id);
  console.log(`Source event "${SRC_NAME_ID}" id=${srcEventId}`);

  // ─── Discover referenced clubs ───────────────────────
  const clubRows = await client.query<{ eventor_club_id: string }>(
    `SELECT DISTINCT eventor_club_id::text
       FROM runners
      WHERE event_id = $1 AND eventor_club_id IS NOT NULL`,
    [srcEventId],
  );
  const referencedClubs = clubRows.rows.map((r) => BigInt(r.eventor_club_id));
  console.log(`Referenced clubs: ${referencedClubs.length}`);

  // ─── Open output file ────────────────────────────────
  const out = fs.createWriteStream(OUT_PATH, { encoding: "utf8" });
  const write = (s: string): void => {
    out.write(s);
  };

  write(
    "-- Oxygen showcase fixture — Demo Competition (anonymized Vinterserien data)\n",
  );
  write("-- Generated by scripts/anonymize-vinterserien.ts\n");
  write(
    "-- Do not edit by hand; regenerate with `pnpm tsx scripts/anonymize-vinterserien.ts`.\n",
  );
  write("--\n");
  write(
    "-- Contains: a single \"Demo Competition\" event row, its controls /\n",
  );
  write(
    "--           courses / classes, pseudonymous runners, cards with\n",
  );
  write(
    "--           remapped CardNo, the OCAD source file, cached low-zoom\n",
  );
  write(
    `--           map tiles (z <= ${MAX_ZOOM}), and the subset of\n`,
  );
  write("--           club_directory referenced by demo runners.\n");
  write("-- Excluded: renderer caches, event_log, eventor_* caches.\n");
  write("--\n");
  write(
    `-- Load with:   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f showcase.sql\n`,
  );
  write(
    "-- The script is idempotent: it deletes any existing event with\n",
  );
  write(
    `-- name_id = '${DEMO_NAME_ID}' before re-inserting.\n\n`,
  );

  write("SET search_path = oxygen;\n");
  write("BEGIN;\n\n");
  write("-- Idempotency: cascade-delete any previous demo load.\n");
  write(
    `DELETE FROM events WHERE name_id = '${DEMO_NAME_ID}';\n\n`,
  );

  let totalRows = 0;
  let totalBytes = 0;

  // ─── club_directory (global) ─────────────────────────
  if (referencedClubs.length > 0) {
    const clubCols = await loadColumns(client, "club_directory");
    const idList = referencedClubs.map((id) => id.toString()).join(",");
    const clubData = await client.query({
      text: `SELECT * FROM club_directory WHERE eventor_id IN (${idList})`,
      rowMode: "array",
    });

    write("-- ─── club_directory (subset referenced by demo runners) ──\n");
    write("-- Loaded with ON CONFLICT DO NOTHING so operator clubs are never overwritten.\n");
    let clubsWritten = 0;
    for (const row of clubData.rows as unknown[][]) {
      const valuesSql = row
        .map((v, i) => pgLiteral(v, clubCols[i]!))
        .join(", ");
      const line =
        `INSERT INTO club_directory (` +
        clubCols.map((c) => `"${c.name}"`).join(", ") +
        `) VALUES (${valuesSql}) ON CONFLICT (eventor_id) DO NOTHING;\n`;
      write(line);
      clubsWritten++;
      totalBytes += Buffer.byteLength(line, "utf8");
    }
    write("\n");
    totalRows += clubsWritten;
    console.log(
      `  ${"club_directory".padEnd(30)} ${clubsWritten
        .toString()
        .padStart(6)} rows`,
    );
  }

  // ─── Per-event tables ────────────────────────────────
  for (const t of TABLES) {
    const cols = await loadColumns(client, t.name);

    let where = "";
    if (t.name === "events") {
      where = `WHERE id = ${srcEventId}`;
    } else if (cols.some((c) => c.name === "event_id")) {
      where = `WHERE event_id = ${srcEventId}`;
    } else {
      // Tables without event_id are joined via a parent table.
      where = scopeByJoin(t.name, srcEventId);
    }
    if (t.name === "map_tiles") {
      where += ` AND z <= ${MAX_ZOOM}`;
    }

    const result = await client.query({
      text: `SELECT * FROM ${t.name} ${where}`,
      rowMode: "array",
    });

    write(`-- ─── ${t.name} ─────────────────────────────────────\n`);

    // Filter columns we'll emit (strip BIGSERIAL ids when requested).
    const emitCols = cols.filter((c) => {
      if (t.mode === "stripSerialId" && c.name === "id") return false;
      return true;
    });
    const colIdxMap = emitCols.map((c) =>
      cols.findIndex((cc) => cc.name === c.name),
    );

    let rowsWritten = 0;
    for (const rawRow of result.rows as unknown[][]) {
      const transformed = transform(rawRow, cols, t.mode);
      if (!transformed) continue;
      // Rewrite event_id and event ID references to the demo id.
      remapEventRefs(transformed, cols, srcEventId, DEMO_EVENT_ID, t.name);
      // Rewrite every UUID column. PK columns (named "id") get a fresh
      // uuid recorded in uuidRemap; FK columns are looked up.
      rewriteUuids(transformed, cols, t.name);

      const valuesSql = colIdxMap
        .map((idx) => pgLiteral(transformed[idx], cols[idx]!))
        .join(", ");
      const line =
        `INSERT INTO ${t.name} (` +
        emitCols.map((c) => `"${c.name}"`).join(", ") +
        `) ${
          t.name === "events" ? "OVERRIDING SYSTEM VALUE " : ""
        }VALUES (${valuesSql});\n`;
      write(line);
      rowsWritten++;
      totalBytes += Buffer.byteLength(line, "utf8");
    }
    write("\n");
    totalRows += rowsWritten;
    const mb = (totalBytes / 1024 / 1024).toFixed(2);
    console.log(
      `  ${t.name.padEnd(30)} ${rowsWritten
        .toString()
        .padStart(6)} rows  (cumulative ${mb} MB)`,
    );
  }

  // ─── Sequence bookkeeping ────────────────────────────
  // The demo event id (9876543) sits above the BIGSERIAL high-water
  // mark. Bump `events_id_seq` so the next operator-created event
  // doesn't collide. BIGSERIAL-keyed dependents (map_files etc) had
  // their id columns stripped so they allocated fresh values and need
  // no nudging.
  write("-- ── Sequence bookkeeping ──────────────────────────\n");
  write(
    "DO $$\n" +
      "BEGIN\n" +
      "  PERFORM setval(\n" +
      "    pg_get_serial_sequence('oxygen.events', 'id'),\n" +
      "    GREATEST(\n" +
      "      (SELECT COALESCE(MAX(id), 1) FROM oxygen.events),\n" +
      `      ${DEMO_EVENT_ID}::bigint\n` +
      "    )\n" +
      "  );\n" +
      "END$$;\n\n",
  );

  write("COMMIT;\n");

  await new Promise<void>((resolve, reject) => {
    out.end((err?: Error | null) => (err ? reject(err) : resolve()));
  });
  await client.end();

  const sizeMb = (fs.statSync(OUT_PATH).size / 1024 / 1024).toFixed(2);
  console.log(`\nWrote ${OUT_PATH} — ${totalRows} rows, ${sizeMb} MB.`);
}

// ─── Helpers ─────────────────────────────────────────────────

async function loadColumns(
  client: Client,
  tableName: string,
): Promise<ColumnInfo[]> {
  const r = await client.query<{
    column_name: string;
    udt_name: string;
    data_type: string;
    ordinal_position: number;
  }>(
    `SELECT column_name, udt_name, data_type, ordinal_position
       FROM information_schema.columns
      WHERE table_schema = 'oxygen' AND table_name = $1
      ORDER BY ordinal_position`,
    [tableName],
  );
  if (r.rows.length === 0) {
    throw new Error(`Table oxygen.${tableName} not found`);
  }
  return r.rows.map((row) => ({
    name: row.column_name,
    udt: row.udt_name,
    dataType: row.data_type,
  }));
}

/**
 * Tables without an `event_id` column (course_controls, class_course_pools)
 * scope via their parent table.
 */
function scopeByJoin(tableName: string, srcEventId: bigint): string {
  switch (tableName) {
    case "course_controls":
      return `WHERE course_id IN (SELECT id FROM courses WHERE event_id = ${srcEventId})`;
    case "class_course_pools":
      return `WHERE class_id IN (SELECT id FROM classes WHERE event_id = ${srcEventId})`;
    default:
      throw new Error(`No scope rule for table ${tableName}`);
  }
}

function colIndex(cols: ColumnInfo[], name: string): number {
  return cols.findIndex((c) => c.name === name);
}

function transform(
  row: unknown[],
  cols: ColumnInfo[],
  mode: Mode,
): unknown[] | null {
  if (mode === "keep" || mode === "stripSerialId" || mode === "filterTiles")
    return row;

  const r = [...row];

  switch (mode) {
    case "anonymizeEvent": {
      setBy(r, cols, "name_id", DEMO_NAME_ID);
      setBy(r, cols, "name", DEMO_NAME);
      setBy(r, cols, "annotation", "");
      setBy(r, cols, "organizer_name", "Demo Orienteering Club");
      setBy(r, cols, "organizer_eventor_id", 0);
      setBy(r, cols, "email", "");
      setBy(r, cols, "homepage", "");
      setBy(r, cols, "phone", "");
      setBy(r, cols, "street", "");
      setBy(r, cols, "city", "");
      setBy(r, cols, "zip", "");
      setBy(r, cols, "org_number", "");
      setBy(r, cols, "swish_number", "");
      setBy(r, cols, "swish_payee_name", "");
      setBy(r, cols, "google_sheets_webhook_url", "");
      setBy(r, cols, "livelox_event_id", null);
      // Drop persisted Eventor wiring so demos don't try to phone home.
      setBy(r, cols, "eventor_event_id", null);
      setBy(r, cols, "eventor_last_sync", null);
      // Liveresults: similarly scrub upstream IDs / config.
      setBy(r, cols, "liveresults_tavid", null);
      setBy(r, cols, "liveresults_config", null);
      return r;
    }
    case "anonymizeRunner": {
      const idIdx = colIndex(cols, "id");
      const sexIdx = colIndex(cols, "sex");
      const uuid = String(r[idIdx]);
      const sex = String(r[sexIdx] ?? "");
      setBy(r, cols, "name", pseudonymForUuid(uuid, sex));
      const cn = numOr0(r[colIndex(cols, "card_no")]);
      setBy(r, cols, "card_no", remapCard(cn));
      setBy(r, cols, "phone", "");
      setBy(r, cols, "annotation", "");
      setBy(r, cols, "eventor_person_id", null);
      setBy(r, cols, "eventor_entry_id", null);
      // Round birth year to the nearest 5 years to coarsen demographics.
      const byIdx = colIndex(cols, "birth_year");
      const by = numOr0(r[byIdx]);
      if (by > 0) r[byIdx] = Math.round(by / 5) * 5;
      return r;
    }
    case "anonymizeTeam": {
      setBy(r, cols, "name", "Demo Team");
      setBy(r, cols, "eventor_team_id", null);
      return r;
    }
    case "remapCard": {
      const cn = numOr0(r[colIndex(cols, "card_no")]);
      setBy(r, cols, "card_no", remapCard(cn));
      return r;
    }
    case "remapCardReadout": {
      const cn = numOr0(r[colIndex(cols, "card_no")]);
      setBy(r, cols, "card_no", remapCard(cn));
      // owner_data is JSONB with PII — replace with a generic pseudonym
      // payload. The runner UUID isn't easily reachable from here, so
      // fall back to a fixed placeholder; screenshots that need a real
      // name pull it from runners.name anyway.
      setBy(
        r,
        cols,
        "owner_data",
        JSON.stringify({ firstName: "Demo", lastName: "Runner" }),
      );
      return r;
    }
    case "remapPunch": {
      const cn = numOr0(r[colIndex(cols, "card_no")]);
      setBy(r, cols, "card_no", remapCard(cn));
      return r;
    }
  }
}

/**
 * Walk every UUID column on the row and replace its value with the
 * deterministic remap. PK columns (always named `id`) mint a fresh
 * uuid and record it; FK columns look up the mapping.
 *
 * The `members` array on teams is special-cased because Postgres
 * `_uuid` (uuid[]) shows up as an array of strings.
 */
function rewriteUuids(
  row: unknown[],
  cols: ColumnInfo[],
  tableName: string,
): void {
  for (let i = 0; i < cols.length; i++) {
    const c = cols[i]!;
    const v = row[i];
    if (v == null) continue;
    if (c.udt === "uuid") {
      if (c.name === "id") {
        row[i] = remapUuid(String(v));
      } else {
        row[i] = lookupUuid(String(v));
      }
      continue;
    }
    // uuid[] arrays (e.g. teams.members) — pg returns string[].
    if (c.udt === "_uuid" && Array.isArray(v)) {
      row[i] = (v as unknown[]).map((u) =>
        u == null ? null : lookupUuid(String(u)),
      );
      continue;
    }
  }
  // Defensive: card_readouts.id is referenced by cards.readout_id, but
  // cards has its own uuid PK too — both must be in `uuidRemap` after
  // their respective passes. Nothing to do here, just an anchor for
  // future schema additions.
  void tableName;
}

/**
 * Rewrite the `event_id` column (and any FK columns that point at the
 * source event id) from the source value to the demo sentinel.
 */
function remapEventRefs(
  row: unknown[],
  cols: ColumnInfo[],
  srcEventId: bigint,
  demoEventId: bigint,
  tableName: string,
): void {
  if (tableName === "events") {
    // The events row carries the source id in column `id`.
    const idIdx = colIndex(cols, "id");
    if (idIdx >= 0) row[idIdx] = demoEventId;
    return;
  }
  const evIdx = colIndex(cols, "event_id");
  if (evIdx >= 0) {
    const cur = row[evIdx];
    if (cur != null && BigInt(String(cur)) === srcEventId) {
      row[evIdx] = demoEventId;
    }
  }
}

function setBy(
  row: unknown[],
  cols: ColumnInfo[],
  name: string,
  value: unknown,
): void {
  const idx = colIndex(cols, name);
  if (idx >= 0) row[idx] = value;
}

function numOr0(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

main().catch((err) => {
  console.error("Anonymization failed:", err);
  process.exit(1);
});
