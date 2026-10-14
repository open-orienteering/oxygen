import { describe, expect, it } from "vitest";
import {
  COORD_FLAG,
  PASS_KIND_ORDER,
  type Pass,
  PassStreamBuilder,
  comparePassOrder,
  makePath,
  sortPassStream,
} from "../pass-stream.js";

const fill = (colour: number): Pass => ({ kind: "fill", colour, path: makePath([0, 0, 1, 0, 1, 1], undefined, true), rule: "evenodd" });
const stroke = (colour: number): Pass => ({ kind: "stroke", colour, path: makePath([0, 0, 1, 1]), widthUm: 100, cap: "butt", join: "miter" });
const glyph = (colour: number): Pass => ({ kind: "glyph", colour, glyphId: 1, partIdx: 0, instances: Float32Array.from([0, 0, 1, 0, 1]) });

describe("COORD_FLAG", () => {
  it("matches the OCAD/OMAP bit assignment", () => {
    expect(COORD_FLAG).toEqual({
      bezierFirst: 1, bezierSecond: 2, corner: 4, dash: 8, hole: 16, noLeft: 32, noRight: 64, gap: 128,
    });
  });
});

describe("comparePassOrder", () => {
  it("orders by colour first", () => {
    expect(comparePassOrder({ colour: 1, kind: "text", symbolIdx: 0 }, { colour: 2, kind: "fill", symbolIdx: 0 })).toBeLessThan(0);
  });
  it("then by kind: fill < hatch < stroke < glyph < text", () => {
    const kinds = Object.keys(PASS_KIND_ORDER) as (keyof typeof PASS_KIND_ORDER)[];
    const sorted = [...kinds].sort((a, b) => comparePassOrder({ colour: 0, kind: a, symbolIdx: 0 }, { colour: 0, kind: b, symbolIdx: 0 }));
    expect(sorted).toEqual(["fill", "hatch", "stroke", "glyph", "text"]);
  });
  it("then by symbol index", () => {
    expect(comparePassOrder({ colour: 0, kind: "fill", symbolIdx: 401 }, { colour: 0, kind: "fill", symbolIdx: 402 })).toBeLessThan(0);
    expect(comparePassOrder({ colour: 0, kind: "fill", symbolIdx: 5 }, { colour: 0, kind: "fill", symbolIdx: 5 })).toBe(0);
  });
});

describe("sortPassStream", () => {
  it("sorts passes and permutes objectIdx/symbolIdx with them", () => {
    const stream = sortPassStream({
      objectIdx: Uint32Array.from([10, 11, 12, 13]),
      symbolIdx: Uint32Array.from([700, 500, 400, 400]),
      passes: [stroke(6), stroke(3), fill(1), glyph(5)],
      glyphTable: [],
      fontTable: [],
    });
    expect(stream.passes.map((p) => `${p.colour}:${p.kind}`)).toEqual(["1:fill", "3:stroke", "5:glyph", "6:stroke"]);
    expect(Array.from(stream.objectIdx)).toEqual([12, 11, 13, 10]);
    expect(Array.from(stream.symbolIdx)).toEqual([400, 500, 400, 700]);
  });

  it("is stable: ties keep insertion order", () => {
    const a = fill(1), b = fill(1), c = fill(1);
    const stream = sortPassStream({
      objectIdx: Uint32Array.from([0, 1, 2]),
      symbolIdx: Uint32Array.from([401, 401, 401]),
      passes: [a, b, c],
      glyphTable: [],
      fontTable: [],
    });
    expect(stream.passes).toEqual([a, b, c]);
    expect(Array.from(stream.objectIdx)).toEqual([0, 1, 2]);
  });

  it("does not mutate its input", () => {
    const passes = [stroke(6), fill(1)];
    const input = { objectIdx: Uint32Array.from([0, 1]), symbolIdx: Uint32Array.from([0, 0]), passes, glyphTable: [], fontTable: [] };
    sortPassStream(input);
    expect(input.passes[0].kind).toBe("stroke");
    expect(Array.from(input.objectIdx)).toEqual([0, 1]);
  });
});

describe("PassStreamBuilder", () => {
  it("collects passes and builds a sorted stream", () => {
    const b = new PassStreamBuilder();
    b.push(glyph(5), 0, 418).push(fill(1), 1, 401);
    expect(b.length).toBe(2);
    const s = b.build();
    expect(s.passes.map((p) => p.kind)).toEqual(["fill", "glyph"]);
    expect(Array.from(s.objectIdx)).toEqual([1, 0]);
    expect(Array.from(s.symbolIdx)).toEqual([401, 418]);
  });

  it("copies glyph and font tables into the stream", () => {
    const b = new PassStreamBuilder();
    b.glyphTable.push({ glyphId: 1, partIdx: 0, fills: [], strokes: [] });
    b.fontTable.push({ fontId: 0, family: "liberation-sans", bold: false, italic: false });
    const s = b.build();
    expect(s.glyphTable).toHaveLength(1);
    expect(s.fontTable[0].family).toBe("liberation-sans");
    b.glyphTable.length = 0;
    expect(s.glyphTable).toHaveLength(1);
  });
});

describe("makePath", () => {
  it("builds typed arrays with zero flags by default", () => {
    const p = makePath([1, 2, 3, 4]);
    expect(p.coords).toBeInstanceOf(Int32Array);
    expect(Array.from(p.coords)).toEqual([1, 2, 3, 4]);
    expect(Array.from(p.flags)).toEqual([0, 0]);
    expect(p.closed).toBe(false);
  });
  it("rejects odd coordinate counts and mismatched flags", () => {
    expect(() => makePath([1, 2, 3])).toThrow(/pairs/);
    expect(() => makePath([1, 2, 3, 4], [0])).toThrow(/flags/);
  });
});
