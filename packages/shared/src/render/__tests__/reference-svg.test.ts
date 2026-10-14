import { describe, expect, it } from "vitest";
import { fixtureColours, renderFixtures } from "../__fixtures__/streams/index.js";
import { COORD_FLAG, makePath } from "../pass-stream.js";
import { passStreamBounds, passStreamToSvg, pathToSvgD } from "../reference-svg.js";
import { passStreamFromJson } from "../stream-json.js";

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
