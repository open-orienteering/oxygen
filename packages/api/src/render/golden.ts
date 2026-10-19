/**
 * Golden PNGs for the WebGL2 screenshot tests: the reference raster of
 * each golden scene at the fixed golden density, encoded as PNG. Shared
 * by the generator script (`scripts/render-golden.ts`) and the test that
 * keeps the committed files in sync with the oracle.
 */

import { render } from "@oxygen/shared";
import { loadBundledFont, glyphOutlineFrom } from "./fonts.js";
import { encodePng, rasterisePassStream } from "./reference-raster.js";

/**
 * Goldens are rendered at this multiple of the golden density and box-
 * filtered down: resvg flattens curves to ~¼ px chords and the extra
 * density shrinks that error (and edge-coverage rounding) below the
 * per-channel tolerance, so the comparison measures the backend, not
 * the oracle's rasteriser.
 */
export const GOLDEN_SUPERSAMPLE = 4;

/** `e2e/__golden__/map-gl/` — Playwright's `snapshotPathTemplate` points here. */
export const goldenDir = new URL("../../../../e2e/__golden__/map-gl/", import.meta.url);

export async function goldenFonts(): Promise<render.TrueTypeFont[]> {
  return Promise.all([loadBundledFont("liberation-sans"), loadBundledFont("liberation-sans-narrow")]);
}

export async function renderGoldenPng(name: render.GoldenSceneName): Promise<Buffer> {
  const fonts = await goldenFonts();
  const scene = render.goldenScene(name, fonts);
  const { bounds } = render.goldenFrame(scene.stream);
  const img = await rasterisePassStream(scene.stream, {
    colour: scene.colour,
    bounds,
    pxPerMm: render.GOLDEN_PX_PER_MM,
    glyphOutline: glyphOutlineFrom(fonts),
    supersample: GOLDEN_SUPERSAMPLE,
  });
  return encodePng(img);
}
