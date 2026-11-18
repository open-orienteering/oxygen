/**
 * J6 (docs/map-rendering.md §5.2 "Images"): an image pass's bounds are its quad's, it is in the
 * base layer, and it is prepared as an alpha item at opacity 1 when opaque — drawn as its own
 * step after its colour's opaque draws, hidden with its object, under its object's mask.
 */
import { describe, expect, it } from "vitest";
import { render } from "@oxygen/shared";
import { buildVisibleSet, filterEntryKey, passBounds, prepareBucketPart, sourcesHaveLayer, type PrepareContext } from "../buckets";
import { MeshAtlasBuilder } from "../mesh-atlas";

const { makePath, PassStreamBuilder } = render;
const square = (x: number, s: number) => makePath([x, 0, x + s, 0, x + s, s, x, s], undefined, true);
const fill = (colour: number): render.FillPass => ({ kind: "fill", colour, path: square(0, 1000), rule: "evenodd" });
const image = (extra: Partial<render.ImagePass> = {}): render.ImagePass => ({ kind: "image", colour: 2, graphicId: 7, quad: [2000, 0, 0, 1000, 500, 300], ...extra });
const ctx = (originX = 0, originY = 0): PrepareContext => ({ toleranceUm: 10, originX, originY, meshes: new MeshAtlasBuilder().build().meshes, glyphMesh: new Map(), textGlyph: new Map() });
function build(passes: [render.Pass, number][]): render.PassStream {
  const b = new PassStreamBuilder();
  for (const [p, o] of passes) b.push(p, o, 0);
  return b.build();
}
const all = (s: render.PassStream) => s.passes.map((_, i) => i);

describe("image passes on the arena path (J6)", () => {
  it("bounds: a turned quad's corners", () => {
    const r = Math.SQRT1_2 * 1000;
    expect(passBounds(image({ quad: [r, -r, r, r, 0, 0] }), () => 0)).toEqual({ minX: 0, minY: -r, maxX: 2 * r, maxY: r });
  });

  it("is base: drawn below the zoom gate", () => {
    const s = build([[image(), 0]]);
    expect(sourcesHaveLayer([{ stream: s, passes: [0], glyphMesh: new Map(), textGlyph: new Map() }], "base")).toBe(true);
    expect(sourcesHaveLayer([{ stream: s, passes: [0], glyphMesh: new Map(), textGlyph: new Map() }], "detail")).toBe(false);
  });

  it("an opaque image is an alpha item at opacity 1, origin-relative, with its crop and placed size; alpha carried", () => {
    const s = build([[image({ crop: { x: 0.25, y: 0, width: 0.5, height: 1 } }), 0], [image({ graphicId: 8, opacity: 0.5, blend: "multiply" }), 1]]);
    const part = prepareBucketPart(s, 0, all(s), "all", ctx(100, 200));
    expect(part.alpha).toEqual([
      { kind: "image", colour: 2, object: 0, source: 0, pass: 0, opacity: 1, multiply: false, image: { graphicId: 7, quad: [2000, 0, 0, 1000, 400, 100], crop: [0.25, 0, 0.5, 1], sizeUm: [2000, 1000] } },
      { kind: "image", colour: 2, object: 1, source: 0, pass: 1, opacity: 0.5, multiply: true, image: { graphicId: 8, quad: [2000, 0, 0, 1000, 400, 100], crop: [0, 0, 1, 1], sizeUm: [2000, 1000] } },
    ]);
    expect(part.fill).toBeUndefined();
  });

  it("drawn after its colour's opaque steps, before the next colour; hidden with its object; under its object's mask", () => {
    const s = build([[fill(1), 0], [fill(2), 1], [image(), 2], [fill(3), 3]]);
    const part = prepareBucketPart(s, 0, all(s), "all", ctx());
    const res = [{ part, base: { fill: 0, hatch: 0, stroke: 0 } }];
    const vs = buildVisibleSet(res);
    expect(vs.layers.map((l) => [l.colour, l.alpha ?? null])).toEqual([[1, null], [2, null], [2, 0], [3, null]]);
    expect(vs.alpha![0]).toMatchObject({ kind: "image", colour: 2, mask: -1, opacity: 1, image: { graphicId: 7 } });
    expect(buildVisibleSet(res, new Set([2])).alpha).toBeUndefined();
    const filter = { entryMask: new Map([[filterEntryKey(2, 2), 0]]), positions: new Float32Array(6), indices: new Uint32Array([0, 1, 2]), masks: [{ offset: 0, count: 3 }] };
    expect(buildVisibleSet(res, undefined, filter).alpha![0].mask).toBe(0);
  });
});
