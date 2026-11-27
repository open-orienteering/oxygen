/**
 * The CC0 Puit de Laven map (docs/ops/demo.md, "The map"): the Demo
 * Competition's map until 2026-11, now a test map. Committed as published
 * upstream (`puit-de-laven.omap`) and with invented point features from
 * `scripts/inject-demo-points.mjs` (`puit-de-laven-demo.omap`), which the
 * renderer, terrain and import tests read.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEMO_SEED, injectDemoPoints } from "./inject-demo-points.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "showcase");

/** The CC0 map as published upstream. */
export const ORIGINAL_MAP_PATH = path.join(FIXTURES, "puit-de-laven.omap");
/** The original plus the injected point features. */
export const DEMO_MAP_PATH = path.join(FIXTURES, "puit-de-laven-demo.omap");

/**
 * Where the original comes from. The SHA-256 is of
 * `puit-de-laven/puit-de-laven.omap` at the upstream commit (its git blob
 * is 9d0a02b7…); a different file under this name fails the guard test.
 */
export const ORIGINAL_MAP = {
  repository: "https://github.com/dmkaplan2000/orienteering-maps",
  path: "puit-de-laven/puit-de-laven.omap",
  commit: "38f674c68e34db8687a9bd3da069d4470a98ca71",
  author: "David Kaplan",
  license: "CC0-1.0",
  sha256: "57ae1a9db2457db9fcdb2a9f0c2999ac694231585c52ee97693a505a8db69daf",
};

/** The injected map as the injection makes it from the committed original. */
export function buildDemoMap(seed = DEMO_SEED) {
  return Buffer.from(injectDemoPoints(readFileSync(ORIGINAL_MAP_PATH, "utf8"), seed).text, "utf8");
}
