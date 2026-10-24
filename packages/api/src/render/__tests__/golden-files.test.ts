/**
 * The committed golden PNGs (`e2e/__golden__/map-gl/`) must be what the
 * reference raster produces today. If a fixture stream, a pilot symbol
 * or a symbolisation rule changes, this fails until
 * `pnpm --filter @oxygen/api golden:render` is re-run and the new
 * goldens are reviewed — so the browser tests never compare against a
 * stale oracle.
 */

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { render } from "@oxygen/shared";
import { pageSceneNames } from "@oxygen/shared/print";
import { goldenDir, renderGoldenPng } from "../golden.js";
import { renderPageGoldenPng } from "../page-raster.js";
import { diffImages } from "../reference-raster.js";

async function decode(png: Buffer): Promise<{ width: number; height: number; pixels: Uint8Array }> {
  const sharp = (await import("sharp")).default;
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, pixels: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
}

describe("golden PNGs", () => {
  it("lists every golden scene", () => {
    expect(render.goldenSceneNames).toEqual([
      "fill-with-holes",
      "dashed-bezier-stroke",
      "glyph-instances",
      "hatch-area",
      "colour-order",
      "text-with-halo",
      "pilot-scene",
      "lib-dash-ocad",
      "lib-dash-omap",
      "lib-line-glyphs",
      "lib-pattern",
      "lib-hatch",
      "lib-borders",
      "lib-holes",
      "lib-text",
      "lib-halos",
      "lib-text-layout",
      "lib-colour-order",
      "lib-precision",
      "course-legs",
      "course-cuts",
      "course-objects",
      "course-sprint",
      "course-all-controls",
    ]);
  });

  for (const name of render.goldenSceneNames) {
    it(`${name}.png matches the current reference raster`, async () => {
      const committed = await decode(await readFile(new URL(`${name}.png`, goldenDir)));
      const current = await decode(await renderGoldenPng(name));
      expect({ width: committed.width, height: committed.height }).toEqual({ width: current.width, height: current.height });
      // PNG encoding is lossless; allow nothing beyond rounding.
      const d = diffImages(committed, current, 1);
      expect(d.differing, `golden ${name}.png is stale — run pnpm --filter @oxygen/api golden:render`).toBe(0);
    });
  }

  it("lists every page scene", () => {
    expect([...pageSceneNames]).toEqual(["page-sprint-a4", "page-ring", "page-rotated"]);
  });

  for (const name of pageSceneNames) {
    it(`${name}.png matches the current page oracle`, async () => {
      const committed = await decode(await readFile(new URL(`${name}.png`, goldenDir)));
      const current = await decode(await renderPageGoldenPng(name));
      expect({ width: committed.width, height: committed.height }).toEqual({ width: current.width, height: current.height });
      const d = diffImages(committed, current, 1);
      expect(d.differing, `golden ${name}.png is stale — run pnpm --filter @oxygen/api golden:render`).toBe(0);
    }, 60_000);
  }

  it("golden frames are whole pixels", async () => {
    const fonts = await (await import("../golden.js")).goldenFonts();
    for (const name of render.goldenSceneNames) {
      const { bounds, width, height } = render.goldenFrame(render.goldenScene(name, fonts).stream);
      const umPerPx = 1000 / render.GOLDEN_PX_PER_MM;
      expect((bounds.maxX - bounds.minX) / umPerPx).toBeCloseTo(width, 6);
      expect((bounds.maxY - bounds.minY) / umPerPx).toBeCloseTo(height, 6);
    }
  });
});
