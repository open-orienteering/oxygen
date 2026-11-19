import { describe, expect, it } from "vitest";
import { OUTLINE_MAX_VERTICES, traceOutline } from "../trace-outline.js";

/** A `w × h` alpha raster, 255 where `inside(x, y)` (pixel centres). */
function raster(w: number, h: number, inside: (x: number, y: number) => boolean): Uint8Array {
  const a = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (inside(x + 0.5, y + 0.5)) a[y * w + x] = 255;
  return a;
}
const area = (r: readonly number[]) => {
  let s = 0;
  for (let i = 0; i < r.length / 2; i++) {
    const j = (i + 1) % (r.length / 2);
    s += r[2 * i] * r[2 * j + 1] - r[2 * j] * r[2 * i + 1];
  }
  return Math.abs(s / 2);
};

describe("traceOutline (J19, docs/map-rendering.md §4.11)", () => {
  it("a centred square traces to its four corners, in fractions of the graphic", () => {
    const rings = traceOutline(raster(40, 20, (x, y) => x > 10 && x < 30 && y > 5 && y < 15), 40, 20);
    expect(rings).toHaveLength(1);
    const xs = rings[0].filter((_, i) => i % 2 === 0), ys = rings[0].filter((_, i) => i % 2 === 1);
    expect(rings[0]).toHaveLength(8);
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([0.25, 0.75, 0.25, 0.75]);
  });

  it("a disc keeps its area within 2 % and at most the vertex cap", () => {
    const n = 200, r = 80;
    const rings = traceOutline(raster(n, n, (x, y) => (x - 100) ** 2 + (y - 100) ** 2 < r * r), n, n);
    expect(rings).toHaveLength(1);
    expect(rings[0].length / 2).toBeLessThanOrEqual(OUTLINE_MAX_VERTICES);
    expect(area(rings[0]) * n * n).toBeGreaterThan(Math.PI * r * r * 0.98);
    expect(area(rings[0]) * n * n).toBeLessThan(Math.PI * r * r * 1.02);
  });

  it("holes are filled: a ring traces as its outer edge only", () => {
    const rings = traceOutline(raster(60, 60, (x, y) => { const d = Math.hypot(x - 30, y - 30); return d < 25 && d > 15; }), 60, 60);
    expect(rings).toHaveLength(1);
    expect(area(rings[0]) * 3600).toBeGreaterThan(Math.PI * 25 * 25 * 0.95);
  });

  it("separate shapes trace separately, largest first; diagonal neighbours make closed rings", () => {
    const rings = traceOutline(raster(50, 20, (x, y) => (x < 20 && y < 20 && x > 2 && y > 2) || (x > 30 && x < 40 && y > 5 && y < 15)), 50, 20);
    expect(rings).toHaveLength(2);
    expect(area(rings[0])).toBeGreaterThan(area(rings[1]));
    const checker = traceOutline(raster(4, 4, (x, y) => (Math.floor(x) + Math.floor(y)) % 2 === 0 && x < 2 && y < 2), 4, 4);
    expect(checker.length).toBeGreaterThan(0);
    for (const r of checker) expect(r.length % 2).toBe(0);
  });

  it("a full or empty raster is the box ([]); the threshold is 50 % alpha", () => {
    expect(traceOutline(new Uint8Array(100).fill(255), 10, 10)).toEqual([]);
    expect(traceOutline(new Uint8Array(100), 10, 10)).toEqual([]);
    const soft = raster(20, 20, (x, y) => x > 5 && x < 15 && y > 5 && y < 15).map((v) => (v ? 127 : 0));
    expect(traceOutline(soft, 20, 20)).toEqual([]);
    expect(traceOutline(soft.map((v) => (v ? 128 : 0)), 20, 20)).toHaveLength(1);
  });
});
