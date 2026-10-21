/**
 * Writes the golden PNGs from the reference raster: the WebGL2 backend's
 * screenshot goldens (`e2e/map-gl-golden.spec.ts`, docs/map-rendering.md
 * §6.2) and the symbol library's contact sheet (`e2e/__golden__/library/`,
 * docs/map-symbols.md §6 (d)). Run after changing a golden scene, a
 * fixture stream, a library entry or the symbolisation stage:
 *
 *   pnpm --filter @oxygen/api golden:render
 *
 * `packages/api/src/render/__tests__/golden-files.test.ts` and
 * `library-golden.test.ts` fail when the committed files no longer match
 * the current oracle, so a stale golden cannot slip through.
 */

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { render } from "@oxygen/shared";
import { LIBRARY_GOLDEN_IDS, goldenDir, libraryGoldenDir, librarySheetMarkdown, renderGoldenPng, renderLibraryGoldens } from "../src/render/golden.js";

const dir = fileURLToPath(goldenDir);
await mkdir(dir, { recursive: true });
for (const name of render.goldenSceneNames) {
  const png = await renderGoldenPng(name);
  await writeFile(`${dir}${name}.png`, png);
  console.log(`wrote ${name}.png (${png.byteLength} bytes)`);
}

const libRoot = fileURLToPath(libraryGoldenDir);
for (const id of LIBRARY_GOLDEN_IDS) {
  const libDir = `${libRoot}${id}/`;
  await mkdir(libDir, { recursive: true });
  const goldens = await renderLibraryGoldens(id);
  const owned = new Set(goldens.map((g) => g.file));
  for (const f of await readdir(libDir)) {
    if (!owned.has(f)) {
      await rm(`${libDir}${f}`);
      console.log(`removed ${id}/${f} (no entry owns it)`);
    }
  }
  let bytes = 0;
  for (const g of goldens) {
    await writeFile(`${libDir}${g.file}`, g.png);
    bytes += g.png.byteLength;
  }
  await writeFile(`${libRoot}${id}.md`, librarySheetMarkdown(id));
  console.log(`wrote ${id}/ (${goldens.length} swatches, ${bytes} bytes) and ${id}.md`);
}
