import { describe, expect, it } from "vitest";
import { parseRenderSymbol } from "../symbol.js";
import { formatColourPath, mapRenderColourRefs, remapRenderColours, renderColourPaths, renderColourRefs } from "../transform.js";

const stroke = (colour: number) => ({ kind: "stroke" as const, colour, widthUm: 100, geometry: { coords: [0, 0, 100, 0] } });

/** A road-like double line with a black outline both sides, brown infill, and black ticks on the same black (one colour, three uses). */
const road = parseRenderSymbol({
  type: "line", id: "502", code: "502", name: "Road",
  borders: { left: { colour: 0, widthUm: 140, shiftUm: 290 }, right: { colour: 0, widthUm: 140, shiftUm: 290 }, backgroundColour: 3 },
  glyphs: [{ glyph: { parts: [stroke(0)], rotatable: true }, placement: { at: "corners" } }],
});

/** A paved area: brown fill, a dot pattern, a bordered edge with a halo. */
const paved = parseRenderSymbol({
  type: "area", id: "501", code: "501", name: "Paved",
  fill: 3,
  patterns: [{ glyph: { parts: [{ kind: "disc", colour: 0, diameterUm: 100 }], rotatable: false }, cellWidthUm: 500, cellHeightUm: 500 }],
  border: { main: { colour: 0, widthUm: 100, halo: { colour: 5, widthUm: 50 } } },
});

const text = parseRenderSymbol({
  type: "text", id: "t", code: "1", name: "Text", fontFamily: "liberation-sans", fontSizeUm: 2000, colour: 0,
  halo: { colour: 7, widthUm: 100 }, shadow: { colour: 2, offsetXUm: 10, offsetYUm: -10 }, frame: { colour: 8, leftUm: 0, bottomUm: 0, rightUm: 0, topUm: 0 },
});

describe("renderColourPaths", () => {
  it("lists every reference with its own path, one colour used three times as three entries", () => {
    const refs = renderColourPaths(road).map((r) => [formatColourPath(r.path), r.colour]);
    expect(refs).toEqual([
      ["borders.left.colour", 0],
      ["borders.right.colour", 0],
      ["borders.backgroundColour", 3],
      ["glyphs[0].glyph.parts[0].colour", 0],
    ]);
    // The distinct list is still what it was.
    expect(renderColourRefs(road)).toEqual([0, 3]);
  });

  it("reaches area fills, pattern glyph parts, borders and halos", () => {
    expect(renderColourPaths(paved).map((r) => formatColourPath(r.path))).toEqual([
      "fill",
      "patterns[0].glyph.parts[0].colour",
      "border.main.colour",
      "border.main.halo.colour",
    ]);
  });

  it("reaches a text's colour, halo, shadow and frame", () => {
    expect(renderColourPaths(text).map((r) => [formatColourPath(r.path), r.colour])).toEqual([
      ["colour", 0],
      ["halo.colour", 7],
      ["shadow.colour", 2],
      ["frame.colour", 8],
    ]);
  });

  it("returns paths as fresh arrays (not the walker's working stack)", () => {
    const [a, b] = renderColourPaths(road);
    expect(a.path).toEqual(["borders", "left", "colour"]);
    expect(b.path).toEqual(["borders", "right", "colour"]);
  });
});

describe("mapRenderColourRefs", () => {
  it("re-indexes per reference: the glyph's black and the outline's black part ways", () => {
    const out = mapRenderColourRefs(road, (r) => (r.path[0] === "glyphs" ? 9 : r.colour + 10));
    expect(renderColourPaths(out).map((r) => r.colour)).toEqual([10, 10, 13, 9]);
    expect(out.type).toBe("line");
  });

  it("is the identity when fn returns the colour, and agrees with remapRenderColours for a per-colour map", () => {
    expect(mapRenderColourRefs(paved, (r) => r.colour)).toEqual(paved);
    const map = [4, 4, 4, 1, 4, 2];
    expect(mapRenderColourRefs(paved, (r) => map[r.colour])).toEqual(remapRenderColours(paved, map));
  });

  it("rejects an index the IR does not accept", () => {
    expect(() => mapRenderColourRefs(paved, () => -1)).toThrow();
  });
});
