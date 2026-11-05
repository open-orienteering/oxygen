import { describe, expect, it } from "vitest";
import { fixtureColours, renderFixtures } from "../__fixtures__/streams/index.js";
import { COORD_FLAG, makePath } from "../pass-stream.js";
import { passStreamBounds, passStreamToSvg, pathToSvgD } from "../reference-svg.js";
import { passStreamFromJson } from "../stream-json.js";
import { strokeOutline } from "../geometry.js";
import { symbolise } from "../symbolise.js";
import { PILOT, pilotSymbols } from "../__fixtures__/pilot-symbols.js";

const colour = (i: number) => fixtureColours[i] ?? "#ff00ff";

describe("pathToSvgD", () => {
  it("emits M/L and closes when the path is closed", () => {
    expect(pathToSvgD(makePath([0, 0, 10, 0, 10, 10], undefined, true))).toBe("M0 0L10 0L10 10Z");
    expect(pathToSvgD(makePath([0, 0, 10, 0]))).toBe("M0 0L10 0");
  });
  it("emits C for Bézier control points", () => {
    expect(pathToSvgD(makePath([0, 0, 3, 10, 7, -10, 10, 0], [0, 1, 2, 0]))).toBe("M0 0C3 10 7 -10 10 0");
  });
  it("starts a new subpath per hole ring", () => {
    const p = makePath([0, 0, 10, 0, 10, 10, 2, 2, 4, 2, 4, 4], [0, 0, 0, COORD_FLAG.hole, 0, 0], true);
    expect(pathToSvgD(p)).toBe("M0 0L10 0L10 10ZM2 2L4 2L4 4Z");
  });
});

describe("passStreamBounds", () => {
  it("covers geometry of every pass kind", () => {
    expect(passStreamBounds(passStreamFromJson(renderFixtures["fill-with-holes"]))).toEqual({ minX: 0, minY: 0, maxX: 20000, maxY: 20000 });
    const g = passStreamBounds(passStreamFromJson(renderFixtures["glyph-instances"]));
    expect(g).toBeDefined();
    // Instance at (15000, 5000) with scale 1.5 and a glyph reaching 1600 µm → extends past 17000.
    expect(g!.maxX).toBeGreaterThan(17000);
  });
  it("is undefined for an empty stream", () => {
    expect(passStreamBounds(passStreamFromJson({ objectIdx: [], symbolIdx: [], passes: [] }))).toBeUndefined();
  });
});

describe("passStreamToSvg", () => {
  it("sizes the image from bounds and px/mm and flips y", () => {
    const svg = passStreamToSvg(passStreamFromJson(renderFixtures["fill-with-holes"]), { colour, marginUm: 0, pxPerMm: 10 });
    expect(svg).toContain('width="200" height="200"');
    expect(svg).toContain('viewBox="0 -20000 20000 20000"');
    expect(svg).toContain('<g transform="scale(1 -1)">');
  });

  it("draws passes in canonical order with pass metadata", () => {
    const svg = passStreamToSvg(passStreamFromJson(renderFixtures["colour-order"]), { colour });
    const kinds = [...svg.matchAll(/data-pass="(\d+)" data-kind="(\w+)" data-colour="(\d+)"/g)].map((m) => `${m[1]}:${m[2]}:${m[3]}`);
    expect(kinds).toEqual(["0:fill:1", "1:stroke:3", "2:stroke:3", "3:glyph:5", "4:stroke:6"]);
    expect(svg.indexOf('fill="#ffba35"')).toBeLessThan(svg.indexOf('stroke="#d15c00"'));
  });

  it("renders holes as subpaths with the even-odd rule", () => {
    const svg = passStreamToSvg(passStreamFromJson(renderFixtures["fill-with-holes"]), { colour });
    expect(svg).toContain('fill-rule="evenodd"');
    expect(svg).toContain("ZM4000 4000");
  });

  it("draws a tapered pointed stroke as the shared strokeOutline, filled non-zero", () => {
    const stream = passStreamFromJson({
      objectIdx: [0],
      symbolIdx: [107],
      passes: [
        { kind: "stroke", colour: 5, path: { coords: [0, 0, 10000, 0] }, widthUm: 250, cap: "pointed", join: "round", taper: { startUm: 750, endUm: 750 } },
      ],
    });
    const svg = passStreamToSvg(stream, { colour });
    const outline = strokeOutline(makePath([0, 0, 10000, 0]), { widthUm: 250, join: "round", taper: { startUm: 750, endUm: 750 } });
    expect(svg).toContain(`d="${pathToSvgD(outline, true)}" fill="#000000" fill-rule="nonzero"`);
    expect(svg).not.toContain('stroke="#000000"');
  });

  it("draws a pointed stroke without taper as a butt stroke", () => {
    const stream = passStreamFromJson({
      objectIdx: [0],
      symbolIdx: [107],
      passes: [{ kind: "stroke", colour: 5, path: { coords: [0, 0, 10000, 0] }, widthUm: 250, cap: "pointed", join: "round" }],
    });
    expect(passStreamToSvg(stream, { colour })).toContain('stroke-linecap="butt"');
  });

  it("renders dash slices as separate subpaths of one stroke element", () => {
    const svg = passStreamToSvg(passStreamFromJson(renderFixtures["dashed-bezier-stroke"]), { colour });
    const dashed = svg.match(/<path data-pass="1"[^>]*data-slices="4"[^>]*d="([^"]*)"/);
    expect(dashed).not.toBeNull();
    expect(dashed![1].split("M").length - 1).toBe(4);
    expect(dashed![1]).toMatch(/C/);
    expect(svg).toContain('stroke-width="500"');
    expect(svg).toContain('stroke-linecap="butt"');
  });

  it("defines each glyph part once per colour and instances it with a matrix", () => {
    const svg = passStreamToSvg(passStreamFromJson(renderFixtures["glyph-instances"]), { colour });
    expect(svg.match(/<g id="glyph-1-0-c2">/g)).toHaveLength(1);
    expect(svg.match(/<g id="glyph-1-1-c5">/g)).toHaveLength(1);
    expect(svg.match(/<use href="#glyph-1-0-c2"/g)).toHaveLength(3);
    expect(svg).toContain('transform="matrix(1.061 1.061 -1.061 1.061 15000 5000)"');
  });

  it("clips hatch lines to the area", () => {
    const svg = passStreamToSvg(passStreamFromJson(renderFixtures["hatch-area"]), { colour });
    expect(svg).toMatch(/<clipPath id="clip0"><path d="M0 0L20000 2000/);
    expect(svg).toMatch(/<g data-pass="0" data-kind="hatch" data-colour="2" clip-path="url\(#clip0\)">/);
    expect(svg).toContain('stroke-width="250"');
  });

  it("draws text as em boxes when no glyph outlines are supplied, halo as outline", () => {
    const svg = passStreamToSvg(passStreamFromJson(renderFixtures["text-with-halo"]), { colour });
    const rects = svg.match(/<rect /g) ?? [];
    expect(rects).toHaveLength(1 + 6); // background + 3 halo boxes + 3 fill boxes
    expect(svg).toContain('stroke-width="400"');
  });

  it("uses glyph outlines when provided", () => {
    const svg = passStreamToSvg(passStreamFromJson(renderFixtures["text-with-halo"]), {
      colour,
      glyphOutline: () => ({ path: makePath([0, 0, 500, 0, 500, 700, 0, 700], undefined, true), unitsPerEm: 1000 }),
    });
    expect(svg).toContain('transform="matrix(3 0 0 3 1000 5000)"');
    expect(svg).not.toContain('<rect x="1000"');
  });

  it("rotates each glyph outline by its angle about its own origin", () => {
    const j = renderFixtures["text-with-halo"];
    const rotated = { ...j, passes: j.passes.map((p) => (p.kind === "text" ? { ...p, angles: p.glyphs.map(() => 90) } : p)) };
    const svg = passStreamToSvg(passStreamFromJson(rotated), {
      colour,
      glyphOutline: () => ({ path: makePath([0, 0, 500, 0, 500, 700, 0, 700], undefined, true), unitsPerEm: 1000 }),
    });
    // k = 3: matrix(k·cos, k·sin, −k·sin, k·cos, x, y) at 90°.
    expect(svg).toContain('transform="matrix(0 3 -3 0 1000 5000)"');
  });

  it("leaves out clipped groups whose clip lies wholly outside explicit bounds (resvg abort guard)", () => {
    const hatch = passStreamFromJson(renderFixtures["hatch-area"]);
    const far = passStreamToSvg(hatch, { colour, bounds: { minX: 100000, minY: 100000, maxX: 120000, maxY: 120000 } });
    expect(far).not.toContain("clipPath");
    expect(far).not.toContain('data-kind="hatch"');
    const partly = passStreamToSvg(hatch, { colour, bounds: { minX: 10000, minY: 10000, maxX: 120000, maxY: 120000 } });
    expect(partly).toContain('data-kind="hatch"');

    const { stream } = symbolise({
      objects: [{ symbolIdx: PILOT.sandyGround213, path: makePath([0, 0, 10000, 0, 10000, 10000, 0, 10000], undefined, true) }],
      symbols: pilotSymbols,
      fonts: [],
    });
    const clippedGlyphs = (svg: string) => (svg.match(/data-kind="glyph"[^>]*clip-path/g) ?? []).length;
    expect(clippedGlyphs(passStreamToSvg(stream, { colour }))).toBeGreaterThan(0);
    expect(clippedGlyphs(passStreamToSvg(stream, { colour, bounds: { minX: 50000, minY: 0, maxX: 60000, maxY: 10000 } }))).toBe(0);
  });

  it("honours explicit bounds and background", () => {
    const svg = passStreamToSvg(passStreamFromJson(renderFixtures["hatch-area"]), {
      colour,
      bounds: { minX: -5000, minY: -5000, maxX: 30000, maxY: 30000 },
      background: "#eeeeee",
      pxPerMm: 2,
    });
    expect(svg).toContain('width="70" height="70"');
    expect(svg).toContain('fill="#eeeeee"');
  });
});

describe("passStreamToSvg — filter masks (§3.8)", () => {
  const j = renderFixtures["dashed-bezier-stroke"];
  const a = { coords: [0, -5000, 5000, -5000, 5000, 5000, 0, 5000], closed: true };
  const b = { coords: [10000, -5000, 15000, -5000, 15000, 5000], closed: true };
  it("a masked pass is nested in one clip group per region: the frame with the region as an even-odd hole", () => {
    const stream = passStreamFromJson({ ...j, masks: [{ regions: [a, b] }], maskIdx: [0, -1] });
    const svg = passStreamToSvg(stream, { colour, bounds: { minX: -1000, minY: -20000, maxX: 21000, maxY: 20000 } });
    const clips = [...svg.matchAll(/<clipPath id="(mask\d+)"><path d="([^"]*)" clip-rule="evenodd" fill-rule="evenodd"\/><\/clipPath>/g)];
    expect(clips).toHaveLength(2);
    expect(clips[0][2]).toBe("M-1000 -20000L21000 -20000L21000 20000L-1000 20000ZM0 -5000L5000 -5000L5000 5000L0 5000Z");
    expect(svg).toContain(`<g data-mask="0" clip-path="url(#${clips[0][1]})"><g clip-path="url(#${clips[1][1]})"><path data-pass="0"`);
    // The unmasked pass is not wrapped.
    expect(svg).toMatch(/<\/g><\/g><path data-pass="1"/);
  });
  it("masks share their clip paths; a stream without masks has none", () => {
    const stream = passStreamFromJson({ ...j, masks: [{ regions: [a] }], maskIdx: [0, 0] });
    expect([...passStreamToSvg(stream, { colour }).matchAll(/<clipPath id="mask/g)]).toHaveLength(1);
    expect(passStreamToSvg(passStreamFromJson(j), { colour })).not.toContain("mask");
  });
});
