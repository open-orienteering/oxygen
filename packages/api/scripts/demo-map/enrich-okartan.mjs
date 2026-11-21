/**
 * Writes the demo map (docs/ops/demo-map.md): the o-kartan original plus
 * the seeded invented detail of `enrich-ocad.mjs`.
 *
 *   pnpm --filter @oxygen/api demo-map:enrich -- \
 *     --heights <ground height field .bin> [--seed 1056] [--report out.json] \
 *     [in.ocd] [out.ocd]
 *
 * Defaults: in = fixtures/okartan/okartan-original.ocd, out =
 * fixtures/okartan/okartan-demo.ocd. The height field is the map's stored
 * `ground.lantmateriet-2m` field (map_heightfields.bytes); without it only
 * the point features are added and the cliffs stay as they are.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodeHeightField } from "@oxygen/shared/src/terrain/field/read.js";
import { DEMO_SEED, enrichOcad } from "./enrich-ocad.mjs";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const args = process.argv.slice(2).filter((a) => a !== "--");
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const heights = opt("--heights");
const seed = Number(opt("--seed") ?? DEMO_SEED);
const reportPath = opt("--report");
const [input = `${root}fixtures/okartan/okartan-original.ocd`, output = `${root}fixtures/okartan/okartan-demo.ocd`] = args;

const field = heights ? decodeHeightField(new Uint8Array(readFileSync(heights))) : null;
const { bytes, report } = await enrichOcad(readFileSync(input), { seed, field });
writeFileSync(output, bytes);
console.log(`${output}: seed ${seed}`, report.placed, "cliff tags", report.cliffTags, "steep cliffs", report.steepCliffs);
if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 1));
