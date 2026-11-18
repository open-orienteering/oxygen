/**
 * §3.10 image passes (slice J, J5): the kind's sort slot, the JSON
 * projection and the comparator, `symbolise` from an image object, the
 * hit-test by the quad, filter regions by the quad, and the reference SVG.
 */

import { describe, expect, it } from "vitest";
import { type ImagePass, type Pass, PASS_KIND_ORDER, imageQuadCorners, makePath, sortPassStream } from "../pass-stream.js";
import { passStreamBounds, passStreamToSvg } from "../reference-svg.js";
import { diffPassStreams, passStreamFromJson, passStreamToJson } from "../stream-json.js";
import { symbolise } from "../symbolise.js";
import { hitTest } from "../hit-test.js";
import { passMeetsRegion, regionRings } from "../filter-region.js";
import { parseRenderSymbol } from "../symbol.js";

/** A 20 × 10 mm image at (10, 5) mm, unrotated. */
const QUAD: ImagePass["quad"] = [20000, 0, 0, 10000, 10000, 5000];
const image = (extra: Partial<ImagePass> = {}): ImagePass => ({ kind: "image", colour: 3, graphicId: 7, quad: QUAD, ...extra });
const stream = (passes: Pass[]) => ({ objectIdx: Uint32Array.from(passes.map((_, i) => i)), symbolIdx: new Uint32Array(passes.length), passes, glyphTable: [], fontTable: [] });
const fill = (colour: number): Pass => ({ kind: "fill", colour, rule: "evenodd", path: makePath([0, 0, 50000, 0, 50000, 50000, 0, 50000], undefined, true) });

describe("§3.10 the image pass in the stream", () => {
  it("sorts last within a colour; its quad's corners and bounds", () => {
    expect(PASS_KIND_ORDER.image).toBeGreaterThan(Math.max(PASS_KIND_ORDER.fill, PASS_KIND_ORDER.hatch, PASS_KIND_ORDER.stroke, PASS_KIND_ORDER.glyph, PASS_KIND_ORDER.text));
    const sorted = sortPassStream(stream([image(), fill(3), fill(2)]));
    expect(sorted.passes.map((p) => p.kind)).toEqual(["fill", "fill", "image"]);
    expect(imageQuadCorners(QUAD)).toEqual([[10000, 5000], [30000, 5000], [30000, 15000], [10000, 15000]]);
    expect(passStreamBounds(stream([image()]))).toEqual({ minX: 10000, minY: 5000, maxX: 30000, maxY: 15000 });
  });

  it("round-trips through the JSON projection (quad 3 decimals, crop 6, alpha); the comparator names what differs", () => {
    const a = stream([image({ quad: [20000.0004, 0, 0, 10000, 10000, 5000], crop: { x: 0.25, y: 0, width: 0.5, height: 1 }, opacity: 0.5, blend: "multiply" })]);
    const j = passStreamToJson(a);
    expect(j.passes[0]).toEqual({ kind: "image", colour: 3, graphicId: 7, quad: [20000, 0, 0, 10000, 10000, 5000], crop: { x: 0.25, y: 0, width: 0.5, height: 1 }, opacity: 0.5, blend: "multiply" });
    const back = passStreamFromJson(JSON.parse(JSON.stringify(j)));
    expect(diffPassStreams(a, back)).toEqual([]);
    for (const bad of [{ x: 0, y: 0, width: 0, height: 1 }, { x: -0.1, y: 0, width: 0.5, height: 1 }, { x: 0, y: 0, width: 1, height: 1.5 }]) {
      expect(() => passStreamFromJson(JSON.parse(JSON.stringify({ ...j, passes: [{ ...j.passes[0], crop: bad }] })))).toThrow();
    }
    const what = (b: ImagePass) => diffPassStreams(stream([image()]), stream([b])).map((d) => d.what).join("; ");
    expect(what(image({ quad: [20000, 0, 0, 10000, 12000, 5000] }))).toMatch(/quad/);
    expect(what(image({ graphicId: 8 }))).toMatch(/graphic 7 vs 8/);
    expect(what(image({ crop: { x: 0.1, y: 0, width: 0.9, height: 1 } }))).toMatch(/crop/);
    expect(what(image({ opacity: 0.5 }))).toMatch(/opacity/);
    expect(what(image({ blend: "multiply" }))).toMatch(/blend/);
  });
});

describe("§3.10 symbolise: an image object draws one image pass in its symbol's fill row", () => {
  const symbols = [parseRenderSymbol({ id: "course:graphics", code: "graphics", name: "Graphics", type: "area", fill: 4 }), parseRenderSymbol({ id: "l", code: "l", name: "l", type: "line", main: { colour: 1, widthUm: 100 } })];
  const corners = (pts: number[]) => makePath(pts, undefined, true);

  it("the quad from the corners (bottom-left, bottom-right, top-right, top-left); opacity, blend and crop carried; object order kept", () => {
    const { stream: s, warnings } = symbolise({
      fonts: [],
      symbols,
      objects: [
        { symbolIdx: 0, path: corners([10000, 5000, 30000, 5000, 30000, 15000, 10000, 15000]), image: { graphicId: 7, crop: { x: 0, y: 0.5, width: 1, height: 0.5 } }, opacity: 0.5, blend: "multiply" },
        // Turned 90° clockwise and flipped: the corner order carries both.
        { symbolIdx: 0, path: corners([0, 20000, 0, 0, 10000, 0, 10000, 20000]), image: { graphicId: 9 } },
      ],
    });
    expect(warnings).toEqual([]);
    expect(s.passes).toEqual([
      { kind: "image", colour: 4, graphicId: 7, quad: [20000, 0, 0, 10000, 10000, 5000], crop: { x: 0, y: 0.5, width: 1, height: 0.5 }, opacity: 0.5, blend: "multiply" },
      { kind: "image", colour: 4, graphicId: 9, quad: [0, -20000, 10000, 0, 0, 20000] },
    ]);
  });

  it("warns and draws nothing without a graphic, with the wrong corner count or without a fill row", () => {
    const { stream: s, warnings } = symbolise({
      fonts: [],
      symbols,
      objects: [
        { symbolIdx: 0, path: corners([0, 0, 1, 0, 1, 1]), image: { graphicId: 7 } },
        { symbolIdx: 0, path: corners([0, 0, 1, 0, 1, 1, 0, 1]), image: { graphicId: 0 } },
        { symbolIdx: 1, path: corners([0, 0, 1, 0, 1, 1, 0, 1]), image: { graphicId: 7 } },
      ],
    });
    expect(s.passes).toEqual([]);
    expect(warnings.map((w) => w.code)).toEqual(["IMAGE_WITHOUT_GRAPHIC", "IMAGE_WITHOUT_GRAPHIC", "IMAGE_WITHOUT_GRAPHIC"]);
  });
});

describe("§3.10 hit-test and filter regions by the quad", () => {
  it("inside is 0 (transparent pixels hit too), near the edge within tolerance, a rotated quad, topmost over a lower fill", () => {
    const s = sortPassStream(stream([fill(1), image()]));
    expect(hitTest(s, 20000, 10000, { toleranceUm: 0 }).map((h) => h.objectIdx)).toEqual([1, 0]);
    expect(hitTest(s, 31000, 10000, { toleranceUm: 1500 }).map((h) => [h.objectIdx, h.distanceUm])).toEqual([[1, 1000], [0, 0]]);
    expect(hitTest(stream([image()]), 31000, 10000, { toleranceUm: 500 })).toEqual([]);
    // 45°: a diamond; its bounding-box corner is outside.
    const r = Math.SQRT1_2 * 10000;
    const diamond = stream([image({ quad: [r, -r, r, r, 0, 0] })]);
    expect(hitTest(diamond, r, 0, { toleranceUm: 0 })).toHaveLength(1);
    expect(hitTest(diamond, 1000, 6000, { toleranceUm: 0 })).toEqual([]);
  });

  it("meets a region when the quad does", () => {
    const region = (x: number) => regionRings(makePath([x, 0, x + 5000, 0, x + 5000, 20000, x, 20000], undefined, true));
    expect(passMeetsRegion(image(), region(25000))).toBe(true);
    expect(passMeetsRegion(image(), region(40000))).toBe(false);
  });
});

describe("§5.1 reference SVG: an image pass", () => {
  const colour = () => "#000000";
  const imageHref = (id: number) => (id === 7 ? "data:image/png;base64,AAAA" : undefined);

  it("the unit square through the quad with v flipped; a crop as the source enlarged under a clip; alpha on the pass group", () => {
    const svg = passStreamToSvg(stream([image({ crop: { x: 0.25, y: 0, width: 0.5, height: 1 }, opacity: 0.5, blend: "multiply" })]), { colour, imageHref });
    expect(svg).toContain('transform="matrix(20000 0 0 10000 10000 5000) matrix(1 0 0 -1 0 1)"');
    expect(svg).toContain('<image x="-0.5" y="0" width="2" height="1" preserveAspectRatio="none" image-rendering="optimizeSpeed" href="data:image/png;base64,AAAA"/>');
    expect(svg).toMatch(/<clipPath id="clip\d+"><rect x="0" y="0" width="1" height="1"\/><\/clipPath>/);
    expect(svg).toMatch(/<g data-alpha="0" opacity="0.5" style="mix-blend-mode:multiply"><g data-pass="0" data-kind="image"/);
  });

  it("is left out without a source", () => {
    expect(passStreamToSvg(stream([image({ graphicId: 8 })]), { colour, imageHref })).not.toContain("<image");
    expect(passStreamToSvg(stream([image()]), { colour })).not.toContain("<image");
  });
});
