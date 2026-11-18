/**
 * The page oracle (docs/course-print.md §7.5): paper white outside the
 * frame, map ink inside it, the page layer on top, a rotated window's
 * content where `T_map` puts it.
 */

import { describe, expect, it } from "vitest";
import { render } from "@oxygen/shared";
import { mapPointToPage } from "@oxygen/shared/print";
import { composePageScene, over, rasterisePage, type PageRaster } from "../page-raster.js";
import { encodePng, rasterisePassStream } from "../reference-raster.js";

const PX = 10; // px/mm
const at = (img: PageRaster, xMm: number, yDownMm: number) => {
  const o = (Math.floor(yDownMm * PX) * img.width + Math.floor(xMm * PX)) * 4;
  return Array.from(img.pixels.subarray(o, o + 4));
};
const white = [255, 255, 255, 255];

describe("rasterisePage", () => {
  it("ring page: white margin and toner-saver ring, green inside the ring, the page box and its text on top", async () => {
    const page = await composePageScene("page-ring");
    const img = await rasterisePage(page, { pxPerMm: PX });
    expect([img.width, img.height]).toEqual([1200, 900]);
    expect(at(img, 3, 3)).toEqual(white); // outside the frame
    expect(at(img, 12, 40)).toEqual(white); // inside the frame, outside the ring (white-out)
    const inside = at(img, 40, 40); // 406 green inside the ring
    expect(inside[1]).toBeGreaterThan(inside[0]);
    expect(inside[1]).toBeGreaterThan(inside[2]);
    // Page white-out box at (84..116, 62..86) over the frame edge, black border.
    expect(at(img, 90, 66)).toEqual(white);
    const border = at(img, 84.05, 70);
    expect(border[0]).toBeLessThan(80);
  });

  it("rotated page: the building's centre lands where T_map puts it; the corners outside the frame stay white", async () => {
    const page = await composePageScene("page-rotated");
    const img = await rasterisePage(page, { pxPerMm: PX });
    const [x, y] = mapPointToPage(page.mapLayer.transform, 0, 0);
    const c = at(img, x / 1000, page.paper.heightMm - y / 1000);
    expect(c.slice(0, 3).every((v) => v < 60)).toBe(true); // 521 building, black
    // A corner of the 20 × 20 mm building, turned 20° on the page: (10, 10) paper mm.
    const [cx, cy] = mapPointToPage(page.mapLayer.transform, 9000, 9000);
    expect(at(img, cx / 1000, page.paper.heightMm - cy / 1000).slice(0, 3).every((v) => v < 60)).toBe(true);
    expect(at(img, 4, 4)).toEqual(white);
  });

  it("sprint page: the description block is white with black rules at the template position", async () => {
    const page = await composePageScene("page-sprint-a4");
    const img = await rasterisePage(page, { pxPerMm: PX });
    expect([img.width, img.height]).toEqual([2100, 2970]);
    expect(at(img, 137 + 7 * 7.5, 14 + 7 * 0.2)).toEqual(white); // inside the event row, away from the text
    const rule = at(img, 137 + 7 * 4, 14 + 7);
    expect(rule[0]).toBeLessThan(80);
  });

  it("layered (J4): a Multiply page rectangle multiplies the map under it; elsewhere the page is as composited", async () => {
    const page = await composePageScene("page-objects-alpha");
    const img = await rasterisePage(page, { pxPerMm: PX });
    const green = at(img, 40, 40); // 406 green, under no object
    const under = at(img, 50, 33); // inside the #ffd400 Multiply rectangle, over the same green
    expect(Math.abs(under[0] - green[0])).toBeLessThanOrEqual(2); // × 255/255
    expect(Math.abs(under[1] - Math.round((green[1] * 212) / 255))).toBeLessThanOrEqual(2);
    expect(under[2]).toBeLessThanOrEqual(2); // × 0
    expect(at(img, 3, 3)).toEqual(white);
  });

  it("backdropPng: an empty stream at supersample 2 returns the backdrop byte for byte", async () => {
    const width = 40, height = 30;
    const pixels = new Uint8Array(width * height * 4);
    for (let i = 0; i < pixels.length; i += 4) {
      const p = i / 4;
      pixels[i] = (p * 37) % 256; pixels[i + 1] = (p * 91) % 256; pixels[i + 2] = (p * 13) % 256; pixels[i + 3] = 255;
    }
    const empty = { objectIdx: new Uint32Array(0), symbolIdx: new Uint32Array(0), passes: [], glyphTable: [], fontTable: [] };
    const out = await rasterisePassStream(empty, {
      colour: () => "#000000", pxPerMm: 10, supersample: 2, background: "none",
      bounds: { minX: 0, minY: 0, maxX: 4000, maxY: 3000 }, backdropPng: await encodePng({ width, height, pixels }),
    });
    expect([out.width, out.height]).toEqual([width, height]);
    expect(Buffer.from(out.pixels).equals(Buffer.from(pixels))).toBe(true);
  });

  it("composites the layers' premultiplied pixels: a half-covered cyan edge over white keeps G and B at 255", async () => {
    // resvg returns premultiplied RGBA: 50 % cyan is (0, 128, 128, 128).
    const dst = new Uint8Array([255, 255, 255, 255]);
    over(dst, 1, 1, { width: 1, height: 1, pixels: new Uint8Array([0, 128, 128, 128]) }, 0, 0);
    expect(Array.from(dst)).toEqual([127, 255, 255, 255]);
    // And what the map layer hands over: an edge pixel of a cyan rectangle on transparent.
    const path = { coords: Int32Array.from([0, 0, 1500, 0, 1500, 1000, 0, 1000]), flags: new Uint8Array(4), closed: true };
    const stream: render.PassStream = {
      objectIdx: Uint32Array.of(0),
      symbolIdx: Uint32Array.of(0),
      passes: [{ kind: "fill", colour: 0, path, rule: "evenodd" }],
      glyphTable: [],
      fontTable: [],
    };
    const img = await rasterisePassStream(stream, { colour: () => "#00ffff", bounds: { minX: 0, minY: 0, maxX: 2000, maxY: 1000 }, pxPerMm: 1, background: "none", supersample: 2 });
    const edge = img.pixels.subarray(4, 8);
    expect(edge[3]).toBeGreaterThan(0);
    expect(edge[3]).toBeLessThan(255);
    const out = new Uint8Array(8).fill(255);
    over(out, 2, 1, img, 0, 0);
    expect([out[5], out[6]]).toEqual([255, 255]);
  });
});
