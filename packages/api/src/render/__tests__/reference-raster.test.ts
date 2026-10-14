import { describe, expect, it } from "vitest";
import { render } from "@oxygen/shared";
import { diffImages, rasterisePassStream, sampleAt, type RasterImage } from "../reference-raster.js";

const { renderFixtures, fixtureColours, passStreamFromJson } = render;
const colour = (i: number) => fixtureColours[i] ?? "#ff00ff";

const hex = (s: string): [number, number, number] => [
  parseInt(s.slice(1, 3), 16),
  parseInt(s.slice(3, 5), 16),
  parseInt(s.slice(5, 7), 16),
];

function expectColour(img: RasterImage, x: number, y: number, css: string, tol = 8) {
  const px = sampleAt(img, x, y);
  expect(px, `pixel at (${x}, ${y})`).toBeDefined();
  const [r, g, b] = hex(css);
  const [pr, pg, pb, pa] = px!;
  expect(pa).toBe(255);
  expect(Math.abs(pr - r) + Math.abs(pg - g) + Math.abs(pb - b), `colour at (${x}, ${y}) = rgb(${pr},${pg},${pb}), want ${css}`).toBeLessThanOrEqual(tol * 3);
}

const raster = (name: render.RenderFixtureName, opts: Partial<Parameters<typeof rasterisePassStream>[1]> = {}) =>
  rasterisePassStream(passStreamFromJson(renderFixtures[name]), { colour, marginUm: 1000, pxPerMm: 10, ...opts });

describe("rasterisePassStream", () => {
  it("produces an image sized from bounds and density, white background", async () => {
    const img = await raster("fill-with-holes");
    expect(img.width).toBe(220);
    expect(img.height).toBe(220);
    expect(img.bounds).toEqual({ minX: -1000, minY: -1000, maxX: 21000, maxY: 21000 });
    expectColour(img, -500, -500, "#ffffff");
  });

  it("fills the area and leaves holes white (y-up orientation preserved)", async () => {
    const img = await raster("fill-with-holes");
    expectColour(img, 1000, 1000, fixtureColours[1]);
    expectColour(img, 19000, 19000, fixtureColours[1]);
    expectColour(img, 6000, 6000, "#ffffff"); // first hole
    expectColour(img, 13500, 13500, "#ffffff"); // second hole
    expectColour(img, 10000, 2000, fixtureColours[1]);
  });

  it("strokes a Bézier through its evaluated points and dashes leave gaps", async () => {
    const img = await raster("dashed-bezier-stroke", { pxPerMm: 20 });
    const stream = passStreamFromJson(renderFixtures["dashed-bezier-stroke"]);
    const whole = stream.passes[0];
    const dashed = stream.passes[1];
    if (whole.kind !== "stroke" || dashed.kind !== "stroke") throw new Error("fixture changed");
    const [seg] = render.pathSegments(whole.path);
    for (const t of [0.1, 0.5, 0.9]) {
      const [x, y] = render.segmentPoint(seg, t);
      expectColour(img, x, y, fixtureColours[3], 24);
    }
    const [dseg] = render.pathSegments(dashed.path);
    const [onX, onY] = render.segmentPoint(dseg, 0.4); // inside slice 0.3–0.5
    expectColour(img, onX, onY, fixtureColours[5], 24);
    const [offX, offY] = render.segmentPoint(dseg, 0.25); // gap 0.2–0.3
    expectColour(img, offX, offY, "#ffffff");
  });

  it("instances glyph parts with scale and rotation", async () => {
    const img = await raster("glyph-instances");
    // Unrotated instance at (5000, 5000): green triangle centre, black stem below.
    expectColour(img, 5000, 5000, fixtureColours[2]);
    expectColour(img, 5000, 5000 - 1200, fixtureColours[5], 24);
    // Scaled ×0.75 instance at (10000, 15000): triangle tip at +900 is green, +1500 is paper.
    expectColour(img, 10000, 15000 + 500, fixtureColours[2]);
    expectColour(img, 10000, 15000 + 1500, "#ffffff");
    // Rotated 45° ×1.5 at (15000, 5000): the tip (0, 1200)·1.5 lands at (−1273, 1273).
    expectColour(img, 15000 - 1000, 5000 + 1000, fixtureColours[2]);
    expectColour(img, 15000 + 1273, 5000 + 1273, "#ffffff");
  });

  it("hatches inside the area only, alternating ink and paper", async () => {
    const img = await raster("hatch-area", { pxPerMm: 20 });
    // Lines along 45° satisfy (y − x)/√2 = 250 + k·1000. At x = 10000:
    // y = 10000 + √2·(250 + k·1000) → k = 2 gives y ≈ 13182 (ink); midway (k = 2.5) ≈ 13889 is paper.
    expectColour(img, 10000, 13182, fixtureColours[2], 40);
    expectColour(img, 10000, 13889, "#ffffff");
    // Outside the pentagon nothing is drawn even though hatch lines cover the bounds.
    expectColour(img, 23000, 2000, "#ffffff");
  });

  it("paints in colour-stack order: lower index under higher", async () => {
    const img = await raster("colour-order");
    expectColour(img, 3000, 6000, fixtureColours[1]); // yellow fill alone (off the diagonal)
    expectColour(img, 10000, 3000, fixtureColours[3]); // brown vertical over yellow
    expectColour(img, 10000, 10000, fixtureColours[6]); // purple over everything at the crossing
    expectColour(img, 10000, 11200, fixtureColours[5]); // black glyph over brown stroke
    expectColour(img, 3000, 10000, fixtureColours[6]); // purple horizontal over yellow
  });
});

describe("sampleAt", () => {
  it("returns undefined outside the image", async () => {
    const img = await raster("hatch-area");
    expect(sampleAt(img, img.bounds.minX - 1, 0)).toBeUndefined();
    expect(sampleAt(img, 0, img.bounds.maxY + 1)).toBeUndefined();
  });
});

describe("diffImages", () => {
  it("is zero for identical images and counts differing pixels otherwise", async () => {
    const a = await raster("colour-order");
    const b = await raster("colour-order");
    expect(diffImages(a, b)).toEqual({ differing: 0, total: a.width * a.height, ratio: 0 });
    const c = await raster("fill-with-holes");
    const d = diffImages(a, c);
    expect(d.differing).toBeGreaterThan(0);
    expect(d.ratio).toBeGreaterThan(0.05);
  });
  it("rejects size mismatches", async () => {
    const a = await raster("colour-order");
    const b = await raster("colour-order", { pxPerMm: 5 });
    expect(() => diffImages(a, b)).toThrow(/size mismatch/);
  });
});
