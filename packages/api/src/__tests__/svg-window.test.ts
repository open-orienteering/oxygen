/**
 * SVG windows (docs/course-print.md §6.3, §8.5): `print.png`'s `crop` parameter, and resvg over
 * a window of the canvas: a crop gets the whole pixel box, so a small part of a large drawing is
 * as sharp as the whole drawing at that box.
 */
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { parseRasterWindow } from "../course-maps/graphics.js";
import { rasteriseSvgGraphic } from "../course-maps/pdf-page.js";
import { alphaBounds, reframeSvg } from "../course-maps/svg-window.js";

const enc = (s: string) => new TextEncoder().encode(s);
/** A 1000 × 1000 canvas with a 100 × 100 red square at (400, 400) and a 1-unit blue line through its middle. */
const SVG = `<?xml version="1.0"?><!-- logo --><svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000" viewBox="0 0 1000 1000">` +
  `<rect x="400" y="400" width="100" height="100" fill="#ff0000"/><rect x="400" y="449.5" width="100" height="1" fill="#0000ff"/></svg>`;

async function rgba(png: Uint8Array): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}
const px = (r: { data: Buffer; width: number }, x: number, y: number) => [...r.data.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 4)];

describe("parseRasterWindow", () => {
  it("reads x,y,w,h fractions; absent is the whole graphic", () => {
    expect(parseRasterWindow(undefined)).toBeUndefined();
    expect(parseRasterWindow("0.25,0,0.5,1")).toEqual({ x: 0.25, y: 0, width: 0.5, height: 1 });
    expect(parseRasterWindow("0.0009765625,0,0.5,1")).toEqual({ x: 0.0009765625, y: 0, width: 0.5, height: 1 });
  });

  it("refuses anything else", () => {
    for (const bad of ["1,2,3", "0,0,0,1", "0.5,0,0.6,1", "-0.1,0,0.5,1", "a,b,c,d", "0,0,1,1,1", "1e-3,0,1,1"]) expect(typeof parseRasterWindow(bad)).toBe("string");
  });
});

describe("rasteriseSvgGraphic over a window", () => {
  it("the window fills the box: the square's 10 % of the canvas at the whole 200 × 200 box", async () => {
    const r = await rgba(await rasteriseSvgGraphic(enc(SVG), 200, 200, { x: 0.4, y: 0.4, width: 0.1, height: 0.1 }));
    expect([r.width, r.height]).toEqual([200, 200]);
    expect(px(r, 5, 5)).toEqual([255, 0, 0, 255]);
    expect(px(r, 194, 194)).toEqual([255, 0, 0, 255]);
    // The 1-unit line is 2 px of the window's raster, sharp (it is under 1 px in a whole-canvas raster at this box).
    expect(px(r, 100, 99)).toEqual([0, 0, 255, 255]);
    expect(px(r, 100, 100)).toEqual([0, 0, 255, 255]);
    expect(px(r, 100, 97)).toEqual([255, 0, 0, 255]);
    const whole = await rgba(await rasteriseSvgGraphic(enc(SVG), 200, 200));
    expect(alphaBounds(new Uint8Array(whole.data), 200, 200)).toEqual([80, 80, 100, 100]);
  });

  it("stretches a window to a box of another aspect, like the whole-graphic raster", async () => {
    const r = await rgba(await rasteriseSvgGraphic(enc(SVG), 300, 100, { x: 0.4, y: 0.4, width: 0.1, height: 0.1 }));
    expect([r.width, r.height]).toEqual([300, 100]);
    expect(px(r, 2, 2)).toEqual([255, 0, 0, 255]);
    expect(px(r, 297, 97)).toEqual([255, 0, 0, 255]);
  });

  it("carries a DOCTYPE's entities and a `>` inside a root attribute", async () => {
    const svg = `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY ns_svg "http://www.w3.org/2000/svg">]>` +
      `<svg xmlns="&ns_svg;" data-note="a > b" width="1000" height="1000"><rect x="400" y="400" width="100" height="100" fill="#ff0000"/></svg>`;
    const r = await rgba(await rasteriseSvgGraphic(enc(svg), 100, 100, { x: 0.4, y: 0.4, width: 0.1, height: 0.1 }));
    expect(px(r, 2, 2)).toEqual([255, 0, 0, 255]);
    expect(px(r, 97, 97)).toEqual([255, 0, 0, 255]);
  });

  it("a document the wrapper cannot carry gets the window cut from a whole raster", async () => {
    // A prefixed root: resvg reads it, the wrapper finds no `<svg` root.
    const svg = `<s:svg xmlns:s="http://www.w3.org/2000/svg" width="1000" height="1000"><s:rect x="400" y="400" width="100" height="100" fill="#ff0000"/></s:svg>`;
    const r = await rgba(await rasteriseSvgGraphic(enc(svg), 100, 100, { x: 0.4, y: 0.4, width: 0.1, height: 0.1 }));
    expect([r.width, r.height]).toEqual([100, 100]);
    expect(px(r, 5, 5)).toEqual([255, 0, 0, 255]);
    expect(px(r, 94, 94)).toEqual([255, 0, 0, 255]);
  });

  it("keeps the original's own viewBox mapping (a canvas in other units than its viewBox)", async () => {
    const mm = `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="50mm" viewBox="0 0 10 5"><rect x="5" y="0" width="5" height="5" fill="#00ff00"/></svg>`;
    const r = await rgba(await rasteriseSvgGraphic(enc(mm), 100, 100, { x: 0.5, y: 0, width: 0.5, height: 1 }));
    expect(px(r, 1, 1)).toEqual([0, 255, 0, 255]);
    expect(px(r, 98, 98)).toEqual([0, 255, 0, 255]);
  });
});

describe("reframeSvg", () => {
  it("wraps the original root, replacing only its position and size; the prolog stays in front", () => {
    const out = reframeSvg(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:x="urn:x" x="5" width="10" height="20" viewBox="0 0 1 2"><g/></svg>`, [10, 20], [1, 2, 3, 4], [30, 40]);
    expect(out).toBe(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="30" height="40" viewBox="1 2 3 4" preserveAspectRatio="none">` +
        `<svg x="0" y="0" width="10" height="20" xmlns="http://www.w3.org/2000/svg" xmlns:x="urn:x" viewBox="0 0 1 2"><g/></svg></svg>`,
    );
  });
});
