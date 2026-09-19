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
 * Implementation lives in `scripts/lib/ocad-fixture.mjs` so the showcase
 * demo map can reuse the same writer.
 *
 * Regenerate with:  node scripts/generate-test-ocd.mjs
 * Output is deterministic (seeded PRNG), so a regeneration with no script
 * changes produces a byte-identical file.
 */

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildE2eTestOcad } from "./lib/ocad-fixture.mjs";

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../e2e/test.ocd");
const buf = buildE2eTestOcad();
writeFileSync(OUT, buf);
console.log(`wrote ${OUT} (${buf.length} bytes)`);
