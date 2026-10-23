/**
 * Tier 1 (research 05 §7): the operator sequence per fixture stream.
 */

import { describe, expect, it } from "vitest";
import { renderFixtures } from "../../render/__fixtures__/streams/index.js";
import { libraryScene, librarySceneNames } from "../../render/__fixtures__/library/index.js";
import { liberation } from "../../render/__tests__/fonts.js";
import { strokeOutline } from "../../render/geometry.js";
import { type FontRef, type GlyphMesh, type PassStream, makePath } from "../../render/pass-stream.js";
import { passStreamFromJson } from "../../render/stream-json.js";
import { symbolise } from "../../render/symbolise.js";
import type { ColourMode } from "../colour.js";
import {
  type OperatorResources,
  clipOperators,
  cmOperator,
  glyphFormBBox,
  glyphFormContent,
  mapLayerOperators,
  passStreamOperators,
  pathOperators,
  UM_TO_PT,
  layerMatrix,
} from "../operators.js";

/** The contract fixtures' stack (0 white … 7 lower purple) with distinct CMYK. */
const stack: { cmyk: [number, number, number, number] }[] = [
  { cmyk: [0, 0, 0, 0] },
  { cmyk: [0, 0.27, 0.79, 0] },
  { cmyk: [0.76, 0, 0.91, 0] },
  { cmyk: [0, 0.56, 1, 0.18] },
  { cmyk: [1, 0, 0, 0] },
  { cmyk: [0, 0, 0, 1] },
  { cmyk: [0.35, 0.85, 0, 0] },
  { cmyk: [0.35, 0.85, 0, 0] },
];

function resources(opts: { fonts?: boolean } = {}) {
  const used: { font: FontRef; glyphs: number[] }[] = [];
  const glyphs: GlyphMesh[] = [];
  const res: OperatorResources = {
    font: (font, ids) => {
      used.push({ font, glyphs: Array.from(ids) });
      return opts.fonts === false ? undefined : "F1";
    },
    glyphOutline: (font, gid) => {
      const f = liberation()[font.family === "liberation-sans-narrow" ? "narrow" : "sans"];
      const path = f.outline(gid);
      return path ? { path, unitsPerEm: f.unitsPerEm } : undefined;
    },
    glyph: (mesh) => {
      if (!glyphs.includes(mesh)) glyphs.push(mesh);
      return `G${glyphs.indexOf(mesh) + 1}`;
    },
  };
  return { res, used, glyphs };
}

const ops = (name: keyof typeof renderFixtures, mode: ColourMode = "cmyk", origin?: [number, number]) =>
  passStreamOperators(passStreamFromJson(renderFixtures[name]), { colours: stack, mode, resources: resources().res, originUm: origin });

const lines = (s: string) => s.split("\n");

describe("fill", () => {
  it("is the path with every ring closed, even-odd, in the stack's CMYK", () => {
    expect(lines(ops("fill-with-holes"))).toEqual([
      "0 0.27 0.79 0 k",
      "0 0 m 20000 0 l 20000 20000 l 0 20000 l h 4000 4000 m 8000 4000 l 8000 8000 l 4000 8000 l h 12000 12000 m 15000 12000 l 15000 15000 l 12000 15000 l h f*",
    ]);
  });

  it("writes coordinates relative to the origin, as integers", () => {
    expect(ops("fill-with-holes", "cmyk", [10000, -5000])).toContain("-10000 5000 m 10000 5000 l");
  });
});

describe("stroke", () => {
  it("keeps Béziers as c and sets w J j", () => {
    const o = lines(ops("dashed-bezier-stroke"));
    expect(o.slice(0, 3)).toEqual(["0 0.56 1 0.18 K", "350 w 0 J 1 j", "0 0 m 6000 12000 14000 -12000 20000 0 c S"]);
  });

  it("draws dash slices as one subpath per slice and never uses d", () => {
    const o = ops("dashed-bezier-stroke");
    const dashed = lines(o).at(-1)!;
    expect(dashed.match(/ m /g)).toHaveLength(4);
    expect(dashed.match(/ c/g)).toHaveLength(4);
    expect(dashed.endsWith(" S")).toBe(true);
    expect(o).not.toMatch(/\] \d+ d\b/);
    expect(lines(o)).toContain("500 w 0 j");
  });

  it("draws pointed + taper as the shared outline, filled non-zero", () => {
    const path = makePath([0, 0, 10000, 0]);
    const stream = passStreamFromJson({
      objectIdx: [0],
      symbolIdx: [107],
      passes: [{ kind: "stroke", colour: 5, path: { coords: [0, 0, 10000, 0] }, widthUm: 250, cap: "pointed", join: "round", taper: { startUm: 750, endUm: 750 } }],
    });
    const o = lines(passStreamOperators(stream, { colours: stack, mode: "cmyk", resources: resources().res }));
    const outline = strokeOutline(path, { widthUm: 250, join: "round", taper: { startUm: 750, endUm: 750 } });
    expect(o).toEqual(["0 0 0 1 k", `${pathOperators(outline, [0, 0], true)} f`]);
  });

  it("draws pointed without taper as a butt stroke", () => {
    const stream = passStreamFromJson({
      objectIdx: [0],
      symbolIdx: [107],
      passes: [{ kind: "stroke", colour: 5, path: { coords: [0, 0, 10000, 0] }, widthUm: 250, cap: "pointed", join: "round" }],
    });
    expect(passStreamOperators(stream, { colours: stack, mode: "cmyk", resources: resources().res })).toContain("250 w 0 J 1 j");
  });
});

describe("glyph", () => {
  it("draws each instance as q cm /Gn Do Q with the colours of the part set", () => {
    const { res, glyphs } = resources();
    const o = lines(passStreamOperators(passStreamFromJson(renderFixtures["glyph-instances"]), { colours: stack, mode: "cmyk", resources: res }));
    expect(glyphs).toHaveLength(2);
    expect(o).toEqual([
      "0.76 0 0.91 0 k",
      "q 1 0 0 1 5000 5000 cm /G1 Do Q",
      "q 1.06065 1.06065 -1.06065 1.06065 15000 5000 cm /G1 Do Q",
      "q 0.75 0 0 0.75 10000 15000 cm /G1 Do Q",
      "0 0 0 1 K",
      "q 1 0 0 1 5000 5000 cm /G2 Do Q",
      "q 1.06065 1.06065 -1.06065 1.06065 15000 5000 cm /G2 Do Q",
      "q 0.75 0 0 0.75 10000 15000 cm /G2 Do Q",
    ]);
  });

  it("form content: fills f*, strokes w J j S, no colour; bbox covers stroke mitres", () => {
    const stream = passStreamFromJson(renderFixtures["glyph-instances"]);
    expect(glyphFormContent(stream.glyphTable[0])).toBe("-1000 -800 m 1000 -800 l 0 1200 l h f*");
    expect(glyphFormContent(stream.glyphTable[1])).toBe("250 w 0 J 0 j 0 -800 m 0 -1600 l S");
    expect(glyphFormBBox(stream.glyphTable[1])).toEqual([-500, -2100, 500, -300]);
  });

  it("clips a clip-mode pattern with W* n inside q … Q", () => {
    const scene = libraryScene("lib-pattern");
    const { stream } = symbolise({ objects: scene.objects, symbols: scene.symbols, fonts: [] });
    const clipped = stream.passes.filter((p) => p.kind === "glyph" && p.clip);
    expect(clipped.length).toBeGreaterThan(0);
    const o = passStreamOperators(stream, { colours: scene.colours, mode: "cmyk", resources: resources().res });
    const blocks = o.match(/\nq\n[^\n]* W\* n\n(?:q [^\n]* Do Q\n)+Q/g) ?? [];
    expect(blocks).toHaveLength(clipped.length);
  });
});

describe("hatch", () => {
  it("clips explicit lines to the area: q path W* n w … S Q", () => {
    const o = lines(ops("hatch-area"));
    expect(o[0]).toBe("0.76 0 0.91 0 K");
    expect(o[1]).toBe("q");
    expect(o[2]).toMatch(/^0 0 m 20000 2000 l 24000 14000 l 10000 22000 l -2000 12000 l h W\* n$/);
    expect(o[3]).toBe("250 w 0 J 0 j");
    expect(o[4]).toMatch(/^(-?\d+ -?\d+ m -?\d+ -?\d+ l )+S$/);
    expect(o[5]).toBe("Q");
  });
});

describe("text", () => {
  it("draws the halo pass first with 1 Tr at twice the halo width, then the fill with 0 Tr", () => {
    const { res, used } = resources();
    const o = lines(passStreamOperators(passStreamFromJson(renderFixtures["text-with-halo"]), { colours: stack, mode: "cmyk", resources: res }));
    expect(o).toEqual([
      "0 0 0 0 K",
      "400 w 1 J 1 j",
      "BT /F1 3000 Tf 1 Tr",
      "1 0 0 1 1000 5000 Tm <0024> Tj",
      "1 0 0 1 3000 5000 Tm <0025> Tj",
      "1 0 0 1 5000 5000 Tm <0026> Tj",
      "ET",
      "0 0 0 1 k",
      "BT /F1 3000 Tf 0 Tr",
      "1 0 0 1 1000 5000 Tm <0024> Tj",
      "1 0 0 1 3000 5000 Tm <0025> Tj",
      "1 0 0 1 5000 5000 Tm <0026> Tj",
      "ET",
    ]);
    expect(used.map((u) => u.glyphs)).toEqual([[36, 37, 38], [36, 37, 38]]);
  });

  it("rotates a glyph with angles by its own Tm", () => {
    const stream = passStreamFromJson({
      objectIdx: [0],
      symbolIdx: [0],
      passes: [{ kind: "text", colour: 5, fontId: 0, sizeUm: 2000, glyphs: [36, 37], positions: [0, 0, 1000, 0], angles: [90, 0] }],
      fontTable: [{ fontId: 0, family: "liberation-sans", bold: false, italic: false }],
    });
    const o = lines(passStreamOperators(stream, { colours: stack, mode: "cmyk", resources: resources().res }));
    expect(o).toContain("0 1 -1 0 0 0 Tm <0024> Tj");
    expect(o).toContain("1 0 0 1 1000 0 Tm <0025> Tj");
  });

  it("falls back to the glyph outlines (f*) when no font is embedded", () => {
    const { res } = resources({ fonts: false });
    const o = passStreamOperators(passStreamFromJson(renderFixtures["text-with-halo"]), { colours: stack, mode: "cmyk", resources: res });
    expect(o).not.toContain("BT");
    const k = 3000 / liberation().sans.unitsPerEm;
    expect(o).toContain(`q ${cmOperator([k, 0, 0, k, 1000, 5000])} `);
    expect(o).toMatch(/ f\* Q/);
    // halo: stroked outlines, width in font units
    expect(o).toContain(` ${Math.round(((2 * 200) / k) * 1000) / 1000} w `);
  });
});

describe("colour", () => {
  const all: { name: string; stream: PassStream; colours: { cmyk: [number, number, number, number] }[] }[] = [
    ...(Object.keys(renderFixtures) as (keyof typeof renderFixtures)[]).map((n) => ({ name: n, stream: passStreamFromJson(renderFixtures[n]), colours: stack })),
    ...librarySceneNames.map((n) => {
      const scene = libraryScene(n);
      const fonts = [liberation().sans, liberation().narrow];
      return { name: n, stream: symbolise({ objects: scene.objects, symbols: scene.symbols, fonts }).stream, colours: scene.colours };
    }),
  ];

  it.each(all.map((s) => [s.name, s] as const))("%s: no rg in cmyk mode, no k in rgb mode", (_n, s) => {
    const cmyk = passStreamOperators(s.stream, { colours: s.colours, mode: "cmyk", resources: resources().res });
    const rgb = passStreamOperators(s.stream, { colours: s.colours, mode: "rgb", resources: resources().res });
    expect(cmyk).not.toMatch(/ (rg|RG)$/m);
    expect(rgb).not.toMatch(/ (k|K)$/m);
    expect(cmyk.length).toBeGreaterThan(0);
  });

  it("k values are the stack's CMYK, one colour change per colour", () => {
    const o = ops("colour-order");
    const setters = o.split("\n").filter((l) => / [kK]$/.test(l));
    expect(setters).toEqual(["0 0.27 0.79 0 k", "0 0.56 1 0.18 K", "0 0 0 1 k", "0.35 0.85 0 0 K"]);
  });

  it("rgb mode uses the shared naive sRGB", () => {
    expect(ops("fill-with-holes", "rgb").split("\n")[0]).toBe("1 0.7294 0.2118 rg");
  });
});

describe("map layer", () => {
  it("puts the passes under one cm with the mitre limit; µm → pt at the print scale", () => {
    // a 1:15 000 map printed at 1:10 000, centred on an A4 portrait page
    const matrix = layerMatrix({ scaleRatio: 1.5, atPt: [297.638, 420.945] });
    expect(matrix[0]).toBeCloseTo(1.5 * UM_TO_PT, 12);
    const o = mapLayerOperators(passStreamFromJson(renderFixtures["fill-with-holes"]), {
      colours: stack,
      mode: "cmyk",
      resources: resources().res,
      originUm: [10000, 10000],
      matrix,
    });
    expect(lines(o).slice(0, 3)).toEqual(["q", "0.004251969 0 0 0.004251969 297.638 420.945 cm", "4 M"]);
    expect(o).toContain("-10000 -10000 m 10000 -10000 l");
    expect(lines(o).at(-1)).toBe("Q");
  });

  it("rotates the layer counter-clockwise", () => {
    const [a, b, c, d] = layerMatrix({ scaleRatio: 1, rotationDeg: 90, atPt: [0, 0] });
    expect([a, b, c, d].map((v) => Math.round(v / UM_TO_PT))).toEqual([0, 1, -1, 0]);
  });

  it("clip regions: W n or W* n", () => {
    const sq = makePath([0, 0, 10, 0, 10, 10], undefined, true);
    expect(clipOperators(sq, "evenodd")).toBe("0 0 m 10 0 l 10 10 l h W* n");
    expect(clipOperators(sq, "nonzero", [5, 5])).toBe("-5 -5 m 5 -5 l 5 5 l h W n");
  });
});
