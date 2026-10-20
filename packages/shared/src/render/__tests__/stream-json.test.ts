import { describe, expect, it } from "vitest";
import { renderFixtures } from "../__fixtures__/streams/index.js";
import { makePath, type PassStream } from "../pass-stream.js";
import { diffPassStreams, passStreamFromJson, passStreamToJson } from "../stream-json.js";

describe("passStreamFromJson / passStreamToJson", () => {
  it("round-trips every fixture through the JSON projection", () => {
    for (const [name, json] of Object.entries(renderFixtures)) {
      const stream = passStreamFromJson(json);
      const again = passStreamFromJson(passStreamToJson(stream));
      expect(diffPassStreams(stream, again), name).toEqual([]);
    }
  });

  it("round-trips per-glyph text angles and the diff sees them", () => {
    const j = renderFixtures["text-with-halo"];
    const withAngles = { ...j, passes: j.passes.map((p) => (p.kind === "text" ? { ...p, angles: p.glyphs.map((_, i) => 10 * i) } : p)) };
    const a = passStreamFromJson(withAngles);
    const t = a.passes.find((p) => p.kind === "text");
    expect(t && t.kind === "text" && t.angles).toBeInstanceOf(Float32Array);
    expect(passStreamToJson(a).passes.find((p) => p.kind === "text")).toMatchObject({ angles: [0, 10, 20] });
    expect(diffPassStreams(a, passStreamFromJson(passStreamToJson(a)))).toEqual([]);
    expect(diffPassStreams(a, passStreamFromJson(j)).map((d) => d.what)).toContain("angles present on one side only");
    const bad = { ...j, passes: j.passes.map((p) => (p.kind === "text" ? { ...p, angles: [0] } : p)) };
    expect(() => passStreamFromJson(bad)).toThrow(/one per glyph/);
  });

  it("the diff compares a stroke's taper", () => {
    const j = renderFixtures["dashed-bezier-stroke"];
    const tapered = { ...j, passes: j.passes.map((p) => (p.kind === "stroke" ? { ...p, cap: "pointed" as const, taper: { startUm: 750 } } : p)) };
    const pointed = { ...j, passes: j.passes.map((p) => (p.kind === "stroke" ? { ...p, cap: "pointed" as const } : p)) };
    const a = passStreamFromJson(tapered);
    expect(diffPassStreams(a, passStreamFromJson(passStreamToJson(a)))).toEqual([]);
    expect(diffPassStreams(a, passStreamFromJson(pointed)).map((d) => d.what)).toContain("taper");
  });

  it("produces typed arrays and canonical order", () => {
    const s = passStreamFromJson(renderFixtures["colour-order"]);
    expect(s.objectIdx).toBeInstanceOf(Uint32Array);
    expect(s.passes.map((p) => p.colour)).toEqual([1, 3, 3, 5, 6]);
    // Two brown strokes keep their symbol order (502 before 503).
    expect(Array.from(s.symbolIdx)).toEqual([401, 502, 503, 418, 701]);
    const fill = s.passes[0];
    expect(fill.kind).toBe("fill");
    if (fill.kind === "fill") expect(fill.path.coords).toBeInstanceOf(Int32Array);
  });

  it("applies schema defaults", () => {
    const s = passStreamFromJson({
      objectIdx: [0],
      symbolIdx: [0],
      passes: [{ kind: "hatch", colour: 1, path: { coords: [0, 0, 1, 0, 1, 1] }, widthUm: 100, spacingUm: 500 }],
    });
    const h = s.passes[0];
    expect(h.kind).toBe("hatch");
    if (h.kind === "hatch") {
      expect(h.offsetUm).toBe(0);
      expect(h.angleDeg).toBe(0);
    }
    expect(s.glyphTable).toEqual([]);
    expect(s.fontTable).toEqual([]);
  });

  it("rejects non-parallel index arrays", () => {
    expect(() => passStreamFromJson({ objectIdx: [0, 1], symbolIdx: [0], passes: [{ kind: "fill", colour: 0, path: { coords: [] } }] })).toThrow(/parallel/);
  });

  it("rejects malformed geometry", () => {
    expect(() => passStreamFromJson({ objectIdx: [0], symbolIdx: [0], passes: [{ kind: "fill", colour: 0, path: { coords: [1, 2, 3] } }] })).toThrow(/pairs/);
    expect(() =>
      passStreamFromJson({ objectIdx: [0], symbolIdx: [0], passes: [{ kind: "glyph", colour: 0, glyphId: 1, instances: [0, 0, 1] }] }),
    ).toThrow(/5 numbers/);
    expect(() =>
      passStreamFromJson({
        objectIdx: [0], symbolIdx: [0],
        passes: [{ kind: "text", colour: 0, fontId: 0, sizeUm: 100, glyphs: [1, 2], positions: [0, 0] }],
      }),
    ).toThrow(/positions/);
  });

  it("rejects unknown pass kinds and bad flag values", () => {
    expect(() => passStreamFromJson({ objectIdx: [0], symbolIdx: [0], passes: [{ kind: "sparkle", colour: 0 }] })).toThrow();
    expect(() =>
      passStreamFromJson({ objectIdx: [0], symbolIdx: [0], passes: [{ kind: "fill", colour: 0, path: { coords: [0, 0], flags: [256] } }] }),
    ).toThrow();
  });

  it("omits all-zero flags and quantises floats in the projection", () => {
    const j = passStreamToJson(passStreamFromJson(renderFixtures["fill-with-holes"]));
    const p = j.passes[0];
    expect(p.kind).toBe("fill");
    if (p.kind === "fill") expect(p.path.flags).toBeDefined();
    const g = passStreamToJson({
      objectIdx: Uint32Array.from([0]),
      symbolIdx: Uint32Array.from([0]),
      passes: [{ kind: "glyph", colour: 0, glyphId: 1, partIdx: 0, instances: Float32Array.from([1.00049, 2, 0.1, 0.2, 1]) }],
      glyphTable: [],
      fontTable: [],
    });
    const gp = g.passes[0];
    if (gp.kind === "glyph") expect(gp.instances[0]).toBe(1);
    const plain = passStreamToJson(passStreamFromJson(renderFixtures["colour-order"]));
    const first = plain.passes[0];
    if (first.kind === "fill") expect(first.path.flags).toBeUndefined();
  });

  it("is deterministic regardless of input order", () => {
    const a = passStreamFromJson(renderFixtures["colour-order"]);
    const shuffled: PassStream = {
      ...a,
      passes: [...a.passes].reverse(),
      objectIdx: Uint32Array.from(Array.from(a.objectIdx).reverse()),
      symbolIdx: Uint32Array.from(Array.from(a.symbolIdx).reverse()),
    };
    expect(JSON.stringify(passStreamToJson(shuffled))).toBe(JSON.stringify(passStreamToJson(a)));
  });
});

describe("diffPassStreams", () => {
  const base = () => passStreamFromJson(renderFixtures["dashed-bezier-stroke"]);

  it("reports no differences for equal streams", () => {
    expect(diffPassStreams(base(), base())).toEqual([]);
  });

  it("tolerates coordinate noise within lengthToleranceUm", () => {
    const b = base();
    const p = b.passes[0];
    if (p.kind !== "stroke") throw new Error("fixture changed");
    const moved = { ...p, path: { ...p.path, coords: Int32Array.from(p.path.coords) } };
    moved.path.coords[0] += 1;
    const s2: PassStream = { ...b, passes: [moved, b.passes[1]] };
    expect(diffPassStreams(base(), s2)).toEqual([]);
    expect(diffPassStreams(base(), s2, { lengthToleranceUm: 0 })).toEqual([
      { pass: 0, what: "stroke path coord 0: 0 vs 1" },
    ]);
  });

  it("names the pass and the property that differs", () => {
    const b = base();
    const p = b.passes[1];
    if (p.kind !== "stroke" || !p.slices) throw new Error("fixture changed");
    const s2: PassStream = { ...b, passes: [b.passes[0], { ...p, widthUm: 600, slices: p.slices.slice(0, 3) }] };
    const d = diffPassStreams(b, s2);
    expect(d).toEqual([
      { pass: 1, what: "widthUm 500 vs 600" },
      { pass: 1, what: "slice count 4 vs 3" },
    ]);
  });

  it("reports pass count and kind mismatches", () => {
    const b = base();
    const s2: PassStream = {
      ...b,
      passes: [{ kind: "fill", colour: 3, path: makePath([0, 0, 1, 0, 1, 1], undefined, true), rule: "evenodd" }],
      objectIdx: Uint32Array.from([0]),
      symbolIdx: Uint32Array.from([503]),
    };
    const d = diffPassStreams(b, s2);
    expect(d[0]).toEqual({ pass: -1, what: "pass count 2 vs 1" });
    expect(d[1]).toEqual({ pass: 0, what: "kind stroke vs fill" });
  });

  it("flags objectIdx / symbolIdx changes", () => {
    const b = base();
    const s2: PassStream = { ...b, objectIdx: Uint32Array.from([9, b.objectIdx[1]]) };
    expect(diffPassStreams(b, s2)).toEqual([{ pass: 0, what: "objectIdx 0 vs 9" }]);
  });
});
