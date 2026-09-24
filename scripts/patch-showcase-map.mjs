#!/usr/bin/env node
/**
 * Replace the map_files blob in docs/screenshots/fixtures/showcase.sql
 * with the synthetic showcase OCAD. map_tiles are not stored in the
 * fixture (content-keyed cache regenerates on first view).
 *
 * Used when regenerating the committed fixture without a live Vinterserien
 * source event. `scripts/anonymize-vinterserien.ts` performs the same
 * substitution when dumping from a live database.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildShowcaseOcad } from "./lib/ocad-fixture.mjs";
import { replaceShowcaseMapFile, countMapTileInserts } from "./lib/showcase-sql.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(ROOT, "docs/screenshots/fixtures/showcase.sql");

const before = readFileSync(FIXTURE, "utf8");
const tiles = countMapTileInserts(before);
if (tiles !== 0) {
  throw new Error(`Expected 0 map_tiles INSERTs, found ${tiles}`);
}
const ocad = buildShowcaseOcad();
const after = replaceShowcaseMapFile(before, ocad);
writeFileSync(FIXTURE, after);
console.log(
  `patched ${FIXTURE}: synthetic OCAD ${ocad.length} bytes (tiles regenerate on view)`,
);
