import { describe, it, expect } from "vitest";
import { render } from "@oxygen/shared";
import { extrudePolyline, fanFromRings, fanGeometry, prepareStream, strokeGeometry, strokePolylines } from "../prepare";

const { makePath, PassStreamBuilder, circlePath } = render;

/** Signed area of the triangles in a (x,y)*3 list — zero means a degenerate fan. */
function triangleAreaSum(tri: Float32Array): number {
  let s = 0;
  for (let i = 0; i < tri.length; i += 6) {
    s += Math.abs((tri[i + 2] - tri[i]) * (tri[i + 5] - tri[i + 1]) - (tri[i + 4] - tri[i]) * (tri[i + 3] - tri[i + 1])) / 2;
  }
  return s;
}

/** Even-odd point test against fan triangles: inside iff an odd number of triangles cover the point. */
function fanCovers(fan: Float32Array, x: number, y: number): boolean {
  let n = 0;
  for (let i = 0; i < fan.length; i += 6) {
    const [ax, ay, bx, by, cx, cy] = [fan[i], fan[i + 1], fan[i + 2], fan[i + 3], fan[i + 4], fan[i + 5]];
    const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by);
    const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy);
    const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
    const neg = d1 < 0 || d2 < 0 || d3 < 0;
    const pos = d1 > 0 || d2 > 0 || d3 > 0;
    if (!(neg && pos)) n++;
  }
  return n % 2 === 1;
}

describe("fan geometry (stencil even-odd fills)", () => {
  it("emits one triangle per ring edge from an origin outside the bounds", () => {
    const square = makePath([0, 0, 1000, 0, 1000, 1000, 0, 1000], undefined, true);
    const g = fanGeometry(square, 5);
    expect(g.fan.length).toBe(4 * 6);
    expect(g.fan[0]).toBeLessThan(0);
    expect(g.fan[1]).toBeLessThan(0);
    expect(Array.from(g.cover)).toEqual([0, 0, 1000, 0, 1000, 1000, 0, 0, 1000, 1000, 0, 1000]);
  });

  it("parity of the fan reproduces even-odd with holes", () => {
    const outer = [0, 0, 1000, 0, 1000, 1000, 0, 1000];
    const hole = [250, 250, 750, 250, 750, 750, 250, 750];
    const { fan } = fanFromRings([outer, hole]);
    // (Probe points off the fan origin's diagonal, where a triangle edge would be hit exactly.)
    expect(fanCovers(fan, 100, 300)).toBe(true);
    expect(fanCovers(fan, 400, 600)).toBe(false);
    expect(fanCovers(fan, 1100, 500)).toBe(false);
  });

  it("flattens Béziers to the tolerance", () => {
    const coarse = fanGeometry(circlePath(0, 0, 1000), 50);
    const fine = fanGeometry(circlePath(0, 0, 1000), 2);
    expect(fine.fan.length).toBeGreaterThan(coarse.fan.length);
    // Area of the flattened disc approaches πr².
    const area = (g: ReturnType<typeof fanGeometry>) => {
      let s = 0;
      for (let i = 0; i < g.fan.length; i += 6) {
        s += ((g.fan[i + 2] - g.fan[i]) * (g.fan[i + 5] - g.fan[i + 1]) - (g.fan[i + 4] - g.fan[i]) * (g.fan[i + 3] - g.fan[i + 1])) / 2;
      }
      return Math.abs(s);
    };
    const exact = Math.PI * 1e6;
    expect(Math.abs(area(fine) - exact) / exact).toBeLessThan(1e-3);
    expect(Math.abs(area(coarse) - exact)).toBeGreaterThan(Math.abs(area(fine) - exact));
  });

  it("returns empty geometry for degenerate paths", () => {
    expect(fanGeometry(makePath([5, 5]), 5).fan.length).toBe(0);
  });
});

describe("stroke extrusion", () => {
  it("a straight segment becomes two triangles with unit normal offsets", () => {
    const out: number[] = [];
    extrudePolyline([0, 0, 1000, 0], false, "butt", "miter", out);
    expect(out.length).toBe(6 * 4);
    // Offsets are ±(0,1): left normal of +x.
    const offsets = new Set<string>();
    for (let i = 0; i < out.length; i += 4) offsets.add(`${out[i + 2]},${out[i + 3]}`);
    expect(offsets).toEqual(new Set(["0,1", "0,-1"]));
  });

  it("square caps extend the quad by one half width along the tangent", () => {
    const out: number[] = [];
    extrudePolyline([0, 0, 1000, 0], false, "square", "miter", out);
    const xs = new Set<number>();
    for (let i = 0; i < out.length; i += 4) xs.add(out[i + 2]);
    expect(xs).toEqual(new Set([-1, 1]));
  });

  it("round caps add a half-circle fan at each open end", () => {
    const flat: number[] = [];
    const round: number[] = [];
    extrudePolyline([0, 0, 1000, 0], false, "butt", "miter", flat);
    extrudePolyline([0, 0, 1000, 0], false, "round", "miter", round);
    const extra = (round.length - flat.length) / 4 / 3; // triangles added
    expect(extra).toBe(16); // ROUND_STEPS_PER_PI × 2 ends
    // Every cap offset has unit length.
    for (let i = flat.length; i < round.length; i += 4) {
      const l = Math.hypot(round[i + 2], round[i + 3]);
      expect(l === 0 || Math.abs(l - 1) < 1e-6).toBe(true);
    }
  });

  it("mitre joins add a wedge on the outer side; sharp angles fall back to bevel", () => {
    const right: number[] = [];
    extrudePolyline([0, 0, 1000, 0, 1000, 1000], false, "butt", "miter", right);
    expect((right.length / 4 - 12) / 3).toBe(2); // two wedge triangles
    const mitreLen = Math.max(...Array.from({ length: right.length / 4 }, (_, i) => Math.hypot(right[4 * i + 2], right[4 * i + 3])));
    expect(mitreLen).toBeCloseTo(Math.SQRT2, 6);

    const sharp: number[] = [];
    extrudePolyline([0, 0, 1000, 0, 0, 100], false, "butt", "miter", sharp);
    expect((sharp.length / 4 - 12) / 3).toBe(1); // bevel: one triangle
  });

  it("round joins subdivide proportionally to the turn angle", () => {
    const out: number[] = [];
    extrudePolyline([0, 0, 1000, 0, 1000, 1000], false, "butt", "round", out);
    expect((out.length / 4 - 12) / 3).toBe(4); // 90° = half of ROUND_STEPS_PER_PI
  });

  it("closed polylines join at every vertex and have no caps", () => {
    const out: number[] = [];
    extrudePolyline([0, 0, 1000, 0, 1000, 1000, 0, 1000], true, "round", "miter", out);
    expect(out.length / 4).toBe(4 * 6 + 4 * 6); // 4 quads + 4 mitre wedges of two triangles
  });

  it("drops duplicate points and tolerates degenerate input", () => {
    const out: number[] = [];
    extrudePolyline([0, 0, 0, 0, 1000, 0, 1000, 0], false, "butt", "miter", out);
    expect(out.length).toBe(24);
    const dot: number[] = [];
    extrudePolyline([5, 5], false, "round", "miter", dot);
    expect(dot.length).toBe(16 * 3 * 4); // a full round dot
    const none: number[] = [];
    extrudePolyline([5, 5], false, "butt", "miter", none);
    expect(none.length).toBe(0);
  });

  it("slices are flattened from their Bézier sub-ranges, not from the whole path", () => {
    const b = new PassStreamBuilder();
    const path = makePath([0, 0, 3000, 4000, 6000, -4000, 9000, 0], [0, 1, 2, 0]);
    b.push({ kind: "stroke", colour: 0, path, widthUm: 100, cap: "butt", join: "miter", slices: [{ seg0: 0, t0: 0.25, seg1: 0, t1: 0.5 }] }, 0, 0);
    const pass = b.build().passes[0];
    if (pass.kind !== "stroke") throw new Error("expected stroke");
    const polys = strokePolylines(pass, 5);
    expect(polys).toHaveLength(1);
    const pts = polys[0].pts;
    expect(pts[0]).toBeGreaterThan(0);
    expect(pts[pts.length - 2]).toBeLessThan(9000);
    const geom = strokeGeometry(pass, 5);
    expect(geom.halfWidth).toBe(50);
    expect(triangleAreaSum(geom.verts.filter((_, i) => i % 4 < 2))).toBe(0); // offsets carry the width, positions are on the centre line
  });
});

describe("prepareStream", () => {
  it("keeps stream order and maps every pass kind", () => {
    const b = new PassStreamBuilder();
    const area = makePath([0, 0, 5000, 0, 5000, 5000, 0, 5000], undefined, true);
    const gid = b.glyphTable.length;
    b.glyphTable.push({ glyphId: gid, partIdx: 0, fills: [circlePath(0, 0, 200)], strokes: [] });
    b.push({ kind: "fill", colour: 1, path: area, rule: "evenodd" }, 0, 0);
    b.push({ kind: "hatch", colour: 2, path: area, widthUm: 100, spacingUm: 500, offsetUm: 0, angleDeg: 45 }, 0, 0);
    b.push({ kind: "stroke", colour: 3, path: makePath([0, 0, 5000, 5000]), widthUm: 140, cap: "round", join: "round" }, 1, 1);
    b.push({ kind: "glyph", colour: 4, glyphId: gid, partIdx: 0, instances: Float32Array.from([1000, 1000, 1, 0, 1, 2000, 2000, 0, 1, 1.5]) }, 2, 2);
    b.push({ kind: "glyph", colour: 4, glyphId: 99, partIdx: 0, instances: Float32Array.from([0, 0, 1, 0, 1]) }, 2, 2); // unknown mesh → skipped
    const prepared = prepareStream(b.build());
    expect(prepared.items.map((i) => i.kind)).toEqual(["fill", "hatch", "stroke", "instanced"]);
    const inst = prepared.items[3];
    if (inst.kind !== "instanced") throw new Error("expected instanced");
    expect(inst.instances.length).toBe(10);
    expect(inst.fill?.fan.length).toBeGreaterThan(0);
    expect(inst.strokes).toEqual([]);
    expect(prepared.bounds).toEqual({ minX: 0, minY: 0, maxX: 5000, maxY: 5000 });
  });

  it("skips text passes whose font is not supplied", () => {
    const b = new PassStreamBuilder();
    const fontId = b.fontTable.length;
    b.fontTable.push({ fontId, family: "liberation-sans", bold: false, italic: false });
    b.push({ kind: "text", colour: 0, fontId, sizeUm: 3000, glyphs: Uint16Array.from([1]), positions: Float32Array.from([0, 0]) }, 0, 0);
    expect(prepareStream(b.build()).items).toEqual([]);
  });
});

describe("filter masks (map-rendering §3.8)", () => {
  it("every item of a masked pass carries one fan per region, shared between passes of one mask", () => {
    const region = makePath([0, 0, 1000, 0, 1000, 1000], undefined, true);
    const b = new PassStreamBuilder()
      .push({ kind: "stroke", colour: 1, path: makePath([0, 0, 5000, 0]), widthUm: 100, cap: "butt", join: "miter" }, 0, 0)
      .push({ kind: "fill", colour: 2, path: makePath([0, 0, 10, 0, 10, 10], undefined, true), rule: "evenodd" }, 1, 1)
      .push({ kind: "stroke", colour: 3, path: makePath([0, 0, 0, 5000]), widthUm: 100, cap: "butt", join: "miter" }, 2, 2);
    const stream = { ...b.build(), masks: [{ regions: [region, region] }], maskIdx: Int32Array.from([0, -1, 0]) };
    const { items } = prepareStream(stream);
    expect(items.map((i) => i.mask?.length ?? 0)).toEqual([2, 0, 2]);
    expect(items[0].mask).toBe(items[2].mask);
    expect(fanCovers(items[0].mask![0].fan, 700, 200)).toBe(true);
    expect(fanCovers(items[0].mask![0].fan, 200, 700)).toBe(false);
  });
});
