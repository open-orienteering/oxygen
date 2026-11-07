#!/usr/bin/env node
/**
 * Re-pin the Demo Competition's map in docs/screenshots/fixtures/showcase.sql
 * (docs/demo.md, "The map"): write the demo map
 * (`puit-de-laven-demo.omap`) from the committed CC0 original through
 * `scripts/lib/inject-demo-points.mjs`, and point the fixture's
 * `map_files` row at its hash. Nothing else in the fixture changes.
 *
 * Run it after changing the injection (its seed or plan); the importer and
 * the symbol library need no re-pin, since the document is made on load.
 * `scripts/__tests__/showcase-map.test.mjs` fails until the committed map
 * and the fixture agree. `scripts/anonymize-vinterserien.ts` writes the
 * same row when dumping from a live database.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { DEMO_MAP_PATH, buildDemoMap, showcaseSource } from "./lib/showcase-map.mjs";
import { FIXTURE_PATH, replaceShowcaseMap, legacyMapStorageUses } from "./lib/showcase-sql.mjs";

const before = readFileSync(FIXTURE_PATH, "utf8");
const legacy = legacyMapStorageUses(before);
if (legacy.length) {
  throw new Error(`The fixture still writes dropped map storage (${legacy.join(", ")}); regenerate it with scripts/anonymize-vinterserien.ts`);
}
writeFileSync(DEMO_MAP_PATH, buildDemoMap());
const source = showcaseSource();
writeFileSync(FIXTURE_PATH, replaceShowcaseMap(before, source));
console.log(`patched ${FIXTURE_PATH}: ${source.fileName}, ${source.sizeBytes} bytes (${source.fileHash.slice(0, 12)})`);
