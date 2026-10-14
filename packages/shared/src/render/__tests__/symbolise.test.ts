import { describe, expect, it } from "vitest";
import { PILOT, pilotSymbols } from "../__fixtures__/pilot-symbols.js";
import { COORD_FLAG, type Pass, type PassStream, makePath } from "../pass-stream.js";
import { type RenderObject, symbolise } from "../symbolise.js";
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
    // 10 mm sections: n = round((10000 − 4000 + 2000) / 2500) = 3 gaps → 4 dashes each.
    expect(p.slices).toHaveLength(8);
    expect(p.slices![3].seg1).toBe(0);
    expect(p.slices![3].t1).toBe(1);
    expect(p.slices![4]).toMatchObject({ seg0: 1, t0: 0 });
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

  it("503 framed road: the halo is a separate, wider stroke pass in its own colour, sorted below", () => {
    const { stream } = run([{ symbolIdx: PILOT.roadFramed503, path: makePath([0, 0, 10000, 0]) }]);
    const strokes = only(stream, "stroke");
    expect(strokes.map((s) => [s.colour, s.widthUm])).toEqual([[5, 750], [8, 350]]);
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
