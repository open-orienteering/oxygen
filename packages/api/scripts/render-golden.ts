/**
 * Writes the golden PNGs of the WebGL2 backend's screenshot tests
 * (`e2e/map-gl-golden.spec.ts`) from the reference raster
 * (docs/map-rendering.md §6.2). Run after changing a golden scene, a
 * fixture stream or the symbolisation stage:
 *
 *   pnpm --filter @oxygen/api golden:render
 *
 * `packages/api/src/render/__tests__/golden-files.test.ts` fails when
 * the committed PNGs no longer match the current oracle, so a stale
 * golden cannot slip through.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { render } from "@oxygen/shared";
import { renderGoldenPng, goldenDir } from "../src/render/golden.js";

const dir = fileURLToPath(goldenDir);
await mkdir(dir, { recursive: true });
for (const name of render.goldenSceneNames) {
  const png = await renderGoldenPng(name);
  await writeFile(`${dir}${name}.png`, png);
  console.log(`wrote ${name}.png (${png.byteLength} bytes)`);
}
