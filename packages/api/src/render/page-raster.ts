/**
 * Page oracle (docs/course-print.md §7.5; research 05 §7 tier 3): a
 * composed page drawn by the reference raster, the image the page
 * goldens hold and the PDF tier (C3, `pdftoppm`) is compared against.
 *
 * The reference raster has no transform and no clip, so the two layers
 * are drawn separately and composited: the map layer moved through
 * `T_map` into page µm (`transformPassStream`) and rasterised over the
 * frame alone — the frame clip is the raster's extent — and the page
 * layer over the whole sheet on transparent, both over white paper.
 * Images are not drawn (no page scene carries one).
 */

import { render } from "@oxygen/shared";
import { type ComposedPage, type PageSceneName, composePage, pageScene, transformPassStream } from "@oxygen/shared/print";
import { glyphOutlineFrom } from "./fonts.js";
import { goldenFonts } from "./golden.js";
import { encodePng, rasterisePassStream } from "./reference-raster.js";

export interface PageRaster {
  width: number;
  height: number;
  /** RGBA, top row first. */
  pixels: Uint8Array;
}

/** `src` over `dst` at pixel offset (`ox`, `oy`), straight alpha. */
function over(dst: Uint8Array, dw: number, dh: number, src: { width: number; height: number; pixels: Uint8Array }, ox: number, oy: number): void {
  for (let y = 0; y < src.height; y++) {
    const ty = y + oy;
    if (ty < 0 || ty >= dh) continue;
    for (let x = 0; x < src.width; x++) {
      const tx = x + ox;
      if (tx < 0 || tx >= dw) continue;
      const s = (y * src.width + x) * 4, d = (ty * dw + tx) * 4;
      const a = src.pixels[s + 3] / 255;
      if (a === 0) continue;
      for (let c = 0; c < 3; c++) dst[d + c] = Math.round(src.pixels[s + c] * a + dst[d + c] * (1 - a));
      dst[d + 3] = 255;
    }
  }
}

export async function rasterisePage(page: ComposedPage, opts: { pxPerMm?: number; supersample?: number } = {}): Promise<PageRaster> {
  const pxPerMm = opts.pxPerMm ?? render.GOLDEN_PX_PER_MM;
  const fonts = await goldenFonts();
  const hex = page.colours.map((c) => render.cmykToHex(c.cmyk));
  const colour = (i: number) => hex[i] ?? "#ff00ff";
  const common = { colour, pxPerMm, background: "none", glyphOutline: glyphOutlineFrom(fonts), supersample: opts.supersample ?? 1 };
  const width = Math.round(page.paper.widthMm * pxPerMm);
  const height = Math.round(page.paper.heightMm * pxPerMm);
  const pixels = new Uint8Array(width * height * 4).fill(255);

  const f = page.frameUm;
  const map = await rasterisePassStream(transformPassStream(page.mapLayer.stream, page.mapLayer.transform), {
    ...common,
    bounds: { minX: f.x, minY: f.y, maxX: f.x + f.width, maxY: f.y + f.height },
  });
  over(pixels, width, height, map, Math.round((f.x / 1000) * pxPerMm), Math.round((page.paper.heightMm - (f.y + f.height) / 1000) * pxPerMm));

  if (page.pageLayer.stream.passes.length) {
    const sheet = await rasterisePassStream(page.pageLayer.stream, {
      ...common,
      bounds: { minX: 0, minY: 0, maxX: page.paper.widthMm * 1000, maxY: page.paper.heightMm * 1000 },
    });
    over(pixels, width, height, sheet, 0, 0);
  }
  return { width, height, pixels };
}

/**
 * Page goldens supersample 2× rather than the scene goldens' 4×: an A4
 * sheet at 4× would be an 8400 × 11 880 px intermediate (~400 MB RGBA);
 * 2× keeps edge rounding well under the PDF tier's tolerance (C3).
 */
export const PAGE_GOLDEN_SUPERSAMPLE = 2;

/** A page scene composed with the bundled fonts. */
export async function composePageScene(name: PageSceneName): Promise<ComposedPage> {
  return composePage(pageScene(name), await goldenFonts());
}

/** A page scene's golden (`e2e/__golden__/map-gl/page-*.png`): the page oracle at the golden density. */
export async function renderPageGoldenPng(name: PageSceneName): Promise<Buffer> {
  return encodePng(await rasterisePage(await composePageScene(name), { supersample: PAGE_GOLDEN_SUPERSAMPLE }));
}
