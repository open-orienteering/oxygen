import { describe, it, expect } from "vitest";
import { render } from "@oxygen/shared";
import { extrudePolyline, extrudeStrip, JOIN_SHARE_TOLERANCE, StripGeometry, strokeGeometry, strokeStrip, triangulateEvenOdd } from "../prepare";

const { makePath, PassStreamBuilder } = render;

/** Triangles of the S1 triangle list (x, y, ox, oy per vertex) scaled by a half width. */
function listTriangles(verts: number[], hw: number): number[] {
  const t: number[] = [];
  for (let i = 0; i < verts.length; i += 4) t.push(verts[i] + verts[i + 2] * hw, verts[i + 1] + verts[i + 3] * hw);
  return t;
}

/** Triangles of an indexed strip scaled by a half width. */
function stripTriangles(g: StripGeometry, hw: number): number[] {
  const t: number[] = [];
  for (const i of g.indices) t.push(g.verts[4 * i] + g.verts[4 * i + 2] * hw, g.verts[4 * i + 1] + g.verts[4 * i + 3] * hw);
  return t;
}

function covered(tri: number[], x: number, y: number): boolean {
  for (let i = 0; i < tri.length; i += 6) {
    const [ax, ay, bx, by, cx, cy] = [tri[i], tri[i + 1], tri[i + 2], tri[i + 3], tri[i + 4], tri[i + 5]];
    const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by);
    const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy);
    const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
    const neg = d1 < 0 || d2 < 0 || d3 < 0;
    const pos = d1 > 0 || d2 > 0 || d3 > 0;
    if (!(neg && pos)) return true;
  }
  return false;
}

/**
 * Coverage of the strip equals coverage of the S1 triangle list at every
 * sample whose neighbourhood (± δ) is uniformly in or out of the S1 shape:
 * the two may only differ within δ of an edge.
 */
function expectSameCoverage(a: number[], b: number[], hw: number, delta: number): void {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < a.length; i += 2) {
    minX = Math.min(minX, a[i]); maxX = Math.max(maxX, a[i]);
    minY = Math.min(minY, a[i + 1]); maxY = Math.max(maxY, a[i + 1]);
  }
  minX -= hw; minY -= hw; maxX += hw; maxY += hw;
  const N = 70;
  let checked = 0;
  for (let iy = 0; iy <= N; iy++) {
    for (let ix = 0; ix <= N; ix++) {
      const x = minX + ((maxX - minX) * (ix + 0.37)) / N;
      const y = minY + ((maxY - minY) * (iy + 0.61)) / N;
      const ca = covered(a, x, y);
      let uniform = true;
      for (const [dx, dy] of [[delta, 0], [-delta, 0], [0, delta], [0, -delta], [delta, delta], [-delta, -delta], [delta, -delta], [-delta, delta]]) {
        if (covered(a, x + dx, y + dy) !== ca) { uniform = false; break; }
      }
      if (!uniform) continue;
      checked++;
      if (covered(b, x, y) !== ca) throw new Error(`coverage differs at (${x.toFixed(1)}, ${y.toFixed(1)}): S1 ${ca}`);
    }
  }
  expect(checked).toBeGreaterThan(N * N * 0.5);
}

/** A zigzag with shallow (flattened-curve-like) bends and one sharp corner. */
const zigzag = [0, 0, 400, 0, 800, 30, 1200, 90, 1400, 700, 1500, 0, 2400, 0];
const caps: render.StrokeCap[] = ["butt", "round", "square"];
const joins: render.StrokeJoin[] = ["miter", "round", "bevel"];

describe("extrudeStrip (indexed strokes, S1 §4.1)", () => {
  for (const cap of caps) {
    for (const join of joins) {
      for (const closed of [false, true]) {
        it(`covers what the S1 triangle list covers: cap ${cap}, join ${join}, ${closed ? "closed" : "open"}`, () => {
          const hw = 60;
          const old: number[] = [];
          extrudePolyline(zigzag, closed, cap, join, old);
          const strip = new StripGeometry();
          extrudeStrip(zigzag, closed, cap, join, hw, strip);
          for (const i of strip.indices) expect(i).toBeLessThan(strip.verts.length / 4);
          expect(strip.indices.length % 3).toBe(0);
          expectSameCoverage(listTriangles(old, hw), stripTriangles(strip, hw), hw, hw * (JOIN_SHARE_TOLERANCE + 0.02));
        });
      }
    }
  }

  it("a straight polyline is two vertices per point and two triangles per segment", () => {
    const pts = [0, 0, 100, 0, 200, 0, 300, 0, 400, 0];
    const g = new StripGeometry();
    extrudeStrip(pts, false, "butt", "round", 50, g);
    expect(g.verts.length / 4).toBe(2 * 5);
    expect(g.indices.length).toBe(6 * 4);
    // The S1 list needs six vertices per segment.
    const old: number[] = [];
    extrudePolyline(pts, false, "butt", "round", old);
    expect(old.length / 4).toBe(6 * 4);
  });

  it("shares the pair on a flattened arc but not at a real corner", () => {
    // 32-gon arc: 5.6° turns → round join within 1 % of the half width.
    const arc: number[] = [];
    for (let k = 0; k <= 16; k++) arc.push(10_000 * Math.cos((k * Math.PI) / 32), 10_000 * Math.sin((k * Math.PI) / 32));
    const g = new StripGeometry();
    extrudeStrip(arc, false, "butt", "round", 70, g);
    expect(g.verts.length / 4).toBe(2 * 17);
    const corner = new StripGeometry();
    extrudeStrip([0, 0, 1000, 0, 1000, 1000], false, "butt", "round", 70, corner);
    expect(corner.verts.length / 4).toBeGreaterThan(2 * 3);
  });

  it("keeps mitre offsets inside the 4× limit and falls back to a bevel past it", () => {
    const sharp = [0, 0, 1000, 0, 0, 50]; // ~177° turn
    const g = new StripGeometry();
    extrudeStrip(sharp, false, "butt", "miter", 30, g);
    for (let i = 0; i < g.verts.length; i += 4) expect(Math.hypot(g.verts[i + 2], g.verts[i + 3])).toBeLessThanOrEqual(4 + 1e-9);
    const right = new StripGeometry();
    extrudeStrip([0, 0, 1000, 0, 1000, 1000], false, "butt", "miter", 30, right);
    let maxOff = 0;
    for (let i = 0; i < right.verts.length; i += 4) maxOff = Math.max(maxOff, Math.hypot(right.verts[i + 2], right.verts[i + 3]));
    expect(maxOff).toBeCloseTo(Math.SQRT2, 9);
  });

  it("does not share a pair when the inner mitre would run past a short segment", () => {
    // A 90° mitre at a 10 µm segment with a 100 µm half width.
    const g = new StripGeometry();
    const pts = [0, 0, 1000, 0, 1000, 10, 2000, 10];
    extrudeStrip(pts, false, "butt", "miter", 100, g);
    expect(g.verts.length / 4).toBeGreaterThan(8);
    const old: number[] = [];
    extrudePolyline(pts, false, "butt", "miter", old);
    expectSameCoverage(listTriangles(old, 100), stripTriangles(g, 100), 100, 2);
  });

  it("a single point with a round cap is a dot; without one it is nothing", () => {
    const dot = new StripGeometry();
    extrudeStrip([5, 5], false, "round", "round", 10, dot);
    expect(dot.indices.length).toBeGreaterThan(0);
    const none = new StripGeometry();
    extrudeStrip([5, 5, 5, 5], false, "butt", "round", 10, none);
    expect(none.indices.length).toBe(0);
  });

  it("strokes each dash slice as its own strip with the pass's cap", () => {
    const b = new PassStreamBuilder();
    b.push({
      kind: "stroke", colour: 0, path: makePath([0, 0, 10_000, 0]), widthUm: 200, cap: "round", join: "round",
      slices: [{ seg0: 0, t0: 0, seg1: 0, t1: 0.3 }, { seg0: 0, t0: 0.5, seg1: 0, t1: 0.8 }],
    }, 0, 0);
    const pass = b.build().passes[0];
    if (pass.kind !== "stroke") throw new Error("expected stroke");
    const strip = strokeStrip(pass, 10) as StripGeometry;
    const old = strokeGeometry(pass, 10);
    expectSameCoverage(listTriangles(Array.from(old.verts), 100), stripTriangles(strip, 100), 100, 3);
    // Two dashes: two ribbons with two round caps each, nothing between them.
    expect(covered(stripTriangles(strip, 100), 4000, 0)).toBe(false);
    expect(covered(stripTriangles(strip, 100), 1500, 0)).toBe(true);
    expect(covered(stripTriangles(strip, 100), 6500, 0)).toBe(true);
  });

  it("stores ~3× fewer bytes than the S1 triangle list on a contour-like line", () => {
    const line: number[] = [];
    for (let k = 0; k < 200; k++) line.push(k * 100, Math.round(400 * Math.sin(k / 15)));
    const strip = new StripGeometry();
    extrudeStrip(line, false, "round", "round", 70, strip);
    const old: number[] = [];
    extrudePolyline(line, false, "round", "round", old);
    // GPU bytes: strip vertices 16 B each (indices live in the visible-set buffer); S1 20 B per list vertex.
    const ratio = (old.length / 4) * 20 / ((strip.verts.length / 4) * 16);
    expect(ratio).toBeGreaterThan(3);
  });
});

describe("triangulateEvenOdd", () => {
  const sq = (x: number, y: number, s: number) => [x, y, x + s, y, x + s, y + s, x, y + s];
  const area = (t: { positions: number[]; indices: number[] }) => {
    let s = 0;
    const p = t.positions;
    for (let i = 0; i < t.indices.length; i += 3) {
      const [a, b, c] = [2 * t.indices[i], 2 * t.indices[i + 1], 2 * t.indices[i + 2]];
      s += Math.abs((p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[c] - p[a]) * (p[b + 1] - p[a + 1])) / 2;
    }
    return s;
  };

  it("cuts holes regardless of ring order or winding", () => {
    const outer = sq(0, 0, 1000);
    const hole = sq(250, 250, 500).reverse();
    expect(area(triangulateEvenOdd([outer, hole]))).toBeCloseTo(750_000, 3);
    expect(area(triangulateEvenOdd([hole, outer]))).toBeCloseTo(750_000, 3);
  });

  it("fills a ring flagged as a hole that lies outside the outer ring (even-odd)", () => {
    expect(area(triangulateEvenOdd([sq(0, 0, 100), sq(500, 500, 100)]))).toBeCloseTo(20_000, 3);
  });

  it("handles nested islands: outer, hole, island in the hole", () => {
    expect(area(triangulateEvenOdd([sq(0, 0, 1000), sq(100, 100, 800), sq(300, 300, 400)]))).toBeCloseTo(1_000_000 - 640_000 + 160_000, 3);
  });

  it("returns nothing for degenerate rings", () => {
    expect(triangulateEvenOdd([[0, 0, 1, 1]]).indices.length).toBe(0);
  });
});
