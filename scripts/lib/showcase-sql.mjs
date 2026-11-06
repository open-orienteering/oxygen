/**
 * SQL for the Demo Competition's map in docs/screenshots/fixtures/showcase.sql
 * (docs/demo.md): the `map_sources` and `map_documents` rows of the
 * synthetic showcase map and the event's pinned `map_files` row. The row
 * data comes from `scripts/lib/showcase-map.mjs`; both the anonymiser and
 * `scripts/patch-showcase-map.mjs` emit it through the functions here, so
 * a fresh dump and a patched fixture are the same text.
 */

import { pgByteaLiteral } from "./ocad-fixture.mjs";

const SOURCE_PREFIX = `INSERT INTO map_sources `;
const DOCUMENT_PREFIX = `INSERT INTO map_documents `;
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

function sqlJsonb(value) {
  return `${sqlString(JSON.stringify(value))}::jsonb`;
}

function sqlNullable(value, render) {
  return value === null || value === undefined ? "NULL" : render(value);
}

/**
 * Content-addressed rows are `ON CONFLICT DO NOTHING`: the same bytes are
 * the same row, so a reload (or an operator who uploaded the same file)
 * never fails and never overwrites (AGENTS.md §7).
 */
export function mapSourceInsert(source) {
  return (
    `${SOURCE_PREFIX}("file_hash", "kind", "bytes", "size_bytes", "file_name") VALUES (` +
    `'${source.fileHash}', '${source.kind}', ${pgByteaLiteral(source.bytes)}, ${source.sizeBytes}, ${sqlString(source.fileName)}` +
    `) ON CONFLICT ("file_hash") DO NOTHING;`
  );
}

export function mapDocumentInsert(doc) {
  return (
    `${DOCUMENT_PREFIX}("hash", "bytes", "size_bytes", "format_version", "importer_version", "library_version", "source_hash", "header", "report") VALUES (` +
    `'${doc.hash}', ${pgByteaLiteral(doc.bytes)}, ${doc.sizeBytes}, ${doc.formatVersion}, ${sqlString(doc.importerVersion)}, ${sqlString(doc.libraryVersion)}, ` +
    `'${doc.sourceHash}', ${sqlJsonb(doc.header)}, ${sqlJsonb(doc.report)}` +
    `) ON CONFLICT ("hash") DO NOTHING;`
  );
}

/**
 * The event's pinned `map_files` row. `id` is left to the sequence;
 * `club_map_version_id` stays NULL (the demo map is not a club library
 * map). Quick-access columns are the pin's (docs/map-storage.md §6.4).
 */
export function mapFileInsert({ eventId, uploadedAt }, pin, fileName) {
  return (
    `${MAP_FILE_PREFIX}("event_id", "file_name", "uploaded_at", "scale", "bounds", "north_offset", "calibration", "rotation_correction", "source_hash", "document_hash") VALUES (` +
    `${eventId}, ${sqlString(fileName)}, '${uploadedAt}', ${sqlNullable(pin.scale, String)}, ${sqlNullable(pin.bounds, sqlJsonb)}, ` +
    `${sqlNullable(pin.northOffset, String)}, ${sqlNullable(pin.calibration, sqlJsonb)}, ${pin.rotationCorrection}, ` +
    `'${pin.sourceHash}', '${pin.documentHash}');`
  );
}

/** The three INSERT lines (source, document, event pin) for `buildShowcaseMapRows()`. */
export function showcaseMapStatements(rows, { eventId, uploadedAt }) {
  return [
    mapSourceInsert(rows.source),
    mapDocumentInsert(rows.document),
    mapFileInsert({ eventId, uploadedAt }, rows.pin, rows.source.fileName),
  ];
}

function lineBounds(sql, prefix) {
  const start = sql.indexOf(prefix);
  if (start < 0) return null;
  const end = sql.indexOf("\n", start);
  return { start, end: end < 0 ? sql.length : end };
}

/**
 * Replace the map block of an existing fixture: the `map_sources`,
 * `map_documents` and `map_files` INSERT lines. The event id and the
 * `uploaded_at` of the existing `map_files` line are kept.
 */
export function replaceShowcaseMap(sql, rows) {
  const source = lineBounds(sql, SOURCE_PREFIX);
  const doc = lineBounds(sql, DOCUMENT_PREFIX);
  const file = lineBounds(sql, MAP_FILE_PREFIX);
  if (!source || !doc || !file) {
    throw new Error("Could not find the map_sources / map_documents / map_files INSERTs in the showcase SQL");
  }
  if (!(source.start < doc.start && doc.start < file.start)) {
    throw new Error("The map INSERTs are not in map_sources, map_documents, map_files order");
  }
  const existing = sql.slice(file.start, file.end);
  const eventId = existing.match(/VALUES \((\d+), /)?.[1];
  const uploadedAt = existing.match(/, '(\d{4}-[0-9T:.Z+-]+)', /)?.[1];
  if (!eventId || !uploadedAt) throw new Error("Could not read event_id / uploaded_at from the map_files INSERT");
  const [s, d, f] = showcaseMapStatements(rows, { eventId, uploadedAt });
  return sql.slice(0, source.start) + s + sql.slice(source.end, doc.start) + d + sql.slice(doc.end, file.start) + f + sql.slice(file.end);
}

/** What a fixture holds of the map: the hashes and bytes, for tests. Null when the INSERTs are missing. */
export function extractShowcaseMap(sql) {
  const s = lineBounds(sql, SOURCE_PREFIX);
  const d = lineBounds(sql, DOCUMENT_PREFIX);
  const f = lineBounds(sql, MAP_FILE_PREFIX);
  if (!s || !d || !f) return null;
  const src = sql.slice(s.start, s.end);
  const doc = sql.slice(d.start, d.end);
  const file = sql.slice(f.start, f.end);
  const hex = (line) => {
    const m = line.match(/'\\x([0-9a-fA-F]*)'::bytea/)?.[1];
    return m === undefined ? null : Buffer.from(m, "hex");
  };
  return {
    source: { fileHash: src.match(/VALUES \('([0-9a-f]{64})'/)?.[1], fileName: src.match(/, \d+, E'([^']*)'\)/)?.[1], bytes: hex(src), line: src },
    document: { hash: doc.match(/VALUES \('([0-9a-f]{64})'/)?.[1], bytes: hex(doc), line: doc },
    mapFile: {
      fileName: file.match(/VALUES \(\d+, E'([^']*)'/)?.[1],
      sourceHash: file.match(/'([0-9a-f]{64})', '[0-9a-f]{64}'\);$/)?.[1],
      documentHash: file.match(/'([0-9a-f]{64})'\);$/)?.[1],
      line: file,
    },
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

export const FORBIDDEN_SHOWCASE_SQL = [
  /Vinter Flaten/i,
  /kartutsitt/i,
  /Skogsluffarna/i,
  /Delade enheter/i,
];
