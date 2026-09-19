/**
 * Helpers for swapping the Demo Competition map blob in showcase.sql.
 */

import { SHOWCASE_OCAD, pgByteaLiteral, assertShowcaseOcadClean } from "./ocad-fixture.mjs";

const INSERT_PREFIX =
  `INSERT INTO map_files ("event_id", "file_name", "file_data", "uploaded_at") VALUES (9876543, `;

export function replaceShowcaseMapFile(sql, ocadBuf, uploadedAt) {
  assertShowcaseOcadClean(ocadBuf);
  const start = sql.indexOf(INSERT_PREFIX);
  if (start < 0) {
    throw new Error("Could not find map_files INSERT in showcase SQL");
  }
  const end = sql.indexOf("\n", start);
  if (end < 0) {
    throw new Error("map_files INSERT is not a single line");
  }
  const original = sql.slice(start, end);
  const ts = uploadedAt ?? extractUploadedAt(original) ?? "2026-01-01T00:00:00.000Z";
  const next =
    `${INSERT_PREFIX}E'${SHOWCASE_OCAD.fileName}', ${pgByteaLiteral(ocadBuf)}, '${ts}');`;
  return sql.slice(0, start) + next + sql.slice(end);
}

function extractUploadedAt(insertLine) {
  const m = insertLine.match(/, '([0-9T:.Z+-]+)'\);$/);
  return m?.[1];
}

export function extractMapFileFromSql(sql) {
  const start = sql.indexOf(INSERT_PREFIX);
  if (start < 0) return null;
  const end = sql.indexOf("\n", start);
  const line = sql.slice(start, end);
  const name = line.match(/E'([^']*)'/)?.[1];
  const hex = line.match(/'\\x([0-9a-fA-F]+)'::bytea/)?.[1];
  if (!hex) return { fileName: name, data: null };
  return { fileName: name, data: Buffer.from(hex, "hex") };
}

export function countMapTileInserts(sql) {
  return (sql.match(/INSERT INTO map_tiles /g) || []).length;
}

export const FORBIDDEN_SHOWCASE_SQL = [
  /Vinter Flaten/i,
  /kartutsitt/i,
  /Skogsluffarna/i,
  /Delade enheter/i,
];
