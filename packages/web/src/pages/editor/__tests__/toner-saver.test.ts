import { describe, expect, it } from "vitest";
import { sampleSegment, type Vertex } from "../../../lib/editor/geometry-edit";
import { convexHull, tonerSaverGeometry } from "../tools/toner-saver";
import { pointInPolygon } from "../tools/polygon";

type Pt = { x: number; y: number };

/** The closed outline, every curved segment sampled finely. */
function outline(g: readonly Vertex[]): Pt[] {
  const out: Pt[] = [{ x: g[0].x, y: g[0].y }];
  for (let i = 1; i <= g.length; i++) out.push(...sampleSegment(g[i - 1], g[i % g.length], 200));
  return out;
}
const distToRing = (p: Pt, ring: Pt[]) =>
  Math.min(...ring.map((a, i) => {
    const b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
  }));
/** The handle factor of a quarter arc, (4/3)·tan(θ/4) with θ = 90° (shared/src/course/arcs.ts). */
const K90 = (4 / 3) * Math.tan(Math.PI / 8);

describe("convexHull", () => {
  it("drops interior and collinear points", () => {
    const h = convexHull([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 5, y: 5 }]);
    expect(h).toHaveLength(4);
  });
});

describe("tonerSaverGeometry", () => {
  it("is null without a site", () => {
    expect(tonerSaverGeometry([], 25)).toBeNull();
  });

  it("keeps every site at least the margin inside the sampled outline, and the hull sites exactly the margin from it", () => {
    const sites = [{ x: 0, y: 0 }, { x: 80, y: 20 }, { x: 40, y: 70 }, { x: 45, y: 30 }];
    const g = tonerSaverGeometry(sites, 25)!;
    const ring = outline(g);
    for (const s of sites) {
      expect(pointInPolygon(s, ring)).toBe(true);
      expect(distToRing(s, ring)).toBeGreaterThanOrEqual(25 - 2e-3);
    }
    for (const s of sites.slice(0, 3)) expect(distToRing(s, ring)).toBeLessThan(25 + 0.05);
  });

  it("has Bézier handles and is tangent-continuous at every vertex", () => {
    const g = tonerSaverGeometry([{ x: 0, y: 0 }, { x: 80, y: 20 }, { x: 40, y: 70 }], 25)!;
    expect(g.some((v) => v.hOut)).toBe(true);
    for (const v of g) {
      if (!v.hIn || !v.hOut) continue;
      // Collinear and opposite: a smooth vertex.
      expect(Math.abs(v.hIn.x * v.hOut.y - v.hIn.y * v.hOut.x)).toBeLessThan(1e-2);
      expect(v.hIn.x * v.hOut.x + v.hIn.y * v.hOut.y).toBeLessThan(0);
    }
    // A straight offset edge leaves an arc along the arc's end tangent, and enters the next along its start tangent.
    g.forEach((v, i) => {
      const next = g[(i + 1) % g.length];
      if (v.hOut || next.hIn) return; // a curved segment
      const e = { x: next.x - v.x, y: next.y - v.y };
      const l = Math.hypot(e.x, e.y);
      expect(v.hIn).toBeDefined();
      expect(next.hOut).toBeDefined();
      expect(Math.abs(e.x * v.hIn!.y - e.y * v.hIn!.x) / l).toBeLessThan(1e-1);
      expect(Math.abs(e.x * next.hOut!.y - e.y * next.hOut!.x) / l).toBeLessThan(1e-1);
      // Moving forward: the handle into the edge's start points along it, not against it.
      expect(e.x * -v.hIn!.x + e.y * -v.hIn!.y).toBeGreaterThan(0);
    });
  });

  it("one site: four quarter arcs of radius = margin, handle (4/3)·tan(θ/4)·r", () => {
    const g = tonerSaverGeometry([{ x: 10, y: 20 }], 25)!;
    expect(g).toHaveLength(4);
    for (const v of g) {
      expect(Math.hypot(v.x - 10, v.y - 20)).toBeCloseTo(25, 2);
      expect(Math.hypot(v.hOut!.x, v.hOut!.y)).toBeCloseTo(K90 * 25, 2);
      expect(Math.hypot(v.hIn!.x, v.hIn!.y)).toBeCloseTo(K90 * 25, 2);
    }
  });

  it("two sites: a stadium, two straight edges between four quarter arcs", () => {
    const g = tonerSaverGeometry([{ x: 0, y: 0 }, { x: 100, y: 0 }], 25)!;
    expect(g).toHaveLength(6);
    const straight = g.filter((v, i) => !v.hOut && !g[(i + 1) % g.length].hIn);
    expect(straight).toHaveLength(2);
    const ring = outline(g);
    expect(Math.min(...ring.map((p) => p.y))).toBeCloseTo(-25, 1);
    expect(Math.max(...ring.map((p) => p.y))).toBeCloseTo(25, 1);
    expect(Math.min(...ring.map((p) => p.x))).toBeCloseTo(-25, 1);
    expect(Math.max(...ring.map((p) => p.x))).toBeCloseTo(125, 1);
  });

  it("collinear sites are a stadium over the extremes; duplicate sites are one site", () => {
    const col = tonerSaverGeometry([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }], 25)!;
    expect(col).toHaveLength(6);
    expect(tonerSaverGeometry([{ x: 5, y: 5 }, { x: 5, y: 5 }], 25)).toHaveLength(4);
  });

  it("one cubic per ≤ 90° of turn: a square's corners are one piece each, a sharp corner is split", () => {
    const g = tonerSaverGeometry([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 0, y: 50 }], 25)!;
    expect(g).toHaveLength(8);
    for (const v of g) for (const h of [v.hIn, v.hOut]) if (h) expect(Math.hypot(h.x, h.y)).toBeCloseTo(K90 * 25, 2);
    // A sharp triangle corner turns ~177°: two pieces (three vertices).
    const t = tonerSaverGeometry([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 5 }], 25)!;
    expect(t.filter((v) => v.hIn && v.hOut).length).toBeGreaterThanOrEqual(1);
  });

  it("rounds to micrometres", () => {
    const g = tonerSaverGeometry([{ x: 0.1234567, y: 0.7654321 }, { x: 33.3333333, y: 12.121212 }, { x: 7, y: 41 }], 25)!;
    const isUm = (n: number) => Math.abs(n * 1000 - Math.round(n * 1000)) < 1e-9;
    for (const v of g) for (const n of [v.x, v.y, v.hIn?.x ?? 0, v.hIn?.y ?? 0, v.hOut?.x ?? 0, v.hOut?.y ?? 0]) expect(isUm(n)).toBe(true);
  });
});
