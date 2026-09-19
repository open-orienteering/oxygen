#!/usr/bin/env node
/**
 * Replace the map_files blob in docs/screenshots/fixtures/showcase.sql
 * with the synthetic showcase OCAD. Cached map_tiles are left untouched.
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
if (tiles !== 5) {
  throw new Error(`Expected 5 map_tiles INSERTs, found ${tiles}`);
}
const ocad = buildShowcaseOcad();
const after = replaceShowcaseMapFile(before, ocad);
writeFileSync(FIXTURE, after);
console.log(
  `patched ${FIXTURE}: synthetic OCAD ${ocad.length} bytes, ${tiles} overview tiles kept`,
);
