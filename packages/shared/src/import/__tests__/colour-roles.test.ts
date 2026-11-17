/**
 * Colour roles (docs/map-symbols.md §9.3 "Roles", row I2): every colour
 * reference of a symbol's render is a use with a part, and each use gets a
 * palette id of the alignment palette — from the matched or suggested
 * library entry, else the rule table, else none. Synthetic symbols shaped
 * like the corpus cases; no club map geometry.
 */

import { describe, expect, it } from "vitest";
import { formatRenderPath } from "../../render/transform.js";
import { parseRenderSymbol, type RenderSymbol } from "../../render/symbol.js";
import { colourUses } from "../colour-roles.js";

const disc = (colour: number) => ({ kind: "disc" as const, colour, diameterUm: 200 });
const stroke = (colour: number) => ({ kind: "stroke" as const, colour, widthUm: 140, geometry: { coords: [0, 0, 0, 400] } });

const sym = (input: Record<string, unknown>): RenderSymbol => parseRenderSymbol({ id: "s", code: "1", name: "s", ...input });

const parts = (render: RenderSymbol) => colourUses(render).map((u) => [formatRenderPath(u.path), u.colour, u.part]);

describe("colourUses", () => {
  it("names the parts of an area: fill, hatch, pattern, border", () => {
    const render = sym({
      type: "area", fill: 1,
      hatches: [{ colour: 2, widthUm: 100, spacingUm: 400 }],
      patterns: [{ glyph: { parts: [disc(3)], rotatable: false }, cellWidthUm: 500, cellHeightUm: 500 }],
      border: { main: { colour: 3, widthUm: 100 }, borders: { left: { colour: 4, widthUm: 100, shiftUm: 50 } } },
    });
    expect(parts(render)).toEqual([
      ["fill", 1, "area-fill"],
      ["hatches[0].colour", 2, "area-hatch"],
      ["patterns[0].glyph.parts[0].colour", 3, "area-pattern"],
      ["border.main.colour", 3, "area-border"],
      ["border.borders.left.colour", 4, "area-border"],
    ]);
  });

  it("names the parts of a line: main, halo, outline pairs, infill, glyphs", () => {
    const render = sym({
      type: "line",
      main: { colour: 5, widthUm: 250, halo: { colour: 0, widthUm: 50 } },
      borders: {
        left: { colour: 0, widthUm: 140, shiftUm: 290 }, right: { colour: 0, widthUm: 140, shiftUm: 290 }, backgroundColour: 5,
        extraPairs: [{ left: { colour: 6, widthUm: 100, shiftUm: 500 } }],
      },
      glyphs: [{ glyph: { parts: [stroke(0)], rotatable: true }, placement: { at: "start" } }],
    });
    expect(parts(render)).toEqual([
      ["main.colour", 5, "line-main"],
      ["main.halo.colour", 0, "line-halo"],
      ["borders.left.colour", 0, "line-outline"],
      ["borders.right.colour", 0, "line-outline"],
      ["borders.backgroundColour", 5, "line-infill"],
      ["borders.extraPairs[0].left.colour", 6, "line-outline"],
      ["glyphs[0].glyph.parts[0].colour", 0, "line-glyph"],
    ]);
  });

  it("names a point's glyph parts and a text's colour, halo, shadow and frame", () => {
    expect(parts(sym({ type: "point", glyph: { parts: [disc(0), stroke(2)], rotatable: false } }))).toEqual([
      ["glyph.parts[0].colour", 0, "point-glyph"],
      ["glyph.parts[1].colour", 2, "point-glyph"],
    ]);
    const text = sym({
      type: "text", fontFamily: "liberation-sans", fontSizeUm: 2000, colour: 0,
      halo: { colour: 7, widthUm: 100 }, shadow: { colour: 2, offsetXUm: 10, offsetYUm: 10 }, frame: { colour: 8, leftUm: 0, bottomUm: 0, rightUm: 0, topUm: 0 },
    });
    expect(parts(text).map(([, , p]) => p)).toEqual(["text", "text-halo", "text-shadow", "text-frame"]);
  });
});
