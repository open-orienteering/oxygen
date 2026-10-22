import { describe, it, expect } from "vitest";
import { render } from "@oxygen/shared";
import {
  aboveZoomGate, assignBuckets, BucketLru, buildVisibleSet, CELL_UM, cellId, passBounds, prepareBucketPart, visibleCells,
  type PrepareContext, type ResidentPart,
} from "../buckets";
import { MeshAtlasBuilder, sizeClass, INSTANCE_FLOATS } from "../mesh-atlas";

const { makePath, PassStreamBuilder } = render;

const square = (x: number, y: number, s: number) => makePath([x, y, x + s, y, x + s, y + s, x, y + s], undefined, true);
const fill = (colour: number, x: number, y: number, s: number): render.FillPass => ({ kind: "fill", colour, path: square(x, y, s), rule: "evenodd" });
const stroke = (colour: number, coords: number[], widthUm = 140): render.StrokePass => ({ kind: "stroke", colour, path: makePath(coords), widthUm, cap: "butt", join: "round" });
const noMesh = () => 0;

function context(stream: render.PassStream, origin = { x: 0, y: 0 }): PrepareContext {
  const atlas = new MeshAtlasBuilder();
  const glyphMesh = new Map<string, number>();
  for (const m of stream.glyphTable) glyphMesh.set(`${m.glyphId}/${m.partIdx}`, atlas.glyph(m, 2));
  return { toleranceUm: 10, originX: origin.x, originY: origin.y, meshes: atlas.build().meshes, glyphMesh, textGlyph: new Map() };
}

describe("bucket assignment (04 §6.11)", () => {
  it("puts a small object in the cell of its bounds' centre, a straddling one where its centre is, a large one in the large bucket", () => {
    const b = new PassStreamBuilder();
    b.push(fill(1, 10_000, 10_000, 5_000), 0, 0); // cell (0, 0)
    b.push(fill(1, 45_000, 60_000, 20_000), 1, 0); // centre (55 000, 70 000) → cell (1, 1), straddles (0..1, 1)
    b.push(stroke(2, [0, 0, 200_000, 0]), 2, 1); // 200 mm long → large
    b.push(fill(1, 120_000, 10_000, 5_000), 3, 0); // cell (2, 0)
    const s = b.build();
    const a = assignBuckets(s, noMesh);
    expect(a.grid).toMatchObject({ cellUm: CELL_UM, minCol: 0, minRow: 0, cols: 3, rows: 2 });
    expect(a.largeId).toBe(6);
    expect(a.objectBucket[0]).toBe(cellId(a.grid, 0, 0));
    expect(a.objectBucket[1]).toBe(cellId(a.grid, 1, 1));
    expect(a.objectBucket[2]).toBe(a.largeId);
    expect(a.objectBucket[3]).toBe(cellId(a.grid, 2, 0));
  });

  it("keeps every pass of an object in one bucket, in stream order", () => {
    const b = new PassStreamBuilder();
    b.push(stroke(5, [1000, 1000, 2000, 1000]), 0, 0);
    b.push(fill(1, 1000, 900, 1000), 0, 1);
    b.push(fill(1, 60_000, 0, 1000), 1, 1);
    const s = b.build();
    const a = assignBuckets(s, noMesh);
    const bucket = a.objectBucket[0];
    const passes = a.bucketPasses.get(bucket)!;
    expect(passes.map((i) => s.objectIdx[i])).toEqual([0, 0]);
    expect(passes).toEqual([...passes].sort((x, y) => x - y));
    // Colour-major because the stream is.
    expect(passes.map((i) => s.passes[i].colour)).toEqual([1, 5]);
  });

  it("an object is large when its bounds exceed 2 × 2 cells in either direction, including stroke width", () => {
    const b = new PassStreamBuilder();
    b.push(fill(0, 0, 0, 2 * CELL_UM), 0, 0); // exactly 2 cells: small
    b.push(stroke(0, [0, 0, 2 * CELL_UM, 0], 200), 1, 0); // 100 mm + mitre allowance: large
    const a = assignBuckets(b.build(), noMesh);
    expect(a.objectBucket[0]).not.toBe(a.largeId);
    expect(a.objectBucket[1]).toBe(a.largeId);
  });

  it("pass bounds include half width × mitre limit, glyph radius × scale and the text em box with its halo", () => {
    expect(passBounds(stroke(0, [0, 0, 1000, 0], 100), noMesh)).toEqual({ minX: -200, minY: -200, maxX: 1200, maxY: 200 });
    const glyph: render.GlyphPass = { kind: "glyph", colour: 0, glyphId: 3, partIdx: 0, instances: Float32Array.from([5000, 5000, 1, 0, 2]) };
    expect(passBounds(glyph, (g) => (g === 3 ? 250 : 0))).toEqual({ minX: 4500, minY: 4500, maxX: 5500, maxY: 5500 });
    const text: render.TextPass = { kind: "text", colour: 0, fontId: 0, sizeUm: 4000, glyphs: Uint16Array.from([1]), positions: Float32Array.from([0, 0]), haloWidthUm: 300 };
    expect(passBounds(text, noMesh)).toEqual({ minX: -300, minY: -1300, maxX: 4300, maxY: 4300 });
  });
});

describe("visible cells", () => {
  const grid = { cellUm: CELL_UM, minCol: 0, minRow: 0, cols: 10, rows: 10 };
  it("covers the viewport plus the margin, clamped to the grid, nearest first", () => {
    // 100 × 50 mm view centred at (125, 125) mm → cols 1..3, rows 2..3 (exclusive edge at 150 mm lands in row 3).
    const view = { centreX: 125_000, centreY: 125_000, pxPerUm: 0.01, widthPx: 1000, heightPx: 500 };
    const ids = visibleCells(view, grid, 0);
    const cells = ids.map((id) => [id % 10, Math.floor(id / 10)]);
    expect(new Set(cells.map(([c]) => c))).toEqual(new Set([1, 2, 3]));
    expect(new Set(cells.map(([, r]) => r))).toEqual(new Set([2, 3]));
    expect(cells[0]).toEqual([2, 2]);
    expect(visibleCells(view, grid, 1).length).toBe(5 * 4);
    const corner = { ...view, centreX: 0, centreY: 0 };
    expect(visibleCells(corner, grid, 1).every((id) => id % 10 <= 2 && Math.floor(id / 10) <= 2)).toBe(true);
  });

  it("uses the bounding box of a rotated viewport", () => {
    const view = { centreX: 250_000, centreY: 250_000, pxPerUm: 0.01, widthPx: 1000, heightPx: 100 };
    const flat = visibleCells(view, grid, 0);
    const turned = visibleCells({ ...view, rotationDeg: 90 }, grid, 0);
    const cols = (ids: number[]) => new Set(ids.map((id) => id % 10)).size;
    const rows = (ids: number[]) => new Set(ids.map((id) => Math.floor(id / 10))).size;
    expect(cols(flat)).toBeGreaterThan(rows(flat));
    expect(rows(turned)).toBeGreaterThan(cols(turned));
  });
});

describe("zoom gate (04 §6.11)", () => {
  // 1 CSS px = 1/96 in; paper scale 1× on a screen is 3.78 CSS px per mm.
  const pxPerUm = (paperScale: number, dpr: number) => (paperScale * dpr * 96) / 25.4 / 1000;
  it("is just above 0.28× paper at 1× DPR and 0.14× at 2× DPR; a whole club map on a phone is below it", () => {
    expect(aboveZoomGate(pxPerUm(0.3, 1))).toBe(true);
    expect(aboveZoomGate(pxPerUm(0.26, 1))).toBe(false);
    expect(aboveZoomGate(pxPerUm(0.15, 2))).toBe(true);
    expect(aboveZoomGate(pxPerUm(0.13, 2))).toBe(false);
    expect(aboveZoomGate(pxPerUm(0.03, 2.625))).toBe(false);
  });
});

describe("range table (04 §7)", () => {
  function sample() {
    const b = new PassStreamBuilder();
    b.push(fill(4, 0, 0, 1000), 0, 0);
    b.push(fill(2, 2000, 0, 1000), 1, 0);
    b.push(fill(2, 4000, 0, 1000), 2, 0);
    b.push(stroke(3, [0, 0, 1000, 0, 2000, 500]), 1, 1);
    b.push(stroke(3, [0, 100, 1000, 100]), 2, 1);
    b.push({ kind: "hatch", colour: 2, path: square(0, 2000, 1000), widthUm: 100, spacingUm: 300, offsetUm: 0, angleDeg: 45 }, 3, 2);
    b.glyphTable.push({ glyphId: 7, partIdx: 0, fills: [square(-100, -100, 200)], strokes: [] });
    b.push({ kind: "glyph", colour: 5, glyphId: 7, partIdx: 0, instances: Float32Array.from([100, 100, 1, 0, 1, 300, 300, 1, 0, 1]) }, 4, 3);
    b.push({ kind: "glyph", colour: 5, glyphId: 7, partIdx: 0, instances: Float32Array.from([900, 900, 1, 0, 1]), clip: square(0, 0, 1000) }, 5, 3);
    return b.build();
  }

  it("is colour-major, contiguous and covers every index exactly once per kind", () => {
    const s = sample();
    const ctx = context(s);
    const part = prepareBucketPart(s, 0, s.passes.map((_, i) => i), "all", ctx);
    for (const k of [part.fill!, part.stroke!, part.hatch!]) {
      const r = k.ranges;
      let at = 0;
      for (let e = 0; e < r.colour.length; e++) {
        if (e > 0) expect(r.colour[e]).toBeGreaterThanOrEqual(r.colour[e - 1]);
        expect(r.start[e]).toBe(at);
        at += r.count[e];
      }
      expect(at).toBe(k.indices.length);
      for (const i of k.indices) expect(i).toBeLessThan(k.vertexCount);
    }
    expect(Array.from(part.fill!.ranges.colour)).toEqual([2, 2, 4]);
    expect(Array.from(part.fill!.ranges.object)).toEqual([1, 2, 0]);
    expect(Array.from(part.stroke!.ranges.object)).toEqual([1, 2]);
    expect(part.glyph!.instances.length).toBe(2 * INSTANCE_FLOATS);
    expect(Array.from(part.glyph!.ranges.count)).toEqual([2]);
    expect(part.clips).toHaveLength(1);
    expect(part.clips[0].object).toBe(5);
    expect(part.clips[0].instances.length).toBe(INSTANCE_FLOATS);
  });

  it("splits layers: base holds fills and hatches, detail the rest", () => {
    const s = sample();
    const ctx = context(s);
    const all = s.passes.map((_, i) => i);
    const base = prepareBucketPart(s, 0, all, "base", ctx);
    const detail = prepareBucketPart(s, 0, all, "detail", ctx);
    expect(base.fill && base.hatch).toBeTruthy();
    expect(base.stroke ?? base.glyph ?? base.clips[0]).toBeUndefined();
    expect(detail.fill ?? detail.hatch).toBeUndefined();
    expect(detail.stroke && detail.glyph).toBeTruthy();
    expect(base.gpuBytes + detail.gpuBytes).toBe(prepareBucketPart(s, 0, all, "all", ctx).gpuBytes);
  });

  it("stores positions relative to the origin and moves the hatch offset with it", () => {
    const s = sample();
    const at0 = prepareBucketPart(s, 0, s.passes.map((_, i) => i), "all", context(s));
    const shifted = prepareBucketPart(s, 0, s.passes.map((_, i) => i), "all", context(s, { x: 1000, y: 2000 }));
    const f0 = new Float32Array(at0.fill!.verts), f1 = new Float32Array(shifted.fill!.verts);
    expect(f1[0]).toBe(f0[0] - 1000);
    expect(f1[1]).toBe(f0[1] - 2000);
    // Hatch: dot(p, n) − offset is the same paper quantity.
    const h0 = new Float32Array(at0.hatch!.verts), h1 = new Float32Array(shifted.hatch!.verts);
    const stripe = (h: Float32Array, ox: number, oy: number) => (h[0] + ox) * h[2] + (h[1] + oy) * h[3] - (h[5] + ox * h[2] + oy * h[3]);
    expect(stripe(h1, 0, 0)).toBeCloseTo(stripe(h0, 0, 0), 3);
  });

  it("packs stroke vertices as f32 position, i16 offset / mitre limit and u16 half width in ½ µm", () => {
    const b = new PassStreamBuilder();
    b.push(stroke(0, [0, 0, 1000, 0], 125), 0, 0);
    const s = b.build();
    const part = prepareBucketPart(s, 0, [0], "all", context(s));
    const v = part.stroke!;
    expect(v.verts.byteLength).toBe(16 * v.vertexCount);
    const i16 = new Int16Array(v.verts), u16 = new Uint16Array(v.verts);
    expect(u16[6]).toBe(125); // 62.5 µm
    expect(Math.abs(i16[5] / 32767) * 4).toBeCloseTo(1, 3); // unit normal (0, ±1)
  });
});

describe("visible set (04 §6.8 point 2)", () => {
  function parts(): ResidentPart[] {
    const b = new PassStreamBuilder();
    b.push(fill(1, 0, 0, 1000), 0, 0);
    b.push(fill(3, 0, 0, 1000), 1, 0);
    b.push(fill(1, 60_000, 0, 1000), 2, 0);
    b.push(fill(1, 62_000, 0, 1000), 3, 0);
    b.push(stroke(2, [60_000, 0, 61_000, 0]), 2, 1);
    const s = b.build();
    const ctx = context(s);
    const a = assignBuckets(s, noMesh);
    const p0 = prepareBucketPart(s, a.objectBucket[0], a.bucketPasses.get(a.objectBucket[0])!, "all", ctx);
    const p1 = prepareBucketPart(s, a.objectBucket[2], a.bucketPasses.get(a.objectBucket[2])!, "all", ctx);
    return [
      { part: p0, base: { fill: 0, hatch: 0, stroke: 0 } },
      { part: p1, base: { fill: p0.fill!.vertexCount, hatch: 0, stroke: 0 } },
    ];
  }

  it("concatenates each colour across buckets into one draw, in colour order, rebased onto arena offsets", () => {
    const ps = parts();
    const vs = buildVisibleSet(ps);
    expect(vs.fill.draws.map((d) => d.colour)).toEqual([1, 3]);
    const [c1, c3] = vs.fill.draws;
    expect(c1.count).toBe(3 * 6); // three squares of colour 1, two triangles each
    expect(c3.offset).toBe(c1.count);
    const all = Array.from(vs.fill.indices);
    expect(all.length).toBe(ps[0].part.fill!.indices.length + ps[1].part.fill!.indices.length);
    // Bucket 1's indices are offset by bucket 0's vertex count.
    expect(Math.max(...all)).toBe(ps[0].part.fill!.vertexCount + ps[1].part.fill!.vertexCount - 1);
    expect(vs.stroke.draws).toHaveLength(1);
    expect(vs.colours).toEqual([1, 2, 3]);
  });

  it("is exactly the union of the visible parts: dropping a part drops its ranges", () => {
    const ps = parts();
    const vs = buildVisibleSet([ps[0]]);
    expect(Array.from(vs.fill.indices)).toEqual(Array.from(ps[0].part.fill!.indices));
    expect(vs.stroke.draws).toHaveLength(0);
  });

  it("skips hidden objects' ranges", () => {
    const ps = parts();
    const vs = buildVisibleSet(ps, new Set([2, 1]));
    expect(vs.fill.draws.map((d) => [d.colour, d.count])).toEqual([[1, 12]]);
    expect(vs.stroke.draws).toHaveLength(0);
    expect(vs.colours).toEqual([1]);
  });

  it("groups instances by (colour, size class)", () => {
    const b = new PassStreamBuilder();
    b.glyphTable.push({ glyphId: 1, partIdx: 0, fills: [square(-100, -100, 200)], strokes: [] });
    b.glyphTable.push({ glyphId: 2, partIdx: 0, fills: [render.circlePath(0, 0, 300)], strokes: [] });
    b.push({ kind: "glyph", colour: 4, glyphId: 1, partIdx: 0, instances: Float32Array.from([0, 0, 1, 0, 1]) }, 0, 0);
    b.push({ kind: "glyph", colour: 4, glyphId: 2, partIdx: 0, instances: Float32Array.from([500, 0, 1, 0, 1, 900, 0, 1, 0, 1]) }, 1, 1);
    b.push({ kind: "glyph", colour: 4, glyphId: 1, partIdx: 0, instances: Float32Array.from([0, 500, 1, 0, 1]) }, 2, 0);
    const s = b.build();
    const ctx = context(s);
    const part = prepareBucketPart(s, 0, s.passes.map((_, i) => i), "all", ctx);
    const vs = buildVisibleSet([{ part, base: { fill: 0, hatch: 0, stroke: 0 } }]);
    const small = ctx.meshes[ctx.glyphMesh.get("1/0")!], round = ctx.meshes[ctx.glyphMesh.get("2/0")!];
    expect(small.cls).not.toBe(round.cls);
    expect(vs.glyph.draws.map((d) => [d.colour, d.cls, d.count])).toEqual(
      [[4, small.cls, 2], [4, round.cls, 2]].sort((a, b) => a[1] - b[1]),
    );
    // Each instance carries its mesh's base and count.
    for (let i = 0; i < vs.glyph.instances.length; i += INSTANCE_FLOATS) {
      const base = vs.glyph.instances[i + 5], count = vs.glyph.instances[i + 6];
      expect([small.base, round.base]).toContain(base);
      expect(count).toBe(base === small.base ? small.count : round.count);
    }
  });
});

describe("text instances (MSDF quads, §5.2 \"Text atlas\")", () => {
  const textPass = (colour: number, glyphs: number[], extra: Partial<render.TextPass> = {}): render.TextPass => ({
    kind: "text", colour, fontId: 0, sizeUm: 4000, glyphs: Uint16Array.from(glyphs),
    positions: Float32Array.from(glyphs.flatMap((_, i) => [10_000 + 2000 * i, 20_000])), ...extra,
  });

  it("one instance per atlas glyph: origin-relative position, cos/sin, em size, entry, halo em; missing glyphs skipped", () => {
    const b = new PassStreamBuilder();
    b.push(textPass(3, [5, 6, 7]), 0, 0);
    const s = b.build();
    const ctx = context(s, { x: 1000, y: 2000 });
    ctx.textGlyph.set(0, { entries: Int32Array.from([12, -1, 40]), pages: Uint8Array.from([0, 0, 0]), haloEm: 0 });
    const part = prepareBucketPart(s, 0, [0], "all", ctx);
    const inst = Array.from(part.text!.instances);
    expect(inst).toEqual([9000, 18_000, 1, 0, 4000, 12, 0, 0, 13_000, 18_000, 1, 0, 4000, 40, 0, 0]);
    expect(part.text!.ranges.group[0]).toBe(0);
  });

  it("carry each glyph's rotation from TextPass.angles (§3.5) and the halo of a halo pass", () => {
    const b = new PassStreamBuilder();
    b.push(textPass(0, [5, 5], { angles: Float32Array.from([0, 90]), haloWidthUm: 100 }), 0, 0);
    const s = b.build();
    const ctx = context(s);
    ctx.textGlyph.set(0, { entries: Int32Array.from([1, 1]), pages: Uint8Array.from([0, 0]), haloEm: 0.025 });
    const inst = prepareBucketPart(s, 0, [0], "all", ctx).text!.instances;
    expect([inst[2], inst[3]]).toEqual([1, 0]);
    expect(inst[INSTANCE_FLOATS + 2]).toBeCloseTo(0, 9);
    expect(inst[INSTANCE_FLOATS + 3]).toBeCloseTo(1, 9);
    expect(inst[6]).toBeCloseTo(0.025, 7);
  });

  it("group by (colour, page): one draw per colour per page across buckets; hidden objects skipped", () => {
    const b = new PassStreamBuilder();
    b.push(textPass(2, [1, 2]), 0, 0);
    b.push(textPass(2, [3]), 1, 0);
    b.push(textPass(5, [4]), 2, 0);
    const s = b.build();
    const ctx = context(s);
    ctx.textGlyph.set(0, { entries: Int32Array.from([0, 1]), pages: Uint8Array.from([0, 1]), haloEm: 0 });
    ctx.textGlyph.set(1, { entries: Int32Array.from([2]), pages: Uint8Array.from([0]), haloEm: 0 });
    ctx.textGlyph.set(2, { entries: Int32Array.from([3]), pages: Uint8Array.from([0]), haloEm: 0 });
    const p0 = prepareBucketPart(s, 0, [0, 1], "all", ctx), p1 = prepareBucketPart(s, 1, [2], "all", ctx);
    const base = { fill: 0, hatch: 0, stroke: 0 };
    const vs = buildVisibleSet([{ part: p0, base }, { part: p1, base }]);
    expect(vs.text.draws.map((d) => [d.colour, d.cls, d.count])).toEqual([[2, 0, 2], [2, 1, 1], [5, 0, 1]]);
    const hidden = buildVisibleSet([{ part: p0, base }, { part: p1, base }], new Set([1]));
    expect(hidden.text.draws.map((d) => [d.colour, d.cls, d.count])).toEqual([[2, 0, 1], [2, 1, 1], [5, 0, 1]]);
  });

  it("a text pass the worker did not resolve (no atlas) draws nothing", () => {
    const b = new PassStreamBuilder();
    b.push(textPass(0, [1]), 0, 0);
    const s = b.build();
    expect(prepareBucketPart(s, 0, [0], "all", context(s)).text).toBeUndefined();
  });
});

describe("clip groups (pattern clip mode, 04 §6.5)", () => {
  function clipPart(areas: [number, number][]) {
    const b = new PassStreamBuilder();
    b.glyphTable.push({ glyphId: 9, partIdx: 0, fills: [square(-50, -50, 100)], strokes: [] });
    areas.forEach(([x, y], i) => {
      b.push({ kind: "glyph", colour: 6, glyphId: 9, partIdx: 0, instances: Float32Array.from([x + 500, y + 500, 1, 0, 1]), clip: square(x, y, 1000) }, i, 0);
    });
    const s = b.build();
    return prepareBucketPart(s, 0, s.passes.map((_, i) => i), "all", context(s));
  }

  it("merges clip passes whose footprints do not meet into one group (one mark / draw / clear)", () => {
    const part = clipPart([[0, 0], [5000, 0], [10_000, 0]]);
    const vs = buildVisibleSet([{ part, base: { fill: 0, hatch: 0, stroke: 0 } }]);
    expect(vs.clips.groups).toHaveLength(1);
    const g = vs.clips.groups[0];
    expect(g.members).toBe(3);
    expect(g.instances).toBe(3);
    expect(g.count).toBe(3 * 6);
    // Indices are global into the concatenated positions.
    expect(Math.max(...vs.clips.indices)).toBe(vs.clips.positions.length / 2 - 1);
  });

  it("keeps passes whose footprints meet in separate groups, so no instance falls in a neighbour's area", () => {
    const part = clipPart([[0, 0], [1000, 0], [5000, 0]]); // the first two areas touch
    const vs = buildVisibleSet([{ part, base: { fill: 0, hatch: 0, stroke: 0 } }]);
    expect(vs.clips.groups.map((g) => g.members)).toEqual([2, 1]);
  });

  it("drops hidden objects' clip passes", () => {
    const part = clipPart([[0, 0], [5000, 0]]);
    const vs = buildVisibleSet([{ part, base: { fill: 0, hatch: 0, stroke: 0 } }], new Set([0, 1]));
    expect(vs.clips.groups).toHaveLength(0);
    expect(vs.colours).toEqual([]);
  });
});

describe("mesh atlas", () => {
  it("packs meshes back to back, size classes are powers of two, radius includes stroke half width", () => {
    const atlas = new MeshAtlasBuilder();
    const a = atlas.glyph({ glyphId: 1, partIdx: 0, fills: [square(-100, -100, 200)], strokes: [] }, 2);
    const b = atlas.glyph({ glyphId: 1, partIdx: 1, fills: [], strokes: [{ path: makePath([-500, 0, 500, 0]), widthUm: 100, cap: "butt", join: "miter" }] }, 2);
    expect(atlas.glyph({ glyphId: 1, partIdx: 0, fills: [], strokes: [] }, 2)).toBe(a); // cached by id
    const built = atlas.build();
    const [ma, mb] = [built.meshes[a], built.meshes[b]];
    expect(ma.base).toBe(0);
    expect(mb.base).toBe(ma.count);
    expect(ma.count).toBe(6);
    expect(2 ** ma.cls).toBeGreaterThanOrEqual(ma.count);
    expect(2 ** (ma.cls - 1)).toBeLessThan(ma.count);
    expect(mb.radius).toBe(550);
    expect(built.data.length % (2048 * 4)).toBe(0);
    // Stroke vertices carry the half width in the second texel.
    expect(built.data[mb.base * 8 + 4]).toBe(50);
    expect(sizeClass(1)).toBe(0);
    expect(sizeClass(64)).toBe(6);
    expect(sizeClass(65)).toBe(7);
  });
});

describe("LRU eviction (04 §6.11)", () => {
  it("evicts least recently used parts until within budget, never the protected set", () => {
    const lru = new BucketLru(1000);
    lru.fixedBytes = 200;
    lru.add(1, 300);
    lru.add(2, 300);
    lru.add(3, 300);
    lru.touch([1]);
    expect(lru.totalBytes).toBe(1100);
    const { evict, over } = lru.evictions(new Set([3]));
    expect(evict).toEqual([2]);
    expect(over).toBe(false);
  });

  it("reports over budget when the protected set alone exceeds it", () => {
    const lru = new BucketLru(500);
    lru.add(1, 400);
    lru.add(2, 400);
    const { evict, over } = lru.evictions(new Set([1, 2]));
    expect(evict).toEqual([]);
    expect(over).toBe(true);
  });

  it("does nothing within budget and forgets removed parts", () => {
    const lru = new BucketLru(1000);
    lru.add(1, 400);
    expect(lru.evictions(new Set()).evict).toEqual([]);
    lru.remove(1);
    expect(lru.totalBytes).toBe(0);
    expect(lru.has(1)).toBe(false);
  });
});

