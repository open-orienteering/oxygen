/**
 * Generates the synthetic OCAD 2018 course-setting fixture `e2e/test.ocd`.
 *
 * The fixture is generated so the repository never needs to contain real
 * map or course-setting exports (real OCAD files carry georeferences and
 * metadata paths that don't belong in a public repo). The synthetic file
 * has the same *shape* as the export it replaced, so every consumer works
 * unchanged:
 *
 *   - 5 courses named A–E with 18/15/11/10/8 controls
 *   - numeric control codes 61–88, start "S1", finish "M1"
 *   - zero class-assignment records (strType 3) — the class-name-fallback
 *     tests depend on that
 *   - a georeference (string 1039) with round, non-identifying SWEREF99 TM
 *     coordinates so WGS84 conversion yields non-zero lat/lng
 *   - a little synthetic "terrain" (one yellow area, a few black paths) so
 *     the map-tile renderer produces visible output
 *   - two terrain features at fixed positions in the empty top-right corner,
 *     outside the yellow blob: a boulder (ISOM 204) at 68/42 mm and a
 *     building (ISOM 521) spanning 48–58 / 39–46 mm. The description
 *     autodetect tests search around those coordinates, so moving them
 *     means updating `packages/api/src/__tests__/integration/
 *     description-autodetect.test.ts`
 *
 * Consumers this file must satisfy:
 *   - packages/api/src/ocd-course-parser.ts (custom binary parser)
 *   - ocad2geojson `readOcad` / `ocadToSvg` / `getCrs` / `getBounds`
 *     (map tiles, WGS84 conversion)
 *
 * Implementation lives in `scripts/lib/ocad-fixture.mjs`, with the other
 * generated OCAD fixtures.
 *
 * Regenerate with:  node scripts/generate-test-ocd.mjs
 * Output is deterministic (seeded PRNG), so a regeneration with no script
 * changes produces a byte-identical file.
 */

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildColourLayersOcad, buildE2eTestOcad } from "./lib/ocad-fixture.mjs";

const E2E = resolve(dirname(fileURLToPath(import.meta.url)), "../e2e");
// Also `e2e/colour-layers.ocd` (row I5): a badly ordered colour table for the IOF colour layers'
// E2E (docs/map-symbols.md §9.3; `COLOUR_LAYERS_OCAD` in the library says what is where).
for (const [name, build] of [["test.ocd", buildE2eTestOcad], ["colour-layers.ocd", buildColourLayersOcad]]) {
  const out = resolve(E2E, name);
  const buf = build();
  writeFileSync(out, buf);
  console.log(`wrote ${out} (${buf.length} bytes)`);
}
