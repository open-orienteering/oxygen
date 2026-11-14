/**
 * The DEM live check (docs/map-terrain.md §7.6) — run by the operator,
 * never by tests or CI. It makes live requests to Lantmäteriet with the
 * operator's own Geotorget credential and reads about 100 MB of height
 * data for one club map (1 m and 2 m), in memory only; it prints
 * aggregates and writes nothing.
 *
 *   read -rs MAP_DEM_LANTMATERIET_AUTH   # type user:password, Enter
 *   export MAP_DEM_LANTMATERIET_AUTH
 *   pnpm --filter @oxygen/api dem:live-check -- --map /path/to/club-map.ocd
 *
 * Exit 0 when the verdict passes, 1 when it does not, 2 on a usage error.
 */

import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { importMapToDocument } from "../src/import/ocad.js";
import { runLiveCheck } from "../src/map-store/dem-live-check.js";

const args = process.argv.slice(2);
const at = args.indexOf("--map");
const path = at >= 0 ? args[at + 1] : undefined;
const credential = process.env.MAP_DEM_LANTMATERIET_AUTH ?? "";
if (!path || !/^[^:]+:.+$/s.test(credential)) {
  console.error("usage: MAP_DEM_LANTMATERIET_AUTH=user:password dem-live-check --map <club-map.ocd|.omap>");
  process.exit(2);
}

const file = readFileSync(path);
const kind = extname(path).toLowerCase() === ".omap" || extname(path).toLowerCase() === ".xmap" ? "omap" : "ocad";
const imported = await importMapToDocument(file, basename(path), kind);
const report = await runLiveCheck({ fetch: (url, init) => fetch(url, init), credential, document: imported.bytes });
console.log(JSON.stringify(report, null, 2));
console.log(report.verdict.pass ? "PASS: the 2 m overview may be used (docs/map-terrain.md §7.6)" : "FAIL: keep or switch to MAP_DEM_LANTMATERIET_RESOLUTION_M=1 and record the result (docs/map-terrain.md §7.6)");
process.exit(report.verdict.pass ? 0 : 1);
