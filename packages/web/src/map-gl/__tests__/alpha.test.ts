/**
 * J3 (docs/map-rendering.md §5.2 "Alpha items", "Alpha layers"): a pass with opacity or
 * Multiply is prepared out of the range tables as an alpha item, and drawn as its own layer
 * after its colour's opaque steps; an opaque stream prepares and builds exactly as before.
 */
import { describe, expect, it } from "vitest";
import { render } from "@oxygen/shared";
import { buildVisibleSet, filterEntryKey, passAlphaState, prepareBucketPart, prepareBucketPartFrom, partTransferables, type PrepareContext, type ResidentPart } from "../buckets";
import { MeshAtlasBuilder, INSTANCE_FLOATS } from "../mesh-atlas";
import { prepareStream, streamHasAlpha } from "../prepare";
import { highlightPasses } from "../worker";

const { makePath, PassStreamBuilder } = render;
const square = (x: number, y: number, s: number) => makePath([x, y, x + s, y, x + s, y + s, x, y + s], undefined, true);
const fill = (colour: number, x: number, s: number, alpha: render.PassAlpha = {}): render.FillPass => ({ kind: "fill", colour, path: square(x, 0, s), rule: "evenodd", ...alpha });
const stroke = (colour: number, alpha: render.PassAlpha = {}): render.StrokePass => ({ kind: "stroke", colour, path: makePath([0, 0, 1000, 1000, 1000, 0, 0, 1000]), widthUm: 300, cap: "butt", join: "round", ...alpha });
const mesh: render.GlyphMesh = { glyphId: 1, partIdx: 0, fills: [square(-500, -500, 1000)], strokes: [] };
const glyph = (colour: number, alpha: render.PassAlpha = {}, clip?: render.RenderPath): render.GlyphPass => ({ kind: "glyph", colour, glyphId: 1, partIdx: 0, instances: new Float32Array([0, 0, 1, 0, 1, 600, 0, 1, 0, 1]), ...(clip ? { clip } : {}), ...alpha });

function ctx(stream: render.PassStream): PrepareContext {
  const atlas = new MeshAtlasBuilder();
  const glyphMesh = new Map<string, number>();
  for (const m of stream.glyphTable) glyphMesh.set(`${m.glyphId}/${m.partIdx}`, atlas.glyph(m, 2));
  return { toleranceUm: 10, originX: 0, originY: 0, meshes: atlas.build().meshes, glyphMesh, textGlyph: new Map() };
}
function build(passes: [render.Pass, number][]): render.PassStream {
  const b = new PassStreamBuilder();
  for (const [p, o] of passes) b.push(p, o, 0);
  const s = b.build();
  s.glyphTable.push(mesh);
  return s;
}
const resident = (part: ReturnType<typeof prepareBucketPart>, base = { fill: 0, hatch: 0, stroke: 0 }): ResidentPart => ({ part, base });

describe("passAlphaState", () => {
  it("absent or ≥ 1 without blend is opaque; ≤ 0 is dropped; Multiply alone is opacity 1", () => {
    expect(passAlphaState(fill(1, 0, 10))).toBeNull();
    expect(passAlphaState(fill(1, 0, 10, { opacity: 1 }))).toBeNull();
    expect(passAlphaState(fill(1, 0, 10, { opacity: 0 }))).toBe("drop");
    expect(passAlphaState(fill(1, 0, 10, { opacity: 0.4 }))).toEqual({ opacity: 0.4, multiply: false });
    expect(passAlphaState(fill(1, 0, 10, { blend: "multiply" }))).toEqual({ opacity: 1, multiply: true });
  });
});

describe("prepare: alpha items (§5.2)", () => {
  it("an opaque stream's part has no alpha key and is as before", () => {
    const s = build([[fill(1, 0, 1000), 0], [stroke(2), 1]]);
    const part = prepareBucketPart(s, 0, [0, 1], "all", ctx(s));
    expect("alpha" in part).toBe(false);
    expect(part.fill!.ranges.object).toEqual(Uint32Array.from([0]));
  });

  it("an alpha pass's geometry is in the part's arrays but in no range table; one item per pass", () => {
    const s = build([[fill(1, 0, 1000), 0], [fill(1, 2000, 1000, { opacity: 0.5 }), 1], [stroke(2, { blend: "multiply" }), 2], [glyph(3, { opacity: 0.3 }), 3], [fill(4, 0, 10, { opacity: 0 }), 4]]);
    const part = prepareBucketPart(s, 0, [0, 1, 2, 3, 4], "all", ctx(s));
    expect([...part.fill!.ranges.object]).toEqual([0]);
    expect(part.fill!.indices.length).toBeGreaterThan(part.fill!.ranges.count[0]);
    expect(part.stroke!.ranges.object.length).toBe(0);
    expect(part.glyph).toBeUndefined();
    expect(part.alpha!.map((a) => [a.kind, a.object, a.opacity, a.multiply])).toEqual([
      ["fill", 1, 0.5, false],
      ["stroke", 2, 1, true],
      ["glyph", 3, 0.3, false],
    ]);
    expect(part.alpha![2].instances!.length).toBe(2 * INSTANCE_FLOATS);
    // Every alpha buffer travels.
    const bufs = partTransferables(part);
    expect(bufs).toContain(part.alpha![2].instances!.buffer);
  });

  it("an alpha fill or stroke between two opaque ones of its colour stays out of the opaque span (review J3)", () => {
    const s = build([
      [fill(1, 0, 1000), 0], [fill(1, 2000, 1000, { opacity: 0.5 }), 1], [fill(1, 4000, 1000), 2],
      [stroke(2), 3], [stroke(2, { opacity: 0.5 }), 4], [stroke(2), 5],
    ]);
    const part = prepareBucketPart(s, 0, [0, 1, 2, 3, 4, 5], "all", ctx(s));
    const all = buildVisibleSet([resident(part)]);
    const hiding = buildVisibleSet([resident(part)], new Set([99]));
    for (const kind of ["fill", "stroke"] as const) {
      const r = part[kind]!.ranges;
      const opaque = r.count[0] + r.count[1];
      const drawn = (vs: typeof all) => vs[kind].draws.reduce((n, d) => n + d.count, 0);
      expect(drawn(all), kind).toBe(opaque);
      expect(drawn(hiding), kind).toBe(opaque);
      // The alpha indices come after every opaque one of the kind.
      const item = part.alpha!.find((a) => a.kind === kind)!;
      expect(item.start, kind).toBe(r.start[1] + r.count[1]);
      expect(item.start! + item.count!, kind).toBe(part[kind]!.indices.length);
    }
  });

  it("a clipped glyph pass is an alpha item with its area", () => {
    const s = build([[glyph(3, { opacity: 0.5 }, square(-100, -100, 900)), 0]]);
    const part = prepareBucketPart(s, 0, [0], "all", ctx(s));
    expect(part.clips).toEqual([]);
    expect(part.alpha![0].clip!.indices.length).toBeGreaterThan(0);
  });

  it("two sources keep their order: the pinned document's before the patch's within a colour", () => {
    const a = build([[fill(1, 0, 1000, { opacity: 0.5 }), 0]]);
    const b = build([[fill(1, 0, 1000, { opacity: 0.5 }), 7]]);
    const c = ctx(a);
    const part = prepareBucketPartFrom([{ stream: a, passes: [0], glyphMesh: c.glyphMesh, textGlyph: new Map() }, { stream: b, passes: [0], glyphMesh: c.glyphMesh, textGlyph: new Map() }], 0, "all", c);
    expect(part.alpha!.map((x) => [x.source, x.object])).toEqual([[0, 0], [1, 7]]);
  });
});

describe("visible set: alpha layers (§5.2)", () => {
  it("without alpha items it is as before (no alpha key, no alpha steps)", () => {
    const s = build([[fill(1, 0, 1000), 0]]);
    const vs = buildVisibleSet([resident(prepareBucketPart(s, 0, [0], "all", ctx(s)))]);
    expect("alpha" in vs).toBe(false);
    expect(vs.layers).toEqual([{ colour: 1, mask: -1 }]);
  });

  it("per colour: the opaque steps, then the alpha layers in stream order, then the dynamic part's", () => {
    const s = build([[fill(1, 0, 1000), 0], [fill(1, 2000, 1000, { opacity: 0.5 }), 1], [fill(1, 4000, 1000, { opacity: 0.25 }), 2], [stroke(2, { opacity: 0.5 }), 3]]);
    const c = ctx(s);
    const map = resident(prepareBucketPart(s, 0, [0, 1, 2, 3], "all", c));
    const course = build([[fill(1, 0, 500, { blend: "multiply" }), 9]]);
    const dyn = resident(prepareBucketPart(course, -2, [0], "all", ctx(course)), { fill: 100, hatch: 0, stroke: 0 });
    const vs = buildVisibleSet([dyn, map]);
    expect(vs.layers).toEqual([
      { colour: 1, mask: -1 },
      { colour: 1, mask: -1, alpha: 0 },
      { colour: 1, mask: -1, alpha: 1 },
      { colour: 1, mask: -1, alpha: 2 },
      { colour: 2, mask: -1, alpha: 3 },
    ]);
    expect(vs.alpha!.map((l) => [l.kind, l.opacity, l.multiply])).toEqual([["fill", 0.5, false], ["fill", 0.25, false], ["fill", 1, true], ["stroke", 0.5, false]]);
    // The alpha indices follow the opaque ones in the same buffer, rebased on the part's arena offset.
    const opaque = vs.fill.draws.reduce((n, d) => n + d.count, 0);
    expect(vs.alpha![0].offset).toBe(opaque);
    expect(vs.fill.indices.length).toBe(opaque + vs.alpha!.slice(0, 3).reduce((n, l) => n + l.count, 0));
    const dynFirst = vs.fill.indices[vs.alpha![2].offset];
    expect(dynFirst).toBeGreaterThanOrEqual(100);
  });

  it("skips hidden objects and takes the (object, colour) mask", () => {
    const s = build([[fill(1, 0, 1000, { opacity: 0.5 }), 0], [fill(1, 2000, 1000, { opacity: 0.5 }), 1]]);
    const part = resident(prepareBucketPart(s, 0, [0, 1], "all", ctx(s)));
    expect(buildVisibleSet([part], new Set([0])).alpha!.length).toBe(1);
    const filter = { entryMask: new Map([[filterEntryKey(1, 1), 0]]), positions: new Float32Array(6), indices: Uint32Array.from([0, 1, 2]), masks: [{ offset: 0, count: 3 }] };
    const vs = buildVisibleSet([part], undefined, filter);
    expect(vs.alpha!.map((l) => l.mask)).toEqual([-1, 0]);
    expect(vs.layers.filter((l) => l.alpha !== undefined)).toEqual([{ colour: 1, mask: -1, alpha: 0 }, { colour: 1, mask: 0, alpha: 1 }]);
  });

  it("instances of glyph and clipped-glyph alpha layers go after the opaque instances", () => {
    const s = build([[glyph(3), 0], [glyph(3, { opacity: 0.5 }), 1], [glyph(3, { opacity: 0.5 }, square(-100, -100, 900)), 2]]);
    const vs = buildVisibleSet([resident(prepareBucketPart(s, 0, [0, 1, 2], "all", ctx(s)))]);
    expect(vs.alpha!.map((l) => l.kind)).toEqual(["glyph", "clip"]);
    expect(vs.alpha![0].runs[0].first).toBe(2);
    expect(vs.glyph.instances.length).toBe(4 * INSTANCE_FLOATS);
    expect(vs.alpha![1].runs[0].first).toBe(0);
    expect(vs.clips.instances.length).toBe(2 * INSTANCE_FLOATS);
    expect(vs.alpha![1].count).toBeGreaterThan(0);
  });
});

describe("the per-pass path and the highlight (§5.2, §5.5)", () => {
  it("prepareStream refuses an alpha stream", () => {
    const s = build([[fill(1, 0, 1000, { opacity: 0.5 }), 0]]);
    expect(streamHasAlpha(s)).toBe(true);
    expect(() => prepareStream(s)).toThrow("arena path");
  });

  it("highlight passes lose opacity and blend", () => {
    const s = build([[stroke(2, { opacity: 0.5, blend: "multiply" }), 0], [glyph(3, { opacity: 0.5 }), 0]]);
    const h = highlightPasses(s, [0, 1], new Map(), 1);
    for (const p of h.stream.passes) expect([p.opacity, p.blend]).toEqual([undefined, undefined]);
    expect(s.passes[0].opacity).toBe(0.5);
  });
});
