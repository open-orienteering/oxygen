/**
 * SQL for the Demo Competition's map in docs/screenshots/fixtures/showcase.sql
 * (docs/demo.md): the event's `map_files` row, which names the demo map's
 * source by hash and leaves the document to the re-match that
 * `scripts/load-showcase.sh` runs after loading (docs/map-storage.md
 * §6.9, `unpinned`). The fixture carries no map bytes: the loader inserts
 * the `map_sources` row from the committed `.omap`. Both the anonymiser
 * and `scripts/patch-showcase-map.mjs` emit the row through the functions
 * here, so a fresh dump and a patched fixture are the same text.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const FIXTURE_PATH = path.join(ROOT, "docs", "screenshots", "fixtures", "showcase.sql");

const MAP_FILE_PREFIX = `INSERT INTO map_files `;

/** Postgres E'…' string literal (backslashes, quotes, control characters). */
export function sqlString(s) {
  const escaped = String(s)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "''")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `E'${escaped}'`;
}

/**
 * The event's `map_files` row: the source pinned by hash, no document
 * yet, so the quick-access columns stay NULL until the re-match pins one
 * (docs/map-storage.md §6.4). `id` is left to the sequence;
 * `club_map_version_id` stays NULL (the demo map is not a club library
 * map).
 */
export function mapFileInsert({ eventId, uploadedAt, rotationCorrection = 0 }, source) {
  return (
    `${MAP_FILE_PREFIX}("event_id", "file_name", "uploaded_at", "rotation_correction", "source_hash", "document_hash") VALUES (` +
    `${eventId}, ${sqlString(source.fileName)}, '${uploadedAt}', ${rotationCorrection}, '${source.fileHash}', NULL);`
  );
}

function lineBounds(sql, prefix) {
  const start = sql.indexOf(prefix);
  if (start < 0) return null;
  const end = sql.indexOf("\n", start);
  return { start, end: end < 0 ? sql.length : end };
}

/** The `map_files` line's event id, upload time and rotation correction. */
function mapFileFields(line) {
  const eventId = line.match(/VALUES \((\d+), /)?.[1];
  const uploadedAt = line.match(/, '(\d{4}-[0-9T:.Z+-]+)', /)?.[1];
  const columns = line.match(/^INSERT INTO map_files \(([^)]*)\)/)?.[1].split(", ") ?? [];
  const values = line.match(/VALUES \((.*)\);$/)?.[1].split(", ") ?? [];
  const rc = values[columns.indexOf(`"rotation_correction"`)];
  return { eventId, uploadedAt, rotationCorrection: rc === undefined ? 0 : Number(rc) };
}

/**
 * Replace the map block of an existing fixture with the source-only
 * `map_files` row for `source`; any `map_sources` / `map_documents`
 * INSERT (the E-demo fixture inlined both) is dropped. The event id,
 * `uploaded_at` and `rotation_correction` of the existing row are kept.
 */
export function replaceShowcaseMap(sql, source) {
  const file = lineBounds(sql, MAP_FILE_PREFIX);
  if (!file) throw new Error("Could not find the map_files INSERT in the showcase SQL");
  const fields = mapFileFields(sql.slice(file.start, file.end));
  if (!fields.eventId || !fields.uploadedAt) throw new Error("Could not read event_id / uploaded_at from the map_files INSERT");
  const replaced = sql.slice(0, file.start) + mapFileInsert(fields, source) + sql.slice(file.end);
  return replaced
    .split("\n")
    .filter((l) => !l.startsWith("INSERT INTO map_sources ") && !l.startsWith("INSERT INTO map_documents "))
    .join("\n");
}

/** What a fixture holds of the map: the `map_files` row's fields. Null when the INSERT is missing. */
export function extractShowcaseMap(sql) {
  const f = lineBounds(sql, MAP_FILE_PREFIX);
  if (!f) return null;
  const line = sql.slice(f.start, f.end);
  return {
    ...mapFileFields(line),
    fileName: line.match(/VALUES \(\d+, E'([^']*)'/)?.[1],
    sourceHash: line.match(/'([0-9a-f]{64})', (?:NULL|'[0-9a-f]{64}')\);$/)?.[1],
    documentHash: line.match(/'([0-9a-f]{64})'\);$/)?.[1] ?? null,
    line,
  };
}

/** Legacy map storage the E5 drops removed: any INSERT into it makes the fixture fail on v0.6.1. */
export function legacyMapStorageUses(sql) {
  const uses = [];
  for (const table of ["map_tiles", "rendered_maps", "club_map_files"]) {
    if (new RegExp(`INSERT INTO ${table}\\b`).test(sql)) uses.push(table);
  }
  const mapFile = sql.match(/INSERT INTO map_files \(([^)]*)\)/)?.[1] ?? "";
  for (const col of ["file_data", "file_hash", "render_key", "color_profile", "color_overrides", "north_lines_below"]) {
    if (mapFile.includes(`"${col}"`)) uses.push(`map_files.${col}`);
  }
  return uses;
}

/** Map bytes in the fixture: the loader inserts the source from the committed file, the re-match makes the document. */
export function mapBytesInSql(sql) {
  const uses = [];
  for (const table of ["map_sources", "map_documents", "map_templates"]) {
    if (new RegExp(`INSERT INTO ${table}\\b`).test(sql)) uses.push(table);
  }
  return uses;
}

export const FORBIDDEN_SHOWCASE_SQL = [
  /Vinter Flaten/i,
  /kartutsitt/i,
  /Skogsluffarna/i,
  /Delade enheter/i,
];
