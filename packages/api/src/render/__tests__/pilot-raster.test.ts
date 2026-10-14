/**
 * Stage → oracle chain on the pilot symbols: symbolise real objects, draw
 * them with the reference raster, probe pixels at hand-computed paper
 * coordinates. This is the acceptance test of the S1 step-2 rules in
 * image form (docs/map-rendering.md §6.2).
 */
import { describe, expect, it } from "vitest";
import { render } from "@oxygen/shared";
import { glyphOutlineFrom, loadBundledFont } from "../fonts.js";
import { type RasterImage, rasterisePassStream, sampleAt } from "../reference-raster.js";

const colour = (i: number) => pilotColours[i]?.hex ?? "#ff00ff";
const hex = (s: string) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const isColour = (img: RasterImage, x: number, y: number, css: string, tol = 24) => {
  const px = sampleAt(img, x, y);
  if (!px) return false;
  const [r, g, b] = hex(css);
  return Math.abs(px[0] - r) + Math.abs(px[1] - g) + Math.abs(px[2] - b) <= tol * 3;
};
const { makePath, PILOT, pilotColours, pilotSymbols } = render;

async function draw(objects: render.RenderObject[], pxPerMm = 20) {
  const fonts = [await loadBundledFont("liberation-sans")];
  const { stream, warnings } = render.symbolise({ objects, symbols: pilotSymbols, fonts });
  expect(warnings).toEqual([]);
  const img = await rasterisePassStream(stream, { colour, pxPerMm, marginUm: 1000, glyphOutline: glyphOutlineFrom(fonts) });
  return { img, stream };
}

describe("pilot symbols through the reference raster", () => {
  it("505 footpath: ink inside each dash, paper inside each gap", async () => {
    const { img } = await draw([{ symbolIdx: PILOT.footpath505, path: makePath([0, 0, 20000, 0]) }]);
    const r = (20000 - 7 * 500) / 16000;
    const dash = 2000 * r;
    for (let i = 0; i < 8; i++) {
      const start = i * (dash + 500);
      expect(isColour(img, start + dash / 2, 0, colour(8)), `dash ${i}`).toBe(true);
      if (i < 7) expect(isColour(img, start + dash + 250, 0, "#ffffff"), `gap ${i}`).toBe(true);
    }
  });

  it("502 wide road: brown-50 infill between two black edges", async () => {
    const { img } = await draw([{ symbolIdx: PILOT.wideRoad502, path: makePath([0, 0, 10000, 0]) }]);
    expect(isColour(img, 5000, 0, colour(5))).toBe(true);
    expect(isColour(img, 5000, 350, colour(8))).toBe(true);
    expect(isColour(img, 5000, -350, colour(8))).toBe(true);
    expect(isColour(img, 5000, 700, "#ffffff")).toBe(true);
  });

  it("503 framed road: the framing band shows outside the black line", async () => {
    const { img } = await draw([{ symbolIdx: PILOT.roadFramed503, path: makePath([0, 0, 10000, 0]) }]);
    expect(isColour(img, 5000, 0, colour(8))).toBe(true);
    expect(isColour(img, 5000, 275, colour(5))).toBe(true); // 175 < |y| < 375
    expect(isColour(img, 5000, 500, "#ffffff")).toBe(true);
  });

  it("516 power line: crossbars perpendicular to the line at the fitted positions", async () => {
    const { img } = await draw([{ symbolIdx: PILOT.powerLine516, path: makePath([0, 0, 0, 21000]) }]);
    expect(isColour(img, 0, 7000, colour(8))).toBe(true); // the line
    expect(isColour(img, 250, 10500, colour(8))).toBe(true); // crossbar reaches ±350 sideways
    expect(isColour(img, 250, 7000, "#ffffff")).toBe(true); // nothing between crossbars
    expect(isColour(img, 250, 3500, colour(8))).toBe(true);
    expect(isColour(img, 250, 17500, colour(8))).toBe(true);
  });

  it("418 tree: green centre, black ring, paper between and outside", async () => {
    const { img } = await draw([{ symbolIdx: PILOT.tree418, path: makePath([3000, 3000]) }], 40);
    expect(isColour(img, 3000, 3000, colour(4))).toBe(true);
    expect(isColour(img, 3000 + 530, 3000, colour(8))).toBe(true); // ring mid-line at r = 530
    expect(isColour(img, 3000 + 400, 3000, "#ffffff")).toBe(true); // between disc (r 300) and ring (r ≥ 460)
    expect(isColour(img, 3000 + 800, 3000, "#ffffff")).toBe(true);
  });

  it("407 scattered trees: white dots on the yellow fill, grid anchored at the origin", async () => {
    const sq = makePath([0, 0, 10000, 0, 10000, 10000, 0, 10000], undefined, true);
    const { img } = await draw([{ symbolIdx: PILOT.scatteredTrees407, path: sq }], 40);
    expect(isColour(img, 500, 500, colour(2))).toBe(true); // dot centre, row 0
    expect(isColour(img, 1000, 1500, colour(2))).toBe(true); // shifted row 1
    expect(isColour(img, 1000, 1000, colour(1))).toBe(true); // between dots: fill
    expect(isColour(img, 500, 1500, colour(1))).toBe(true); // row 1 is shifted, so this is fill
  });

  it("213 sandy ground: dots stop at the area edge in clip mode", async () => {
    const sq = makePath([0, 0, 4000, 0, 4000, 4000, 0, 4000], undefined, true);
    const { img } = await draw([{ symbolIdx: PILOT.sandyGround213, path: sq }], 40);
    expect(isColour(img, 800, 800, colour(8))).toBe(true); // grid node inside
    expect(isColour(img, 4000 + 100, 800, "#ffffff")).toBe(true); // the node at x = 4000 is clipped at the edge
    expect(isColour(img, 4000 - 100, 800, colour(8))).toBe(true);
  });

  it("709 out-of-bounds: vertical purple stripes every 1 mm", async () => {
    const sq = makePath([0, 0, 10000, 0, 10000, 10000, 0, 10000], undefined, true);
    const { img } = await draw([{ symbolIdx: PILOT.outOfBounds709, path: sq }]);
    // Lines along 90° satisfy x = k·1000 (normal is (−1, 0)).
    expect(isColour(img, 3000, 5000, colour(9))).toBe(true);
    expect(isColour(img, 3500, 5000, "#ffffff")).toBe(true);
    expect(isColour(img, 3000, 11000, "#ffffff")).toBe(true);
  });

  it("704 control number: purple digits with a white halo over a black line", async () => {
    const { img, stream } = await draw(
      [
        { symbolIdx: PILOT.roadFramed503, path: makePath([0, 1500, 12000, 1500]) },
        { symbolIdx: PILOT.controlNumber704, path: makePath([1000, 0]), text: "11" },
      ],
      40,
    );
    const texts = stream.passes.filter((p) => p.kind === "text");
    expect(texts).toHaveLength(2);
    const em = (texts[1] as { sizeUm: number }).sizeUm;
    // A "1" in Liberation Sans has its stem roughly 45–55 % of the advance (1139/2048 em) from the origin.
    const stemX = 1000 + (0.5 * 1139 * em) / 2048;
    expect(isColour(img, stemX, 1500, colour(11))).toBe(true); // stem crosses the line: purple on top
    // Somewhere along the line inside the text's extent the white halo must knock the black line out.
    let halo = 0;
    for (let x = 1000; x < 1000 + em; x += 10) if (isColour(img, x, 1500, colour(10), 12)) halo++;
    expect(halo).toBeGreaterThan(0);
    expect(isColour(img, 10000, 1500, colour(8))).toBe(true); // the line beyond the text is black
  });
});
