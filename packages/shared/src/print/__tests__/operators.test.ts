/**
 * Tier 1 (research 05 §7): the operator sequence per fixture stream.
 */

import { describe, expect, it } from "vitest";
import { renderFixtures } from "../../render/__fixtures__/streams/index.js";
import { libraryScene, librarySceneNames } from "../../render/__fixtures__/library/index.js";
import { liberation } from "../../render/__tests__/fonts.js";
import { strokeOutline } from "../../render/geometry.js";
import { pathBounds } from "../../render/path.js";
import { type FontRef, type GlyphMesh, type PassStream, makePath } from "../../render/pass-stream.js";
import { passStreamFromJson } from "../../render/stream-json.js";
import { passStreamBounds } from "../../render/reference-svg.js";
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
  CHAIN_LENGTH,
  FILTER_FRAME_MARGIN_UM,
  GLYPH_FORM_REUSE,
  filterClipPath,
  PRINT_GRID_UM,
  PRINT_QUANTUM_UM,
  UM_TO_PT,
  layerMatrix,
  layerUnitUm,
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

  it("writes coordinates relative to the origin, as integers, under the path's own corner anchor", () => {
    // Corner (0, 0) − origin (10000, −5000) = (−10000, 5000): the anchor; the rings from it.
    expect(ops("fill-with-holes", "cmyk", [10000, -5000])).toContain("q 1 0 0 1 -10000 5000 cm 0 0 m 20000 0 l");
    expect(ops("fill-with-holes", "cmyk", [10000, -5000])).toMatch(/ f\* Q$/);
  });

  it("leaves a ring's closing line back onto its start to h", () => {
    const stream = passStreamFromJson({
      objectIdx: [0],
      symbolIdx: [0],
      passes: [{ kind: "fill", colour: 5, path: { coords: [0, 0, 1000, 0, 1000, 1000, 0, 0] } }],
    });
    expect(lines(passStreamOperators(stream, { colours: stack, mode: "cmyk", resources: resources().res })).at(-1)).toBe("0 0 m 1000 0 l 1000 1000 l h f*");
  });

  it("keeps a closed stroke's last line: the join at the start is the stream's", () => {
    const stream = passStreamFromJson({
      objectIdx: [0],
      symbolIdx: [0],
      passes: [{ kind: "stroke", colour: 5, path: { coords: [0, 0, 1000, 0, 1000, 1000, 0, 0], closed: true }, widthUm: 100, cap: "butt", join: "miter" }],
    });
    expect(lines(passStreamOperators(stream, { colours: stack, mode: "cmyk", resources: resources().res })).at(-1)).toBe("0 0 m 1000 0 l 1000 1000 l 0 0 l h S");
  });
});

describe("stroke", () => {
  it("keeps Béziers as c and sets w J j", () => {
    const o = lines(ops("dashed-bezier-stroke"));
    // Anchored at the control hull's corner (0, −12000).
    expect(o.slice(0, 3)).toEqual(["0 0.56 1 0.18 K", "350 w 0 J 1 j", "q 1 0 0 1 0 -12000 cm 0 12000 m 6000 24000 14000 0 20000 12000 c S Q"]);
  });

  it("draws dash slices as one subpath per slice and never uses d", () => {
    const o = ops("dashed-bezier-stroke");
    const dashed = lines(o).at(-1)!;
    expect(dashed.match(/ m /g)).toHaveLength(4);
    expect(dashed.match(/ c /g)).toHaveLength(4);
    expect(dashed.endsWith(" S Q")).toBe(true);
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
    const b = pathBounds(outline);
    const [ax, ay] = [Math.floor(b.minX), Math.floor(b.minY)];
    expect(o).toEqual(["0 0 0 1 k", `q 1 0 0 1 ${ax} ${ay} cm ${pathOperators(outline, [ax, ay], true)} f Q`]);
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
  it("draws an unrotated instance by translation, a rare turn by its full cm, with the colours of the part set", () => {
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
    const blocks = o.match(/\nq\n[^\n]* W\* n\n(?:(?:q |1 0 0 1 )[^\n]* Do(?: Q)?\n|Q\n)+Q/g) ?? [];
    expect(blocks).toHaveLength(clipped.length);
  });
});

describe("filter masks (§3.8, 05 §5.3)", () => {
  const j = renderFixtures["colour-order"];
  const a = { coords: [0, 0, 5000, 0, 5000, 5000], closed: true };
  const b = { coords: [9000, 0, 12000, 0, 12000, 3000], closed: true };
  const masked = (maskIdx: number[], masks = [{ regions: [a] }, { regions: [a, b] }]) =>
    passStreamOperators(passStreamFromJson({ ...j, masks, maskIdx }), { colours: stack, mode: "cmyk", resources: resources().res });

  it("the clip path is the frame with the region as an even-odd hole", () => {
    const p = filterClipPath({ minX: -10, minY: -10, maxX: 100, maxY: 50 }, makePath([0, 0, 5, 0, 5, 5], undefined, true));
    expect(Array.from(p.coords)).toEqual([-10, -10, 100, -10, 100, 50, -10, 50, 0, 0, 5, 0, 5, 5]);
    expect(Array.from(p.flags)).toEqual([0, 0, 0, 0, 16, 0, 0]);
  });

  it("one q … W* n block per run of equally masked passes, one W* n per region, Q before the next run", () => {
    // In canonical order the passes are fill, stroke, stroke, glyph, stroke with masks −1, 0, 1, 1, 0.
    const s = passStreamFromJson({ ...j, masks: [{ regions: [a] }, { regions: [a, b] }], maskIdx: [0, 0, -1, 1, 1] });
    expect(Array.from(s.maskIdx!)).toEqual([-1, 0, 1, 1, 0]);
    const L = lines(passStreamOperators(s, { colours: stack, mode: "cmyk", resources: resources().res }));
    expect(L.filter((l) => / W\* n$/.test(l))).toHaveLength(4);
    expect(L.join("\n")).not.toMatch(/ W n/);
    const qs = L.flatMap((l, k) => (l === "q" ? [k] : [])), Qs = L.flatMap((l, k) => (l === "Q" ? [k] : []));
    expect(qs).toHaveLength(3);
    expect(Qs).toHaveLength(3);
    expect(L.slice(0, qs[0]).join("\n")).toMatch(/ f\* Q$/); // the unmasked fill comes first, outside any block
    expect(qs.map((q) => L.slice(q + 1).findIndex((l) => !/ W\* n$/.test(l)))).toEqual([1, 2, 1]);
    expect(Qs[0]).toBeLessThan(qs[1]);
    expect(Qs[2]).toBe(L.length - 1);
  });

  it("the frame contains the stream's bounds by FILTER_FRAME_MARGIN_UM", () => {
    const clip = lines(masked([0, -1, -1, -1, -1])).find((l) => l.endsWith(" W* n"))!;
    const b = passStreamBounds(passStreamFromJson(j))!;
    expect(clip.startsWith(`${b.minX - FILTER_FRAME_MARGIN_UM} ${b.minY - FILTER_FRAME_MARGIN_UM} m`)).toBe(true);
  });

  it("restores the graphics state at Q: the colour after a masked run is written again", () => {
    const o = masked([-1, 0, 0, -1, -1]);
    const L = lines(o);
    const after = L.slice(L.lastIndexOf("Q") + 1);
    expect(after.some((l) => / (k|K)$/.test(l))).toBe(true);
  });

  it("no masks: no clip operators", () => {
    expect(ops("colour-order")).not.toMatch(/W\*? n/);
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
    expect(o).toContain(` ${Math.round(((2 * 200) / k) * 1000) / 1000} w 1 J 1 j `);
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
    // Written in 10/3 µm units (5 µm printed): the cm carries 10/3 × 1.5 × µm → pt.
    expect(lines(o).slice(0, 3)).toEqual(["q", "0.014173228 0 0 0.014173228 297.638 420.945 cm", "4 M"]);
    expect(o).toContain("q 1 0 0 1 -3000 -3000 cm 0 0 m 6000 0 l 6000 6000 l 0 6000 l h 1200 1200 m");
    expect(lines(o).at(-1)).toBe("Q");
  });

  it("moves an origin off the 10 µm grid onto it and folds the move into the cm", () => {
    const matrix = layerMatrix({ scaleRatio: 1, rotationDeg: 30, atPt: [100, 200] });
    const o = mapLayerOperators(passStreamFromJson(renderFixtures["fill-with-holes"]), {
      colours: stack,
      mode: "cmyk",
      resources: resources().res,
      originUm: [10004, -4996],
      matrix,
    });
    // Origin (10000, −5000), 5 µm units: the 10 µm coordinates stay whole units (corner −2000, 1000).
    expect(o).toContain("q 1 0 0 1 -2000 1000 cm 0 0 m 4000 0 l 4000 4000 l 0 4000 l h 800 800 m");
    // The written cm maps a unit point where the given matrix maps its µm point.
    const cm = lines(o)[1].split(" ").slice(0, 6).map(Number);
    const at = (m: number[], x: number, y: number) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    const want = at(matrix, 20000 - 10004, 20000 + 4996);
    const got = at(cm, (20000 - 10000) / 5, (20000 + 5000) / 5);
    // 9 decimals in the cm: within 1e-4 pt (35 nm).
    expect(got[0]).toBeCloseTo(want[0], 4);
    expect(got[1]).toBeCloseTo(want[1], 4);
  });

  it("keeps grid coordinates whole at 10/3 µm units with an origin off the grid", () => {
    const o = mapLayerOperators(passStreamFromJson(renderFixtures["fill-with-holes"]), {
      colours: stack,
      mode: "cmyk",
      resources: resources().res,
      originUm: [10004, -4996],
      matrix: layerMatrix({ scaleRatio: 1.5, atPt: [0, 0] }),
    });
    // Origin (10000, −5000): corner (−3000, 1500) units, the 20 mm ring 6000 units.
    expect(o).toContain("q 1 0 0 1 -3000 1500 cm 0 0 m 6000 0 l 6000 6000 l 0 6000 l h 1200 1200 m");
  });

  it("writes no anchor for a path whose corner is the origin", () => {
    expect(lines(ops("fill-with-holes")).at(-1)).toMatch(/^0 0 m 20000 0 l/);
  });

  it("rotates the layer counter-clockwise", () => {
    const [a, b, c, d] = layerMatrix({ scaleRatio: 1, rotationDeg: 90, atPt: [0, 0] });
    expect([a, b, c, d].map((v) => Math.round(v / UM_TO_PT))).toEqual([0, 1, -1, 0]);
  });

  it("never writes exponent notation, even for a tiny rotation", () => {
    const m = layerMatrix({ scaleRatio: 1, rotationDeg: 0.01, atPt: [0, 0] });
    expect(m[1]).toBeLessThan(1e-6);
    expect(cmOperator(m, 9)).toMatch(/^[-\d. ]+ cm$/);
    expect(cmOperator(m, 9).split(" ")[1]).toBe("0.000000495");
    expect(cmOperator([1e-12, -1e-12, 0, 1, 0, 0], 6)).toBe("0 0 0 1 0 0 cm");
  });

  it("clip regions: W n or W* n", () => {
    const sq = makePath([0, 0, 10, 0, 10, 10], undefined, true);
    expect(clipOperators(sq, "evenodd")).toBe("0 0 m 10 0 l 10 10 l h W* n");
    expect(clipOperators(sq, "nonzero", [5, 5])).toBe("-5 -5 m 5 -5 l 5 5 l h W n");
  });
});

describe("layer unit (C11)", () => {
  it("is the coarsest whole fraction of 10 µm that stays ≤ 5 µm on the paper", () => {
    const unit = (scaleRatio: number) => layerUnitUm(layerMatrix({ scaleRatio, rotationDeg: 17, atPt: [0, 0] }));
    expect(unit(0.5)).toBe(10);
    expect(unit(1)).toBe(5);
    expect(unit(1.5)).toBeCloseTo(10 / 3, 12);
    expect(unit(2)).toBe(2.5);
    expect(unit(3)).toBeCloseTo(10 / 6, 12);
    for (const r of [0.4, 0.5, 0.6, 1, 1.25, 1.5, 2, 2.5, 3, 3.75]) {
      expect(unit(r) * r).toBeLessThanOrEqual(PRINT_QUANTUM_UM + 1e-9);
      expect(Math.abs(PRINT_GRID_UM / unit(r) - Math.round(PRINT_GRID_UM / unit(r)))).toBeLessThan(1e-9);
    }
    expect(layerUnitUm([UM_TO_PT, 0, 0, UM_TO_PT, 0, 0])).toBe(5);
  });

  it("writes line widths and text sizes in the unit, to 0.001", () => {
    const fill = passStreamOperators(passStreamFromJson(renderFixtures["dashed-bezier-stroke"]), { colours: stack, mode: "cmyk", resources: resources().res, unitUm: 10 });
    expect(lines(fill)).toContain("35 w 0 J 1 j");
    const text = passStreamOperators(passStreamFromJson(renderFixtures["text-with-halo"]), { colours: stack, mode: "cmyk", resources: resources().res, unitUm: 10 / 3 });
    expect(lines(text)).toContain("120 w 1 J 1 j");
    expect(lines(text)).toContain("BT /F1 900 Tf 1 Tr");
    expect(lines(text)).toContain("1 0 0 1 300 1500 Tm <0024> Tj");
  });

  const scenes = [
    ...(Object.keys(renderFixtures) as (keyof typeof renderFixtures)[]).map((n) => ({ name: n, stream: passStreamFromJson(renderFixtures[n]), colours: stack })),
    ...librarySceneNames.map((n) => {
      const scene = libraryScene(n);
      return { name: n, stream: symbolise({ objects: scene.objects, symbols: scene.symbols, fonts: [liberation().sans, liberation().narrow] }).stream, colours: scene.colours };
    }),
  ];

  it.each(scenes.map((s) => [s.name, s] as const))("%s: in 10 µm units the same operators, every point within half a unit of the µm encoding", (_n, s) => {
    const fine = decode(passStreamOperators(s.stream, { colours: s.colours, mode: "cmyk", resources: resources().res }));
    const coarse = decode(passStreamOperators(s.stream, { colours: s.colours, mode: "cmyk", resources: resources().res, unitUm: 10 }));
    expect(coarse.map((p) => p.op)).toEqual(fine.map((p) => p.op));
    let worst = 0;
    coarse.forEach((p, i) => p.at.forEach((v, j) => (worst = Math.max(worst, Math.abs(v * 10 - fine[i].at[j])))));
    // ½ unit, plus ½ µm of the µm encoding's own rounding.
    expect(worst).toBeLessThanOrEqual(5.5);
  });

  it("keeps the stream's 10 µm grid exactly: decoded × unit + origin = the source coordinates", () => {
    const stream = passStreamFromJson(renderFixtures["fill-with-holes"]);
    const o = decode(passStreamOperators(stream, { colours: stack, mode: "cmyk", resources: resources().res, unitUm: 5, originUm: [-10, 20] }));
    const got = o.flatMap((p) => p.at).map((v, i) => v * 5 + (i % 2 === 0 ? -10 : 20));
    expect(got.slice(0, 8)).toEqual([0, 0, 20000, 0, 20000, 20000, 0, 20000]);
  });
});

describe("glyph instance forms (C11)", () => {
  function recording() {
    const forms: { mesh: GlyphMesh; matrix: number[] }[] = [];
    const res: OperatorResources = {
      font: () => "F1",
      glyph: (mesh, matrix = [1, 0, 0, 1, 0, 0]) => {
        let i = forms.findIndex((f) => f.mesh === mesh && f.matrix.join() === matrix.join());
        if (i < 0) i = forms.push({ mesh, matrix: [...matrix] }) - 1;
        return `G${i}`;
      },
    };
    return { forms, res };
  }
  /** One glyph pass: `n` instances 600 µm apart along x, turned `deg`, plus `odd` instances each at its own angle. */
  function pattern(n: number, deg: number, odd = 0): PassStream {
    const a = (deg * Math.PI) / 180;
    const instances: number[] = [];
    for (let i = 0; i < n; i++) instances.push(1000 + 600 * i, 2000, Math.cos(a), Math.sin(a), 1);
    for (let i = 0; i < odd; i++) instances.push(500 * i, 9000, Math.cos(i + 1), Math.sin(i + 1), 1);
    return passStreamFromJson({
      ...renderFixtures["glyph-instances"],
      objectIdx: [0],
      symbolIdx: [418],
      passes: [{ kind: "glyph", colour: 2, glyphId: 1, partIdx: 0, instances }],
    });
  }

  it("a turn shared by GLYPH_FORM_REUSE instances is the form's /Matrix; instances chain by relative translation", () => {
    const { forms, res } = recording();
    const o = lines(passStreamOperators(pattern(GLYPH_FORM_REUSE, 45), { colours: stack, mode: "cmyk", resources: res, unitUm: 10 }));
    expect(forms).toHaveLength(1);
    // cos 45° ÷ 10 µm (instances are single precision in the stream).
    const r = Math.SQRT1_2 / 10;
    expect(forms[0].matrix.slice(4)).toEqual([0, 0]);
    forms[0].matrix.slice(0, 4).forEach((v, i) => expect(v).toBeCloseTo(i === 2 ? -r : r, 8));
    expect(o[1]).toBe("q 1 0 0 1 100 200 cm /G0 Do");
    expect(o.slice(2, GLYPH_FORM_REUSE + 1)).toEqual(Array(GLYPH_FORM_REUSE - 1).fill("1 0 0 1 60 0 cm /G0 Do"));
    expect(o.at(-1)).toBe("Q");
  });

  it("re-anchors a chain every CHAIN_LENGTH instances", () => {
    const { res } = recording();
    const o = lines(passStreamOperators(pattern(CHAIN_LENGTH + 2, 0), { colours: stack, mode: "cmyk", resources: res }));
    const opens = o.filter((l) => l.startsWith("q 1 0 0 1 "));
    expect(opens).toEqual(["q 1 0 0 1 1000 2000 cm /G0 Do", `q 1 0 0 1 ${1000 + 600 * CHAIN_LENGTH} 2000 cm /G0 Do`]);
    expect(o.filter((l) => l === "Q")).toHaveLength(2);
  });

  it("an unrotated instance is translation-only under a unit: the plain form carries 1 ÷ unit", () => {
    const { forms, res } = recording();
    const o = lines(passStreamOperators(pattern(1, 0), { colours: stack, mode: "cmyk", resources: res, unitUm: 10 }));
    expect(forms.map((f) => f.matrix)).toEqual([[0.1, 0, 0, 0.1, 0, 0]]);
    expect(o[1]).toBe("q 1 0 0 1 100 200 cm /G0 Do Q");
  });

  it("a turn used fewer times draws the plain form under its own full cm", () => {
    const { forms, res } = recording();
    const o = lines(passStreamOperators(pattern(0, 0, 3), { colours: stack, mode: "cmyk", resources: res, unitUm: 10 }));
    expect(forms.map((f) => f.matrix)).toEqual([[0.1, 0, 0, 0.1, 0, 0]]);
    expect(o.slice(1)).toEqual([
      "q 0.540302 0.841471 -0.841471 0.540302 0 900 cm /G0 Do Q",
      "q -0.416147 0.909297 -0.909297 -0.416147 50 900 cm /G0 Do Q",
      "q -0.989992 0.14112 -0.14112 -0.989992 100 900 cm /G0 Do Q",
    ]);
  });
});

/**
 * Path points, glyph placements and text positions of an operator string,
 * in absolute written units: `q` / `Q` and the translation of every `cm`,
 * and `Tm` resolved (the emitter turns or scales only innermost).
 */
function decode(ops: string): { op: string; at: number[] }[] {
  const out: { op: string; at: number[] }[] = [];
  let t = [0, 0];
  const stack: number[][] = [];
  let tl = [0, 0];
  let args: number[] = [];
  for (const tok of ops.split(/\s+/)) {
    if (/^-?[\d.]+$/.test(tok)) {
      args.push(Number(tok));
      continue;
    }
    if (tok === "q") stack.push([...t]);
    else if (tok === "Q") t = stack.pop()!;
    else if (tok === "cm") t = [t[0] + args[4], t[1] + args[5]];
    else if (tok === "m" || tok === "l" || tok === "c") out.push({ op: tok, at: args.map((v, i) => v + t[i % 2]) });
    else if (tok === "Do") out.push({ op: "Do", at: [...t] });
    else if (tok === "BT") tl = [0, 0];
    else if (tok === "Tm") tl = [args[4], args[5]];
    else if (tok === "Tj") out.push({ op: "Tj", at: [t[0] + tl[0], t[1] + tl[1]] });
    if (!tok.startsWith("<") && !tok.startsWith("/")) args = [];
  }
  return out;
}
