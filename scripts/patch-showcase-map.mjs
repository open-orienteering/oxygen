#!/usr/bin/env node
/**
 * Re-pin the Demo Competition's map in docs/screenshots/fixtures/showcase.sql:
 * regenerate the `map_sources`, `map_documents` and `map_files` INSERTs from
 * the synthetic showcase OCAD (docs/demo.md), through the same importer the
 * API runs. Nothing else in the fixture changes.
 *
 * Run it when the importer or the symbol library changes (the document hash
 * changes with them; `scripts/__tests__/showcase-map.test.mjs` fails until
 * you do), or to regenerate the map without a live Vinterserien source
 * event. `scripts/anonymize-vinterserien.ts` writes the same block when
 * dumping from a live database.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildShowcaseMapRows } from "./lib/showcase-map.mjs";
import { replaceShowcaseMap, legacyMapStorageUses } from "./lib/showcase-sql.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(ROOT, "docs/screenshots/fixtures/showcase.sql");

const before = readFileSync(FIXTURE, "utf8");
const legacy = legacyMapStorageUses(before);
if (legacy.length) {
  throw new Error(`The fixture still writes dropped map storage (${legacy.join(", ")}); regenerate it with scripts/anonymize-vinterserien.ts`);
}
const rows = await buildShowcaseMapRows();
writeFileSync(FIXTURE, replaceShowcaseMap(before, rows));
console.log(
  `patched ${FIXTURE}: source ${rows.source.sizeBytes} bytes (${rows.source.fileHash.slice(0, 12)}), ` +
    `document ${rows.document.sizeBytes} bytes (${rows.document.hash.slice(0, 12)}, ${rows.document.importerVersion}, ${rows.document.libraryVersion})`,
);
