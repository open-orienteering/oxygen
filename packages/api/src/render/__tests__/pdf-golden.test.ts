/**
 * The PDF golden tier (docs/course-print.md §9.2; research 05 §7 tier 3):
 * every golden scene (`map-rendering.md` §6.3 + the course scenes) and
 * every page scene written by the print backend, rasterised by
 * `pdftocairo` and compared against the reference raster.
 *
 * - `rgb`: against the committed golden, ≤ 0.5 % of the pixels beyond the
 *   channel tolerance. Scenes with text are also written with text as
 *   glyph outlines and held to the same 0.5 %: placement is per-glyph `Tm`
 *   in both modes, so the outline run proves the geometry and the
 *   embedded-font run carries the rasteriser's own glyph rendering
 *   (FreeType), budgeted like the WebGL2 MSDF text tier.
 * - `cmyk`: against the oracle drawn in the rasteriser's own CMYK → RGB
 *   conversion of each stack colour (`rasteriserCmykColours`), same budgets.
 * - `qpdf --check` on every generated file.
 *
 * Needs `pdftocairo` (poppler-utils) and `qpdf`: skipped where they are
 * missing, required under CI (`.github/workflows/ci.yml` installs both).
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { render } from "@oxygen/shared";
import { pageSceneNames } from "@oxygen/shared/print";
import { goldenDir } from "../golden.js";
import { composePageScene } from "../page-raster.js";
import {
  type GoldenPdf,
  type Pixels,
  boxDown,
  goldenOracle,
  goldenScenePdf,
  hasTool,
  pageOracle,
  pageScenePdf,
  qpdfCheck,
  rasterisePdf,
  rasteriserCmykColours,
} from "../pdf-golden.js";
import { GOLDEN_SUPERSAMPLE } from "../golden.js";
import { PAGE_GOLDEN_SUPERSAMPLE } from "../page-raster.js";
import { diffImages } from "../reference-raster.js";

/** Same per-channel tolerance as the WebGL2 golden spec (`e2e/map-gl-golden.spec.ts`). */
const CHANNEL_TOLERANCE = 16;
/** 04 §9 backend parity. */
const MAX_DIFF_RATIO = 0.005;
/**
 * Embedded-font text (course-print.md §9.2): FreeType's glyph rendering
 * against the oracle's outlines. Measured at introduction (C3, rgb):
 * lib-text-layout 1.96 %, lib-text 1.21 %, every other scene ≤ 0.48 %.
 */
const FONT_TEXT_MAX_RATIO = 0.025;

const tools = (await hasTool("pdftocairo")) && (await hasTool("qpdf"));
const required = !!process.env.CI;

async function decode(png: Buffer): Promise<Pixels> {
  const sharp = (await import("sharp")).default;
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, pixels: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
}

function ratio(expected: Pixels, actual: Pixels): number {
  expect({ width: actual.width, height: actual.height }).toEqual({ width: expected.width, height: expected.height });
  return diffImages(expected, actual, CHANNEL_TOLERANCE).differing / (expected.width * expected.height);
}

async function check(pdf: GoldenPdf, expected: Pixels, supersample: number, max: number, label: string): Promise<void> {
  expect(await qpdfCheck(pdf.bytes)).toMatch(/No syntax or stream encoding errors/);
  const r = ratio(expected, await rasterisePdf(pdf.bytes, pdf.width, pdf.height, supersample));
  expect(r, `${label}: ${(r * 100).toFixed(3)} % of the pixels differ by more than ${CHANNEL_TOLERANCE} levels`).toBeLessThanOrEqual(max);
}

/** The oracle in the rasteriser's CMYK conversion of the page's stack. */
async function cmykColour(pdf: GoldenPdf): Promise<(i: number) => string> {
  const hex = await rasteriserCmykColours(pdf.colours.map((c) => c.cmyk));
  return (i) => hex[i] ?? "#ff00ff";
}

describe("pdf-golden helpers", () => {
  it("boxDown averages each k × k block per channel", () => {
    // 4 × 2 → 2 × 1: a black/white block and a uniform grey block.
    const px = (v: number) => [v, v, v, 255];
    const img = { width: 4, height: 2, pixels: new Uint8Array([...px(0), ...px(255), ...px(100), ...px(100), ...px(255), ...px(0), ...px(100), ...px(100)]) };
    expect(Array.from(boxDown(img, 2).pixels)).toEqual([128, 128, 128, 255, 100, 100, 100, 255]);
  });

  it.skipIf(!tools)("rasteriserCmykColours: one colour per entry, read back from the rasteriser", async () => {
    const hex = await rasteriserCmykColours([[0, 0, 0, 0], [0, 0, 0, 1], [0.35, 0.85, 0, 0]]);
    expect(hex).toHaveLength(3);
    expect(hex[0]).toBe("#ffffff");
    // Poppler shows 100 % K as a warm near-black (#231f20), not the naive #000000.
    expect(hex[1]).not.toBe("#000000");
    for (const v of [1, 3, 5]) expect(parseInt(hex[1].slice(v, v + 2), 16)).toBeLessThan(0x40);
    expect(hex[2]).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe.skipIf(!tools && !required)("PDF golden tier", () => {
  it("has the tools (CI installs qpdf and poppler-utils)", () => {
    expect(tools).toBe(true);
  });

  describe.each(render.goldenSceneNames)("%s", (name) => {
    it("rgb: within budget of the golden; text as outlines within 0.5 %", async () => {
      const golden = await decode(await readFile(new URL(`${name}.png`, goldenDir)));
      const pdf = await goldenScenePdf(name, "rgb");
      await check(pdf, golden, GOLDEN_SUPERSAMPLE, pdf.hasText ? FONT_TEXT_MAX_RATIO : MAX_DIFF_RATIO, `${name} rgb`);
      if (pdf.hasText) await check(await goldenScenePdf(name, "rgb", { text: "outline" }), golden, GOLDEN_SUPERSAMPLE, MAX_DIFF_RATIO, `${name} rgb outlines`);
    }, 120_000);

    it("cmyk: within budget of the oracle in the rasteriser's CMYK conversion", async () => {
      const pdf = await goldenScenePdf(name, "cmyk");
      const oracle = await goldenOracle(name, await cmykColour(pdf));
      await check(pdf, oracle, GOLDEN_SUPERSAMPLE, pdf.hasText ? FONT_TEXT_MAX_RATIO : MAX_DIFF_RATIO, `${name} cmyk`);
    }, 120_000);
  });

  describe.each([...pageSceneNames])("%s", (name) => {
    it("rgb: within budget of the page golden", async () => {
      const golden = await decode(await readFile(new URL(`${name}.png`, goldenDir)));
      const pdf = await pageScenePdf(name, "rgb");
      // Pages carry a few short strings only: held to 0.5 % with embedded fonts (course-print.md §9.2).
      await check(pdf, golden, PAGE_GOLDEN_SUPERSAMPLE, MAX_DIFF_RATIO, `${name} rgb`);
    }, 120_000);

    it("cmyk: within budget of the page oracle in the rasteriser's CMYK conversion", async () => {
      const page = await composePageScene(name);
      const pdf = await pageScenePdf(name, "cmyk", page);
      const oracle = await pageOracle(page, await cmykColour(pdf));
      await check(pdf, oracle, PAGE_GOLDEN_SUPERSAMPLE, MAX_DIFF_RATIO, `${name} cmyk`);
    }, 120_000);
  });
});
