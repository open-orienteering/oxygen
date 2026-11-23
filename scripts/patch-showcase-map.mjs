#!/usr/bin/env node
/**
 * Re-pin the Demo Competition's map in fixtures/showcase/showcase.sql
 * (docs/ops/demo.md, "The map"): point the fixture's `map_files` row at the
 * committed demo map (`fixtures/okartan/okartan-demo.ocd`) by its hash.
 * Nothing else in the fixture changes.
 *
 * Run it after the demo map changes (a hand edit in OCAD, or a new run of
 * `pnpm --filter @oxygen/api demo-map:enrich`, docs/ops/demo-map.md); also
 * update its hash in scripts/lib/map-files.mjs. The importer and the symbol
 * library need no re-pin, since the document is made on load.
 * `scripts/__tests__/showcase-map.test.mjs` fails until the committed map
 * and the fixture agree. `scripts/anonymize-vinterserien.ts` writes the
 * same row when dumping from a live database.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { showcaseSource } from "./lib/showcase-map.mjs";
import { FIXTURE_PATH, replaceShowcaseMap, legacyMapStorageUses } from "./lib/showcase-sql.mjs";

const before = readFileSync(FIXTURE_PATH, "utf8");
const legacy = legacyMapStorageUses(before);
if (legacy.length) {
  throw new Error(`The fixture still writes dropped map storage (${legacy.join(", ")}); regenerate it with scripts/anonymize-vinterserien.ts`);
}
const source = showcaseSource();
writeFileSync(FIXTURE_PATH, replaceShowcaseMap(before, source));
console.log(`patched ${FIXTURE_PATH}: ${source.fileName}, ${source.sizeBytes} bytes (${source.fileHash.slice(0, 12)})`);
