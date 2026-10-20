import { describe, expect, it } from "vitest";
import { PILOT, pilotSymbols } from "../__fixtures__/pilot-symbols.js";
import { COORD_FLAG, type Pass, type PassStream, makePath } from "../pass-stream.js";
import { type RenderObject, symbolise } from "../symbolise.js";
import { parseRenderSymbol } from "../symbol.js";
import { liberation } from "./fonts.js";

const F = COORD_FLAG;
const fonts = () => [liberation().sans];

function run(objects: RenderObject[]) {
  return symbolise({ objects, symbols: pilotSymbols, fonts: fonts() });
}
const only = <K extends Pass["kind"]>(s: PassStream, kind: K) => s.passes.filter((p): p is Extract<Pass, { kind: K }> => p.kind === kind);
const r3 = (v: number) => Math.round(v * 1000) / 1000;

describe("symbolise — lines", () => {
  it("101 contour: one solid stroke pass, no slices, round caps", () => {
    const { stream, warnings } = run([{ symbolIdx: PILOT.contour101, path: makePath([0, 0, 5000, 2000, 9000, -1000]) }]);
    expect(warnings).toEqual([]);
    expect(stream.passes).toHaveLength(1);
    const [p] = only(stream, "stroke");
    expect(p).toMatchObject({ colour: 6, widthUm: 140, cap: "round", join: "round" });
    expect(p.slices).toBeUndefined();
    expect(Array.from(stream.objectIdx)).toEqual([0]);
    expect(Array.from(stream.symbolIdx)).toEqual([PILOT.contour101]);
  });

  it("505 footpath: OCAD dashes become slices on the original path", () => {
    const { stream } = run([{ symbolIdx: PILOT.footpath505, path: makePath([0, 0, 20000, 0]) }]);
    const [p] = only(stream, "stroke");
    expect(p.path.coords).toEqual(Int32Array.from([0, 0, 20000, 0]));
    expect(p.slices).toHaveLength(8);
    const r = (20000 - 7 * 500) / 16000;
    expect(p.slices![0]).toMatchObject({ seg0: 0, t0: 0, seg1: 0 });
    expect(r3(p.slices![0].t1 * 20000)).toBe(r3(2000 * r));
    expect(p.slices![7].t1).toBe(1);
  });

  it("505 with a corner point mid-way: each section is fitted on its own", () => {
    const { stream } = run([{ symbolIdx: PILOT.footpath505, path: makePath([0, 0, 10000, 0, 10000, 10000], [0, F.corner, 0]) }]);
    const [p] = only(stream, "stroke");
    // 10 mm sections: n = round((10000 − 4000 + 2000) / 2500) = 3 gaps → 4 dashes each. The two
    // end dashes meeting at the corner are one drawn dash: one slice round the corner, 7 in all.
    expect(p.slices).toHaveLength(7);
    expect(p.slices![3]).toMatchObject({ seg0: 0, seg1: 1 });
    // r = (10000 − 1500) / 8000; the corner dash runs from 10000 − 2000r on the first leg to 2000r on the second.
    const r = 8500 / 8000;
    expect(p.slices![3].t0).toBeCloseTo((10000 - 2000 * r) / 10000, 9);
    expect(p.slices![3].t1).toBeCloseTo((2000 * r) / 10000, 9);
  });

  it("505 with a dash point mid-way: one dash of the pattern is centred on the point", () => {
    const { stream } = run([{ symbolIdx: PILOT.footpath505, path: makePath([0, 0, 10000, 0, 16000, 0], [0, F.dash, 0]) }]);
    const [p] = only(stream, "stroke");
    // First section: Es 2000, Ee 1000 → n = 4, r = 8/9; second: Es 1000, Ee 2000 → n = 2, r = 1.
    // The dash on the point spans [10000 − 1000·8/9, 10000 + 1000] as one slice.
    const lens = p.slices!.map((sl) => [sl.seg0 === 0 ? sl.t0 * 10000 : 10000 + sl.t0 * 6000, sl.seg1 === 0 ? sl.t1 * 10000 : 10000 + sl.t1 * 6000]);
    expect(lens).toHaveLength(7);
    expect(lens[4][0]).toBeCloseTo(10000 - 8000 / 9, 3);
    expect(lens[4][1]).toBeCloseTo(11000, 3);
    expect(lens[5]).toEqual([11500, 13500]);
  });

  it("a closed path cut at one corner is one section running through the start point", () => {
    // 10 × 10 mm square, corner at (10000, 10000): one 40 mm section from the corner round to it.
    const sq = makePath([0, 0, 10000, 0, 10000, 10000, 0, 10000], [0, 0, F.corner, 0], true);
    const { stream } = run([{ symbolIdx: PILOT.footpath505, path: sq }]);
    const [p] = only(stream, "stroke");
    // n = round((40000 − 4000 + 2000) / 2500) = 15 gaps, 16 dashes, r = 32500 / 32000. The first and
    // last dash meet at the corner (one slice round it) → 15 slices. The start point is 20000 into the
    // section, inside the gap after dash 8 ([17718.75, 19750] + 500), so no dash is cut there and
    // a gap is centred near it — not a dash restart, as it would be if the start point split the path.
    expect(p.slices).toHaveLength(15);
    const r = 32500 / 32000;
    const cornerDash = p.slices!.find((sl) => sl.seg0 === 1 && sl.seg1 === 2)!;
    expect(cornerDash.t0).toBeCloseTo(1 - (2000 * r) / 10000, 9);
    expect(cornerDash.t1).toBeCloseTo((2000 * r) / 10000, 9);
    const first = p.slices![0];
    // First drawn piece after the start point: dash 9 starts at 20000 + 8·(2000r + 500) − 20000 = 250 µm along segment 0.
    expect(first.seg0).toBe(0);
    expect(first.t0 * 10000).toBeCloseTo(8 * (2000 * r + 500) - 20000, 6);
  });

  it("505 on a Bézier: slices are (segment, t) on the curve, not on a flattened copy", () => {
    const curve = makePath([0, 0, 6000, 12000, 14000, -12000, 20000, 0], [0, 1, 2, 0]);
    const { stream } = run([{ symbolIdx: PILOT.footpath505, path: curve }]);
    const [p] = only(stream, "stroke");
    expect(p.path).toBe(curve);
    expect(p.slices!.every((s) => s.seg0 === 0 && s.seg1 === 0)).toBe(true);
    const ts = p.slices!.flatMap((s) => [s.t0, s.t1]);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });

  it("OMAP footpath: half outer dashes", () => {
    const { stream } = run([{ symbolIdx: PILOT.footpathOmap505, path: makePath([0, 0, 20000, 0]) }]);
    const [p] = only(stream, "stroke");
    expect(p.slices).toHaveLength(9);
    expect(r3(p.slices![0].t1 * 20000)).toBe(1000);
  });

  it("gap points interrupt the main line", () => {
    const { stream } = run([{ symbolIdx: PILOT.contour101, path: makePath([0, 0, 1000, 0, 2000, 0, 3000, 0], [0, F.gap, F.gap, 0]) }]);
    const [p] = only(stream, "stroke");
    expect(p.slices).toEqual([
      { seg0: 0, t0: 0, seg1: 0, t1: 1 },
      { seg0: 2, t0: 0, seg1: 2, t1: 1 },
    ]);
  });

  it("502 wide road: edges are offset polylines, infill a wide stroke in the lower colour", () => {
    const { stream } = run([{ symbolIdx: PILOT.wideRoad502, path: makePath([0, 0, 10000, 0]) }]);
    const strokes = only(stream, "stroke");
    expect(strokes.map((s) => s.colour)).toEqual([5, 8, 8]); // brown-50 infill first, then black edges
    expect(strokes[0]).toMatchObject({ widthUm: 700 });
    expect(Array.from(strokes[1].path.coords)).toEqual([0, 350, 10000, 350]);
    expect(Array.from(strokes[2].path.coords)).toEqual([0, -350, 10000, -350]);
    expect(strokes[1].slices).toBeUndefined();
  });

  it("502 edges honour noLeft / noRight points", () => {
    const { stream } = run([{ symbolIdx: PILOT.wideRoad502, path: makePath([0, 0, 4000, 0, 8000, 0, 12000, 0], [0, F.noLeft, 0, 0]) }]);
    const [, left, right] = only(stream, "stroke");
    expect(left.slices).toEqual([
      { seg0: 0, t0: 0, seg1: 0, t1: 1 },
      { seg0: 2, t0: 0, seg1: 2, t1: 1 },
    ]);
    expect(right.slices).toBeUndefined();
  });

  it("a continuous halo stays solid under a dashed main line (OCAD framing, 509 railway)", () => {
    const base = { type: "line" as const, id: "t", code: "t", name: "t" };
    const dash = { layout: "ocad" as const, dashUm: 1000, gapUm: 1500 };
    const objects = [{ symbolIdx: 0, path: makePath([0, 0, 10000, 0]) }];
    const dashed = symbolise({ objects, symbols: [parseRenderSymbol({ ...base, main: { colour: 8, widthUm: 250, dash, halo: { colour: 5, widthUm: 100 } } })], fonts: [] }).stream;
    const [haloA, mainA] = only(dashed, "stroke");
    expect(haloA.slices).toEqual(mainA.slices);
    const framed = symbolise({ objects, symbols: [parseRenderSymbol({ ...base, main: { colour: 8, widthUm: 250, dash, halo: { colour: 5, widthUm: 100, continuous: true } } })], fonts: [] }).stream;
    const [haloB, mainB] = only(framed, "stroke");
    expect(haloB.slices).toBeUndefined();
    expect(haloB.widthUm).toBe(450);
    expect(mainB.slices!.length).toBeGreaterThan(1);
  });

  it("backgroundWidthUm sets the infill band width and allows a band without both edges", () => {
    const sym = parseRenderSymbol({
      type: "line", id: "t", code: "t", name: "t",
      borders: { left: { colour: 8, widthUm: 140, shiftUm: 320 }, right: { colour: 8, widthUm: 140, shiftUm: 320 }, backgroundColour: 5, backgroundWidthUm: 500 },
    });
    const { stream } = symbolise({ objects: [{ symbolIdx: 0, path: makePath([0, 0, 10000, 0]) }], symbols: [sym], fonts: [] });
    const strokes = only(stream, "stroke");
    expect(strokes.map((s) => [s.colour, s.widthUm])).toEqual([[5, 500], [8, 140], [8, 140]]);
    const bandOnly = parseRenderSymbol({ type: "line", id: "t", code: "t", name: "t", borders: { backgroundColour: 5, backgroundWidthUm: 500 } });
    const alone = symbolise({ objects: [{ symbolIdx: 0, path: makePath([0, 0, 10000, 0]) }], symbols: [bandOnly], fonts: [] }).stream;
    expect(only(alone, "stroke").map((s) => [s.colour, s.widthUm])).toEqual([[5, 500]]);
    expect(Array.from(only(alone, "stroke")[0].path.coords)).toEqual([0, 0, 10000, 0]);
  });

  it("503 framed road: the halo is a separate, wider stroke pass in its own colour, sorted below", () => {
    const { stream } = run([{ symbolIdx: PILOT.roadFramed503, path: makePath([0, 0, 10000, 0]) }]);
    const strokes = only(stream, "stroke");
    expect(strokes.map((s) => [s.colour, s.widthUm])).toEqual([[5, 750], [8, 350]]);
  });

  it("pointed caps: the taper lengths go onto the pass; without them the stroke is butt", () => {
    const lineOf = (main: object) => parseRenderSymbol({ type: "line", id: "t", code: "107", name: "t", main });
    const path = makePath([0, 0, 10000, 0]);
    const tapered = symbolise({ objects: [{ symbolIdx: 0, path }], symbols: [lineOf({ colour: 2, widthUm: 250, cap: "pointed", taper: { startUm: 750, endUm: 750 } })], fonts: [] }).stream;
    const [p] = only(tapered, "stroke");
    expect(p).toMatchObject({ cap: "pointed", taper: { startUm: 750, endUm: 750 }, widthUm: 250 });
    // Full length, no slices: a taper is not a shortening.
    expect(p.slices).toBeUndefined();
    const bare = only(symbolise({ objects: [{ symbolIdx: 0, path }], symbols: [lineOf({ colour: 2, widthUm: 250, cap: "pointed" })], fonts: [] }).stream, "stroke")[0];
    expect(bare.taper).toBeUndefined();
    // A taper on a round-capped line means nothing.
    const round = only(symbolise({ objects: [{ symbolIdx: 0, path }], symbols: [lineOf({ colour: 2, widthUm: 250, cap: "round", taper: { startUm: 750 } })], fonts: [] }).stream, "stroke")[0];
    expect(round.taper).toBeUndefined();
  });

  it("a framing line narrower than its main line: a thin continuous halo under the dashes", () => {
    const sym = parseRenderSymbol({
      type: "line", id: "t", code: "503.1", name: "t",
      main: { colour: 8, widthUm: 350, dash: { layout: "ocad", dashUm: 2000, gapUm: 500 }, halo: { colour: 5, widthUm: -100, continuous: true } },
    });
    const { stream } = symbolise({ objects: [{ symbolIdx: 0, path: makePath([0, 0, 20000, 0]) }], symbols: [sym], fonts: [] });
    const [halo, main] = only(stream, "stroke");
    expect([halo.colour, halo.widthUm, halo.slices]).toEqual([5, 150, undefined]);
    expect([main.colour, main.widthUm, main.slices?.length]).toEqual([8, 350, 8]);
    // Not continuous, or eating the whole line: refused by the schema / no pass.
    expect(() => parseRenderSymbol({ type: "line", id: "t", code: "t", name: "t", main: { colour: 8, widthUm: 350, halo: { colour: 5, widthUm: -100 } } })).toThrow();
    const gone = parseRenderSymbol({ type: "line", id: "t", code: "t", name: "t", main: { colour: 8, widthUm: 350, halo: { colour: 5, widthUm: -200, continuous: true } } });
    expect(only(symbolise({ objects: [{ symbolIdx: 0, path: makePath([0, 0, 20000, 0]) }], symbols: [gone], fonts: [] }).stream, "stroke")).toHaveLength(1);
  });

  it("516 power line: solid line, crossbars at the fitted spacing, rotated to the tangent", () => {
    const { stream } = run([{ symbolIdx: PILOT.powerLine516, path: makePath([0, 0, 0, 21000]) }]);
    const [line] = only(stream, "stroke");
    expect(line.slices).toEqual([{ seg0: 0, t0: 0, seg1: 0, t1: 1 }]);
    const [g] = only(stream, "glyph");
    expect(g.instances.length / 5).toBe(3);
    expect(Array.from(g.instances).map(r3)).toEqual([0, 3500, 0, 1, 1, 0, 10500, 0, 1, 1, 0, 17500, 0, 1, 1]);
    expect(stream.glyphTable).toHaveLength(1);
    expect(stream.glyphTable[0].strokes[0].widthUm).toBe(140);
  });

  it("529 wall: corner glyphs scaled by the mitre, ticks restarted per section", () => {
    const { stream } = run([{ symbolIdx: PILOT.wall529, path: makePath([0, 0, 3000, 0, 3000, 3000], [0, F.corner, 0]) }]);
    const glyphs = only(stream, "glyph");
    expect(glyphs).toHaveLength(2);
    const corner = glyphs.find((g) => g.instances.length === 5)!;
    expect(Array.from(corner.instances).map(r3)).toEqual([3000, 0, r3(Math.SQRT1_2), r3(Math.SQRT1_2), r3(Math.SQRT2)]);
    const ticks = glyphs.find((g) => g.instances.length > 5)!;
    expect(ticks.instances.length / 5).toBe(6); // 3 per 3 mm section at 500, 1500, 2500
    expect(Array.from(ticks.instances).filter((_, i) => i % 5 === 0).map(r3)).toEqual([500, 1500, 2500, 3000, 3000, 3000]);
  });
});

describe("symbolise — points, areas", () => {
  it("418 tree: one pass per colour part, meshes in the glyph table, north-up ignores the object angle", () => {
    const { stream } = run([{ symbolIdx: PILOT.tree418, path: makePath([4000, 5000]), angleDeg: 37 }]);
    const glyphs = only(stream, "glyph");
    expect(glyphs.map((g) => [g.colour, g.partIdx])).toEqual([[4, 0], [8, 1]]);
    expect(Array.from(glyphs[0].instances)).toEqual([4000, 5000, 1, 0, 1]);
    expect(stream.glyphTable).toHaveLength(2);
    expect(stream.glyphTable[0].fills).toHaveLength(1); // disc
    expect(stream.glyphTable[1].strokes[0]).toMatchObject({ widthUm: 140 }); // ring
  });

  it("403 rough open: a single even-odd fill", () => {
    const { stream } = run([{ symbolIdx: PILOT.roughOpen403, path: makePath([0, 0, 10000, 0, 10000, 10000, 0, 10000], undefined, true) }]);
    expect(stream.passes).toHaveLength(1);
    expect(stream.passes[0]).toMatchObject({ kind: "fill", colour: 1, rule: "evenodd" });
  });

  it("407 scattered trees: fill under the dot grid, instances only where centres are inside", () => {
    const sq = makePath([0, 0, 10000, 0, 10000, 10000, 0, 10000], undefined, true);
    const { stream } = run([{ symbolIdx: PILOT.scatteredTrees407, path: sq }]);
    expect(stream.passes.map((p) => `${p.colour}:${p.kind}`)).toEqual(["1:fill", "2:glyph"]);
    const [g] = only(stream, "glyph");
    expect(g.clip).toBeUndefined();
    expect(g.instances.length / 5).toBeGreaterThanOrEqual(95);
    expect(g.instances.length / 5).toBeLessThanOrEqual(105);
  });

  it("213 sandy ground: clip mode carries the area as clip path", () => {
    const sq = makePath([0, 0, 4000, 0, 4000, 4000, 0, 4000], undefined, true);
    const { stream } = run([{ symbolIdx: PILOT.sandyGround213, path: sq }]);
    const [g] = only(stream, "glyph");
    expect(g.clip).toBe(stream.passes.find((p) => p.kind === "fill")!.path);
    expect(g.instances.length / 5).toBeGreaterThan(25); // 5×5 centres plus the clipped rim
  });

  it("709 out-of-bounds: hatch pass with the symbol's angle, rotated by the object unless never", () => {
    const sq = makePath([0, 0, 10000, 0, 10000, 10000, 0, 10000], undefined, true);
    const { stream } = run([{ symbolIdx: PILOT.outOfBounds709, path: sq, angleDeg: 10 }]);
    expect(stream.passes).toHaveLength(1);
    expect(stream.passes[0]).toMatchObject({ kind: "hatch", colour: 9, widthUm: 250, spacingUm: 1000, offsetUm: 0, angleDeg: 100 });
  });

  it("714 crossed: two hatch passes in one colour", () => {
    const sq = makePath([0, 0, 10000, 0, 10000, 10000, 0, 10000], undefined, true);
    const { stream } = run([{ symbolIdx: PILOT.crossed714, path: sq }]);
    expect(stream.passes.map((p) => p.kind)).toEqual(["fill", "hatch", "hatch"]);
    expect(only(stream, "hatch").map((h) => h.angleDeg)).toEqual([45, 135]);
  });

  it("an open area path is closed for filling", () => {
    const { stream } = run([{ symbolIdx: PILOT.roughOpen403, path: makePath([0, 0, 10000, 0, 0, 10000]) }]);
    expect((stream.passes[0] as { path: { closed: boolean } }).path.closed).toBe(true);
  });
});

describe("symbolise — text", () => {
  it("704 control number: halo pass in upper white below the purple pass, sized by digit height", () => {
    const { stream, warnings } = run([{ symbolIdx: PILOT.controlNumber704, path: makePath([1000, 2000]), text: "31" }]);
    expect(warnings).toEqual([]);
    const texts = only(stream, "text");
    expect(texts.map((t) => [t.colour, t.haloWidthUm])).toEqual([[10, 150], [11, undefined]]);
    const font = liberation().sans;
    expect(texts[1].sizeUm).toBeCloseTo((4000 * 2048) / font.digitHeight, 6);
    expect(texts[1].glyphs).toEqual(Uint16Array.from([font.glyphId(0x33), font.glyphId(0x31)]));
    expect(texts[1].positions[0]).toBe(1000);
    expect(texts[0].positions).toEqual(texts[1].positions);
    expect(stream.fontTable).toEqual([{ fontId: 0, family: "liberation-sans", bold: false, italic: false }]);
  });

  it("warns and skips when the text or the font is missing", () => {
    const a = run([{ symbolIdx: PILOT.controlNumber704, path: makePath([0, 0]) }]);
    expect(a.warnings.map((w) => w.code)).toEqual(["TEXT_WITHOUT_TEXT"]);
    const b = symbolise({ objects: [{ symbolIdx: PILOT.controlNumber704, path: makePath([0, 0]), text: "1" }], symbols: pilotSymbols, fonts: [] });
    expect(b.warnings.map((w) => w.code)).toEqual(["NO_FONT"]);
    expect(b.stream.passes).toHaveLength(0);
  });
});

describe("symbolise — extra border pairs, corner radius", () => {
  it("a second border pair is drawn like the first, with its own shift and phase from the main line", () => {
    const sym = parseRenderSymbol({
      type: "line", id: "t", code: "502.2", name: "t",
      main: { colour: 5, widthUm: 300 },
      borders: {
        left: { colour: 8, widthUm: 140, shiftUm: 500 },
        right: { colour: 8, widthUm: 140, shiftUm: 500 },
        backgroundColour: 4,
        extraPairs: [{ left: { colour: 2, widthUm: 100, shiftUm: 900, dash: { layout: "ocad", dashUm: 2000, gapUm: 500 } }, right: { colour: 2, widthUm: 100, shiftUm: 900 } }],
      },
    });
    const { stream } = symbolise({ objects: [{ symbolIdx: 0, path: makePath([0, 0, 20000, 0]) }], symbols: [sym], fonts: [] });
    const strokes = only(stream, "stroke");
    // Colour-major: extra pair (2), band (4), main (5), first pair (8).
    expect(strokes.map((p) => [p.colour, p.widthUm])).toEqual([[2, 100], [2, 100], [4, 1000], [5, 300], [8, 140], [8, 140]]);
    const ys = strokes.map((p) => p.path.coords[1]);
    expect(ys).toEqual([900, -900, 0, 0, 500, -500]);
    // The dashed extra border is laid out on the main line: 8 dashes as on a 20 mm 505.
    expect(strokes[0].slices).toHaveLength(8);
    expect(strokes[1].slices).toBeUndefined();
  });

  it("cornerRadiusUm rounds a rectangle's corners with one cubic each, before any layout", () => {
    const sym = parseRenderSymbol({ type: "line", id: "t", code: "850.1", name: "t", cornerRadiusUm: 2290, main: { colour: 8, widthUm: 180 } });
    // 10 × 6 mm frame, closed (type-7 objects are drawn closed).
    const rect = makePath([0, 0, 10000, 0, 10000, 6000, 0, 6000], undefined, true);
    const [p] = only(symbolise({ objects: [{ symbolIdx: 0, path: rect }], symbols: [sym], fonts: [] }).stream, "stroke");
    expect(p.path.closed).toBe(true);
    expect(p.path.flags.length).toBe(16);
    expect(Array.from(p.path.flags)).toEqual([0, 1, 2, 0, 0, 1, 2, 0, 0, 1, 2, 0, 0, 1, 2, 0]);
    // First corner (0, 0): arc from (0, 2290) to (2290, 0); handles 4/3·tan(22.5°)·r = 1265 µm.
    const h = Math.round(2290 * (4 / 3) * Math.tan(Math.PI / 8));
    expect(Array.from(p.path.coords.slice(0, 8))).toEqual([0, 2290, 0, 2290 - h, 2290 - h, 0, 2290, 0]);
    // The arc's midpoint is r(1 − 1/√2) inside the corner on the diagonal.
    const c = p.path.coords;
    const bez = (o: number) => (c[o] + 3 * c[o + 2] + 3 * c[o + 4] + c[o + 6]) / 8;
    expect(bez(0)).toBeCloseTo(2290 * (1 - Math.SQRT1_2), 0);
    expect(bez(1)).toBeCloseTo(2290 * (1 - Math.SQRT1_2), 0);
  });

  it("a radius larger than half an edge shrinks to fit; Bézier anchors and open ends stay", () => {
    const sym = parseRenderSymbol({ type: "line", id: "t", code: "t", name: "t", cornerRadiusUm: 5000, main: { colour: 8, widthUm: 180 } });
    const open = makePath([0, 0, 2000, 0, 2000, 8000]);
    const [p] = only(symbolise({ objects: [{ symbolIdx: 0, path: open }], symbols: [sym], fonts: [] }).stream, "stroke");
    // Corner at (2000, 0): t = min(5000·tan 45°, 1000, 4000) = 1000.
    expect(Array.from(p.path.coords)).toEqual([0, 0, 1000, 0, 1000 + Math.round(1000 * (4 / 3) * Math.tan(Math.PI / 8)), 0, 2000, 1000 - Math.round(1000 * (4 / 3) * Math.tan(Math.PI / 8)), 2000, 1000, 2000, 8000]);
    const curve = makePath([0, 0, 1000, 1000, 2000, 1000, 3000, 0, 4000, 2000], [0, 1, 2, 0, 0]);
    const [c] = only(symbolise({ objects: [{ symbolIdx: 0, path: curve }], symbols: [sym], fonts: [] }).stream, "stroke");
    expect(Array.from(c.path.coords)).toEqual(Array.from(curve.coords));
  });

  it("parsed symbols stay identical when the B1 fields are absent (hashes and fingerprints)", () => {
    const text = parseRenderSymbol({ type: "text", id: "t", code: "t", name: "t", fontFamily: "liberation-sans", fontSizeUm: 4000, colour: 8 });
    const line = parseRenderSymbol({ type: "line", id: "t", code: "t", name: "t", main: { colour: 8, widthUm: 180 }, borders: { left: { colour: 8, widthUm: 100, shiftUm: 300 } } });
    const keys = JSON.stringify([text, line]);
    for (const k of ["verticalAlign", "shadow", "taper", "cornerRadiusUm", "extraPairs"]) expect(keys).not.toContain(k);
  });
});

describe("symbolise — text shadow, faces, rotation", () => {
  const textSym = (o: object = {}) =>
    parseRenderSymbol({ type: "text", id: "t", code: "t", name: "t", fontFamily: "liberation-sans", fontSizeUm: 4000, colour: 8, ...o });

  it("a shadow is its own pass in its colour, every origin offset — turned with the text", () => {
    const sym = textSym({ shadow: { colour: 2, offsetXUm: 200, offsetYUm: -300 } });
    const { stream } = symbolise({ objects: [{ symbolIdx: 0, path: makePath([1000, 2000]), text: "AB" }], symbols: [sym], fonts: fonts() });
    const [shadow, text] = only(stream, "text");
    expect([shadow.colour, text.colour]).toEqual([2, 8]);
    expect(shadow.haloWidthUm).toBeUndefined();
    for (let i = 0; i < text.glyphs.length; i++) {
      expect(shadow.positions[2 * i] - text.positions[2 * i]).toBeCloseTo(200, 2);
      expect(shadow.positions[2 * i + 1] - text.positions[2 * i + 1]).toBeCloseTo(-300, 2);
    }
    const turned = only(symbolise({ objects: [{ symbolIdx: 0, path: makePath([0, 0]), text: "A", angleDeg: 90 }], symbols: [sym], fonts: fonts() }).stream, "text");
    // (200, −300) turned 90° counter-clockwise is (300, 200).
    expect(turned[0].positions[0] - turned[1].positions[0]).toBeCloseTo(300, 2);
    expect(turned[0].positions[1] - turned[1].positions[1]).toBeCloseTo(200, 2);
    expect(Array.from(turned[0].angles!)).toEqual([90]);
    expect(Array.from(turned[1].angles!)).toEqual([90]);
  });

  it("rotated text carries one angle per glyph on every pass, halo included", () => {
    const sym = textSym({ halo: { colour: 1, widthUm: 250 } });
    const { stream } = symbolise({ objects: [{ symbolIdx: 0, path: makePath([0, 0]), text: "Ab c", angleDeg: 30 }], symbols: [sym], fonts: fonts() });
    for (const p of only(stream, "text")) expect(Array.from(p.angles!)).toEqual([30, 30, 30]);
  });

  it("a bold symbol with only the regular face loaded draws in that face, without a warning", () => {
    const { stream, warnings } = symbolise({ objects: [{ symbolIdx: 0, path: makePath([0, 0]), text: "A" }], symbols: [textSym({ weight: 700 })], fonts: fonts() });
    expect(warnings).toEqual([]);
    expect(only(stream, "text")[0].fontId).toBe(0);
    expect(stream.fontTable[0]).toEqual({ fontId: 0, family: "liberation-sans", bold: false, italic: false });
  });

  it("picks the face whose bold / italic match when several of the family are loaded", () => {
    const { sans } = liberation();
    const boldFace = { ...sans, family: sans.family, bold: true, glyphId: sans.glyphId.bind(sans), advance: sans.advance.bind(sans), kerning: sans.kerning.bind(sans) };
    const { stream } = symbolise({ objects: [{ symbolIdx: 0, path: makePath([0, 0]), text: "A" }], symbols: [textSym({ weight: 700 })], fonts: [sans, boldFace] });
    expect(only(stream, "text")[0].fontId).toBe(1);
    expect(stream.fontTable[1].bold).toBe(true);
  });
});

describe("symbolise — stream invariants", () => {
  it("unknown symbols and empty geometry produce warnings, never passes", () => {
    const { stream, warnings } = run([
      { symbolIdx: 999, path: makePath([0, 0, 1, 1]) },
      { symbolIdx: PILOT.contour101, path: makePath([]) },
    ]);
    expect(stream.passes).toHaveLength(0);
    expect(warnings.map((w) => w.code)).toEqual(["UNKNOWN_SYMBOL", "EMPTY_GEOMETRY"]);
  });

  it("passes come out in colour-major order with parallel object and symbol indices", () => {
    const sq = makePath([0, 0, 10000, 0, 10000, 10000, 0, 10000], undefined, true);
    const { stream } = run([
      { symbolIdx: PILOT.controlNumber704, path: makePath([5000, 5000]), text: "1" },
      { symbolIdx: PILOT.contour101, path: makePath([0, 5000, 10000, 5000]) },
      { symbolIdx: PILOT.roughOpen403, path: sq },
      { symbolIdx: PILOT.tree418, path: makePath([2000, 2000]) },
    ]);
    const colours = stream.passes.map((p) => p.colour);
    expect(colours).toEqual([...colours].sort((a, b) => a - b));
    expect(stream.objectIdx.length).toBe(stream.passes.length);
    expect(stream.symbolIdx.length).toBe(stream.passes.length);
    const fillIdx = stream.passes.findIndex((p) => p.kind === "fill");
    expect(stream.objectIdx[fillIdx]).toBe(2);
    expect(stream.symbolIdx[fillIdx]).toBe(PILOT.roughOpen403);
  });

  it("is deterministic: the same input yields an identical stream", () => {
    const objs: RenderObject[] = [
      { symbolIdx: PILOT.footpath505, path: makePath([0, 0, 6000, 12000, 14000, -12000, 20000, 0], [0, 1, 2, 0]) },
      { symbolIdx: PILOT.scatteredTrees407, path: makePath([0, 0, 7000, 1000, 9000, 8000, -1000, 6000], undefined, true) },
      { symbolIdx: PILOT.controlNumber704, path: makePath([1000, 1000]), text: "42" },
    ];
    const a = run(objs).stream, b = run(objs).stream;
    expect(JSON.stringify(a, (_, v) => (ArrayBuffer.isView(v) ? Array.from(v as unknown as ArrayLike<number>) : v))).toBe(
      JSON.stringify(b, (_, v) => (ArrayBuffer.isView(v) ? Array.from(v as unknown as ArrayLike<number>) : v)),
    );
  });
});
