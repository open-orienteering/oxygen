#!/usr/bin/env node
/**
 * Make the Demo Competition's map (docs/demo.md, "The map"): add the
 * invented point features to the CC0 Puit de Laven map.
 *
 *   node scripts/inject-demo-points.mjs [in.omap] [out.omap] [seed]
 *
 * Defaults: docs/screenshots/fixtures/puit-de-laven.omap →
 * docs/screenshots/fixtures/puit-de-laven-demo.omap, seed 42. The default
 * run reproduces the committed demo map byte for byte
 * (`scripts/__tests__/demo-map.test.mjs`); after changing the seed or the
 * plan, run `node scripts/patch-showcase-map.mjs` to re-pin the fixture.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { DEMO_MAP_PATH, ORIGINAL_MAP_PATH } from "./lib/showcase-map.mjs";
import { DEMO_SEED, injectDemoPoints } from "./lib/inject-demo-points.mjs";

const [src = ORIGINAL_MAP_PATH, dst = DEMO_MAP_PATH, seedArg] = process.argv.slice(2);
const seed = seedArg === undefined ? DEMO_SEED : Number(seedArg);
const { text, placed } = injectDemoPoints(readFileSync(src, "utf8"), seed);
for (const [code, n] of Object.entries(placed)) console.log(`${code}: ${n} placed`);
writeFileSync(dst, text, "utf8");
console.log(`total injected ${Object.values(placed).reduce((a, b) => a + b, 0)} → ${dst}`);
