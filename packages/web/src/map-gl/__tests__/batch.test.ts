import { describe, it, expect } from "vitest";
import { render } from "@oxygen/shared";
import { fanFromRings, prepareStream, strokeGeometry } from "../prepare";
import { buildBatches, mergeStrokes, triangulateFills } from "../batch";

const { makePath, PassStreamBuilder, circlePath } = render;

/** Signed area of an indexed triangle list. */
function indexedArea(positions: Float32Array, indices: Uint32Array): number {
  let s = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [indices[i] * 2, indices[i + 1] * 2, indices[i + 2] * 2];
    s += ((positions[b] - positions[a]) * (positions[c + 1] - positions[a + 1]) - (positions[c] - positions[a]) * (positions[b + 1] - positions[a + 1])) / 2;
  }
  return Math.abs(s);
}

const square = (x: number, y: number, s: number) => [x, y, x + s, y, x + s, y + s, x, y + s];

describe("triangulateFills", () => {
  it("merges several rings into one indexed buffer and respects holes", () => {
    const withHole = fanFromRings([square(0, 0, 1000), square(250, 250, 500)]);
    const plain = fanFromRings([square(2000, 0, 1000)]);
    const batch = triangulateFills([withHole, plain], 7);
    expect(batch.colour).toBe(7);
    expect(batch.passes).toBe(2);
    expect(batch.positions.length).toBe((4 + 4 + 4) * 2);
    // 1000² − 500² + 1000² = 1 750 000
    expect(indexedArea(batch.positions, batch.indices)).toBeCloseTo(1_750_000, 3);
    // Every index points into the merged position buffer.
    for (const i of batch.indices) expect(i).toBeLessThan(batch.positions.length / 2);
    expect(Math.max(...batch.indices)).toBeGreaterThanOrEqual(8); // the second polygon was offset past the first
  });

  it("skips empty geometry", () => {
    const batch = triangulateFills([fanFromRings([])], 0);
    expect(batch.positions.length).toBe(0);
    expect(batch.indices.length).toBe(0);
  });
});

describe("mergeStrokes", () => {
  it("interleaves the half width as a fifth vertex component", () => {
    const b = new PassStreamBuilder();
    b.push({ kind: "stroke", colour: 0, path: makePath([0, 0, 1000, 0]), widthUm: 100, cap: "butt", join: "miter" }, 0, 0);
    b.push({ kind: "stroke", colour: 0, path: makePath([0, 500, 1000, 500]), widthUm: 300, cap: "butt", join: "miter" }, 0, 0);
    const passes = b.build().passes;
    const geoms = passes.map((p) => {
      if (p.kind !== "stroke") throw new Error("expected stroke");
      return strokeGeometry(p, 5);
    });
    const merged = mergeStrokes(geoms, 3);
    expect(merged.passes).toBe(2);
    expect(merged.verts.length).toBe((geoms[0].verts.length + geoms[1].verts.length) / 4 * 5);
    const widths = new Set<number>();
    for (let i = 4; i < merged.verts.length; i += 5) widths.add(merged.verts[i]);
    expect(widths).toEqual(new Set([50, 150]));
    // The first vertex's position/offset survive untouched.
    expect(Array.from(merged.verts.slice(0, 4))).toEqual(Array.from(geoms[0].verts.slice(0, 4)));
  });
});

describe("buildBatches", () => {
  it("merges same-kind passes inside a colour run and keeps colour order", () => {
    const b = new PassStreamBuilder();
    const area = (x: number) => makePath(square(x, 0, 1000), undefined, true);
    const gid = b.glyphTable.length;
    b.glyphTable.push({ glyphId: gid, partIdx: 0, fills: [circlePath(0, 0, 200)], strokes: [] });
    const gid2 = b.glyphTable.length;
    b.glyphTable.push({ glyphId: gid2, partIdx: 0, fills: [], strokes: [{ path: makePath([-200, 0, 200, 0]), widthUm: 50, cap: "butt", join: "miter" }] });
    // colour 1: three fills, two strokes → 1 fill batch + 1 stroke batch
    b.push({ kind: "fill", colour: 1, path: area(0), rule: "evenodd" }, 0, 0);
    b.push({ kind: "fill", colour: 1, path: area(2000), rule: "evenodd" }, 0, 0);
    b.push({ kind: "fill", colour: 1, path: area(4000), rule: "evenodd" }, 0, 0);
    b.push({ kind: "stroke", colour: 1, path: makePath([0, 0, 1000, 1000]), widthUm: 140, cap: "butt", join: "miter" }, 1, 1);
    b.push({ kind: "stroke", colour: 1, path: makePath([0, 1000, 1000, 0]), widthUm: 140, cap: "butt", join: "miter" }, 1, 1);
    // colour 2: hatches stay one per pass
    b.push({ kind: "hatch", colour: 2, path: area(0), widthUm: 100, spacingUm: 500, offsetUm: 0, angleDeg: 0 }, 2, 2);
    b.push({ kind: "hatch", colour: 2, path: area(2000), widthUm: 100, spacingUm: 500, offsetUm: 0, angleDeg: 90 }, 2, 2);
    // colour 3: glyph instances merge per mesh identity
    b.push({ kind: "glyph", colour: 3, glyphId: gid, partIdx: 0, instances: Float32Array.from([100, 100, 1, 0, 1]) }, 3, 3);
    b.push({ kind: "glyph", colour: 3, glyphId: gid, partIdx: 0, instances: Float32Array.from([900, 900, 1, 0, 1, 500, 500, 0, 1, 2]) }, 3, 3);
    b.push({ kind: "glyph", colour: 3, glyphId: gid2, partIdx: 0, instances: Float32Array.from([0, 0, 1, 0, 1]) }, 3, 3);
    // pushed last, but `build()` sorts canonically so it joins the colour-1 fill run
    b.push({ kind: "fill", colour: 1, path: area(6000), rule: "evenodd" }, 4, 4);

    const prepared = prepareStream(b.build());
    expect(prepared.items).toHaveLength(11);
    const { batches, stats } = buildBatches(prepared);

    expect(batches.map((x) => `${x.colour}:${x.kind}`)).toEqual(["1:fill", "1:stroke", "2:hatch", "2:hatch", "3:instanced", "3:instanced"]);
    expect(batches.map((x) => x.passes)).toEqual([4, 2, 1, 1, 2, 1]);
    const inst = batches[4];
    if (inst.kind !== "instanced") throw new Error("expected instanced");
    expect(inst.instances.length).toBe(15);
    expect(Array.from(inst.instances.slice(0, 5))).toEqual([100, 100, 1, 0, 1]);
    expect(inst.fill).toBeDefined();
    const inst2 = batches[5];
    if (inst2.kind !== "instanced") throw new Error("expected instanced");
    expect(inst2.strokes).toHaveLength(1);

    expect(stats.batches).toBe(6);
    expect(stats.passes).toBe(11);
    expect(stats.fillTriangles).toBe(4 * 2);
    expect(stats.instances).toBe(4);
    expect(stats.strokeTriangles).toBeGreaterThan(0);
    expect(stats.bytes).toBeGreaterThan(0);
  });

  it("keeps pattern-clipped instanced items in their own batch", () => {
    const b = new PassStreamBuilder();
    const gid = b.glyphTable.length;
    b.glyphTable.push({ glyphId: gid, partIdx: 0, fills: [circlePath(0, 0, 200)], strokes: [] });
    const clip = makePath(square(0, 0, 5000), undefined, true);
    b.push({ kind: "glyph", colour: 0, glyphId: gid, partIdx: 0, instances: Float32Array.from([100, 100, 1, 0, 1]), clip }, 0, 0);
    b.push({ kind: "glyph", colour: 0, glyphId: gid, partIdx: 0, instances: Float32Array.from([200, 200, 1, 0, 1]), clip }, 0, 0);
    b.push({ kind: "glyph", colour: 0, glyphId: gid, partIdx: 0, instances: Float32Array.from([300, 300, 1, 0, 1]) }, 0, 0);
    const { batches } = buildBatches(prepareStream(b.build()));
    expect(batches).toHaveLength(3);
    expect(batches.filter((x) => x.kind === "instanced" && x.clip)).toHaveLength(2);
    expect(batches.map((x) => x.passes)).toEqual([1, 1, 1]);
  });

  it("returns nothing for an empty stream", () => {
    const { batches, stats } = buildBatches(prepareStream(new PassStreamBuilder().build()));
    expect(batches).toEqual([]);
    expect(stats).toEqual({ batches: 0, passes: 0, fillTriangles: 0, strokeTriangles: 0, instances: 0, bytes: 0 });
  });
});
