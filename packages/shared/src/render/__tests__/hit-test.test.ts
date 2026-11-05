import { describe, it, expect } from "vitest";
import { hitTest } from "../hit-test.js";
import { PassStreamBuilder, makePath, type PassStream } from "../pass-stream.js";

/** Square ring path, µm, centred on (cx, cy). */
const square = (cx: number, cy: number, h: number, closed = true) =>
  makePath([cx - h, cy - h, cx + h, cy - h, cx + h, cy + h, cx - h, cy + h], undefined, closed);

function scene(): PassStream {
  const b = new PassStreamBuilder();
  // Object 0: a green area under everything (colour 0).
  b.push({ kind: "fill", colour: 0, path: square(0, 0, 10_000), rule: "evenodd" }, 0, 0);
  // Object 1: a black line along y = 0 (colour 2), 400 µm wide.
  b.push({ kind: "stroke", colour: 2, path: makePath([-8000, 0, 8000, 0]), widthUm: 400, cap: "butt", join: "miter" }, 1, 1);
  // Object 2: a purple ring (closed stroke) of half-size 2500 µm at (5000, 5000), on top (colour 3).
  b.push({ kind: "stroke", colour: 3, path: square(5000, 5000, 2500), widthUm: 350, cap: "butt", join: "miter" }, 2, 2);
  // Object 3: a point symbol, glyph radius 300 µm at (-5000, -5000).
  b.glyphTable.push({ glyphId: 7, partIdx: 0, fills: [square(0, 0, 300)], strokes: [] });
  b.push({ kind: "glyph", colour: 2, glyphId: 7, partIdx: 0, instances: Float32Array.from([-5000, -5000, 1, 0, 1]) }, 3, 3);
  // Object 4: a number "12" at (-5000, 5000), 4 mm em.
  b.push({ kind: "text", colour: 3, fontId: 0, sizeUm: 4000, glyphs: Uint16Array.from([1, 2]), positions: Float32Array.from([-5000, 5000, -3000, 5000]) }, 4, 4);
  return b.build();
}

describe("hitTest (04 §7; map-rendering.md §5.5)", () => {
  const s = scene();
  const ids = (x: number, y: number, tol = 0, opts = {}) => hitTest(s, x, y, { toleranceUm: tol, ...opts }).map((h) => h.objectIdx);

  it("orders hits topmost first by the painter's order", () => {
    // On the black line inside the green area: line above area.
    expect(ids(0, 100)).toEqual([1, 0]);
  });

  it("strokes hit within half their width plus the tolerance", () => {
    expect(ids(0, 199)).toContain(1);
    expect(ids(0, 260)).not.toContain(1);
    expect(ids(0, 260, 100)).toContain(1);
  });

  it("fills hit inside (even-odd), not outside", () => {
    expect(ids(9000, 9000)).toEqual([0]);
    expect(ids(11_000, 11_000)).toEqual([]);
  });

  it("a closed stroke's interior counts only when asked", () => {
    expect(ids(5000, 5000)).toEqual([0]);
    expect(ids(5000, 5000, 0, { closedStrokeInterior: true })).toEqual([2, 0]);
    // On the ring itself it always hits.
    expect(ids(7500, 5000)[0]).toBe(2);
  });

  it("glyphs hit by their instance radius", () => {
    expect(ids(-5000, -4750)[0]).toBe(3);
    expect(ids(-5000, -4500)[0]).toBe(0);
  });

  it("text hits its glyph boxes", () => {
    expect(ids(-4000, 6000)[0]).toBe(4);
    expect(ids(-1000, 6000)[0]).toBe(4);
    expect(ids(-4000, 10_500)).toEqual([]);
  });

  it("restricts to the objects asked about", () => {
    expect(ids(0, 100, 0, { objects: (i: number) => i !== 1 })).toEqual([0]);
  });

  it("reports the distance to the drawn edge", () => {
    const [h] = hitTest(s, 0, 150, { toleranceUm: 0 });
    expect(h.objectIdx).toBe(1);
    expect(h.distanceUm).toBeCloseTo(0, 6);
  });
});
