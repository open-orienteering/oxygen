/**
 * Preview renderers (docs/map-storage.md §4.5, docs/map-rendering.md
 * §5.1.1): swatches and thumbnails through the reference raster, probed
 * at hand-computed paper coordinates like the pilot-raster tests.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { render, symbolLibrary } from "@oxygen/shared";
import { importOcadToDocument } from "../../import/ocad.js";
import { type RasterImage, sampleAt } from "../reference-raster.js";
import { THUMBNAIL_LONG_EDGE_PX, renderSwatch, renderSwatchPng, renderThumbnailPng, stackColour } from "../previews.js";

const { PILOT, pilotColours, pilotSymbols, SWATCH } = render;
const colour = (i: number) => pilotColours[i]?.hex ?? "#ff00ff";
const hex = (s: string) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const isColour = (img: RasterImage, x: number, y: number, css: string, tol = 24) => {
  const px = sampleAt(img, x, y);
  if (!px) return false;
  const [r, g, b] = hex(css);
  return Math.abs(px[0] - r) + Math.abs(px[1] - g) + Math.abs(px[2] - b) <= tol * 3;
};
async function decodePng(png: Buffer) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}
const fixture = readFileSync(fileURLToPath(new URL("../../../../../e2e/test.ocd", import.meta.url)));

describe("renderSwatch", () => {
  it("418 tree at 3×: green disc in the centre, black ring at 3× radius, neutral swatch outside", async () => {
    const img = await renderSwatch(pilotSymbols[PILOT.tree418], colour);
    expect(isColour(img, 0, 0, colour(4))).toBe(true);
    expect(isColour(img, 1590, 0, colour(8))).toBe(true); // ring mid-line at 3 × 530 µm (outer Ø 1 200, width 140)
    expect(isColour(img, 1200, 0, SWATCH.background)).toBe(true); // between disc (r 900) and ring
    expect(isColour(img, 5000, 5000, SWATCH.background)).toBe(true);
    expect(img.width).toBe(140); // 12 mm frame + 2 × 1 mm at 10 px/mm
  });

  it("505 footpath: a dash on the dash point, ink and gaps along the first leg", async () => {
    const img = await renderSwatch(pilotSymbols[PILOT.footpath505], colour);
    expect(isColour(img, 20660, 5000, colour(8))).toBe(true);
    let ink = 0, gap = 0;
    for (let x = 0; x <= 12000; x += 50) {
      if (isColour(img, x, 0, colour(8))) ink++;
      else if (isColour(img, x, 0, SWATCH.background)) gap++;
    }
    expect(ink).toBeGreaterThan(gap);
    expect(gap).toBeGreaterThan(0);
  });

  it("403 rough open land: fill colour across the 15 mm square", async () => {
    const img = await renderSwatch(pilotSymbols[PILOT.roughOpen403], colour);
    expect(isColour(img, 7500, 7500, colour(1))).toBe(true); // pilot 403 fills with colour 1
    expect(isColour(img, 16500, 7500, SWATCH.background) || sampleAt(img, 16500, 7500) === undefined).toBe(true);
  });

  it("704 control number: the sample text leaves ink", async () => {
    const img = await renderSwatch(pilotSymbols[PILOT.controlNumber704], colour);
    let ink = 0;
    for (let i = 0; i < img.width * img.height; i++) {
      const o = i * 4;
      if (Math.abs(img.pixels[o] - 0xf0) + Math.abs(img.pixels[o + 1] - 0xf0) + Math.abs(img.pixels[o + 2] - 0xf0) > 60) ink++;
    }
    expect(ink).toBeGreaterThan(50);
  });

  it("library entry → PNG of the frame's size", async () => {
    const lib = symbolLibrary.materialiseLibrary("ISOM2017-2");
    const i = lib.library.entries.findIndex((e) => e.id === "ISOM2017-2:418");
    const png = await renderSwatchPng(lib.symbols[i], stackColour(lib.colours));
    const decoded = await decodePng(png);
    expect(decoded.width).toBe(140);
    expect(decoded.height).toBe(140);
  });
});

describe("renderThumbnailPng", () => {
  it("draws the whole document with the long edge at 512 px", async () => {
    const doc = await importOcadToDocument(fixture, "test.ocd");
    const result = await renderThumbnailPng(doc.bytes);
    if (!("png" in result)) throw new Error("thumbnail skipped");
    const decoded = await decodePng(result.png);
    expect(Math.max(decoded.width, decoded.height)).toBe(THUMBNAIL_LONG_EDGE_PX);
    const colours = new Set<number>();
    for (let i = 0; i < decoded.width * decoded.height; i += 7) colours.add(decoded.data.readUInt32BE(i * 4));
    expect(colours.size).toBeGreaterThan(3);
  });

  it("skips documents over the object cap", async () => {
    const doc = await importOcadToDocument(fixture, "test.ocd");
    const result = await renderThumbnailPng(doc.bytes, { maxObjects: 1 });
    expect(result).toMatchObject({ skipped: "too-many-objects" });
  });
});
