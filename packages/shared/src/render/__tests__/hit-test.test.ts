import { describe, it, expect } from "vitest";
import { hitTest, hitTestStreams } from "../hit-test.js";
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

describe("hit order over fill / stroke / glyph / text (G5, map-rendering.md §5.5)", () => {
  // Four objects over one point (0, 0), one of each kind, in colours that do not follow the kinds:
  // text (colour 1) under a glyph (2) under a fill (3) under a stroke (4).
  function stack(order: { text: number; glyph: number; fill: number; stroke: number }): PassStream {
    const b = new PassStreamBuilder();
    b.push({ kind: "text", colour: order.text, fontId: 0, sizeUm: 2000, glyphs: Uint16Array.from([1]), positions: Float32Array.from([-500, -500]) }, 0, 0);
    b.glyphTable.push({ glyphId: 1, partIdx: 0, fills: [square(0, 0, 400)], strokes: [] });
    b.push({ kind: "glyph", colour: order.glyph, glyphId: 1, partIdx: 0, instances: Float32Array.from([0, 0, 1, 0, 1]) }, 1, 1);
    b.push({ kind: "fill", colour: order.fill, path: square(0, 0, 3000), rule: "evenodd" }, 2, 2);
    b.push({ kind: "stroke", colour: order.stroke, path: makePath([-3000, 0, 3000, 0]), widthUm: 300, cap: "butt", join: "miter" }, 3, 3);
    return b.build();
  }
  const ids = (s: PassStream, x = 0, y = 0) => hitTest(s, x, y, { toleranceUm: 0 }).map((h) => h.objectIdx);

  it("the colour stack decides, whatever the kinds", () => {
    expect(ids(stack({ text: 1, glyph: 2, fill: 3, stroke: 4 }))).toEqual([3, 2, 1, 0]);
    expect(ids(stack({ text: 4, glyph: 3, fill: 2, stroke: 1 }))).toEqual([0, 1, 2, 3]);
    expect(ids(stack({ text: 2, glyph: 4, fill: 1, stroke: 3 }))).toEqual([1, 3, 0, 2]);
  });

  it("within one colour: fill < stroke < glyph < text (§3.6)", () => {
    expect(ids(stack({ text: 5, glyph: 5, fill: 5, stroke: 5 }))).toEqual([0, 1, 3, 2]);
  });

  it("each kind's reach decides whether it is in the list at all", () => {
    const s = stack({ text: 1, glyph: 2, fill: 3, stroke: 4 });
    // 1 mm off the line, outside the glyph disc, inside the fill and the text box.
    expect(ids(s, 0, 1000)).toEqual([2, 0]);
    // Outside the fill, beside the line's end: nothing.
    expect(ids(s, 3500, 3500)).toEqual([]);
  });

  it("tests only the passes asked about", () => {
    const s = stack({ text: 1, glyph: 2, fill: 3, stroke: 4 });
    const glyphAndText = [0, 1, 2, 3].filter((i) => s.passes[i].kind === "glyph" || s.passes[i].kind === "text");
    expect(hitTest(s, 0, 0, { toleranceUm: 0, passes: glyphAndText }).map((h) => h.objectIdx)).toEqual([1, 0]);
  });

  it("turned text hits in its turned box", () => {
    const b = new PassStreamBuilder();
    // One glyph at the origin turned 90° counter-clockwise: its box runs up the y axis… and to −x.
    b.push({ kind: "text", colour: 0, fontId: 0, sizeUm: 1000, glyphs: Uint16Array.from([1]), positions: Float32Array.from([0, 0]), angles: Float32Array.from([90]) }, 0, 0);
    const s = b.build();
    // Upright the box is x ∈ [0, 650], y ∈ [−200, 800]; turned it is x ∈ [−800, 200], y ∈ [0, 650].
    expect(ids(s, -600, 300)).toEqual([0]);
    expect(ids(s, 500, 300)).toEqual([]);
  });
});

describe("hitTestStreams: the effective document's two sources (G5)", () => {
  const pinned = (() => {
    const b = new PassStreamBuilder();
    b.push({ kind: "fill", colour: 0, path: square(0, 0, 5000), rule: "evenodd" }, 0, 0);
    b.push({ kind: "stroke", colour: 2, path: makePath([-5000, 0, 5000, 0]), widthUm: 400, cap: "butt", join: "miter" }, 1, 1);
    b.push({ kind: "stroke", colour: 1, path: makePath([0, -5000, 0, 5000]), widthUm: 400, cap: "butt", join: "miter" }, 2, 2);
    return b.build();
  })();
  const patch = (() => {
    const b = new PassStreamBuilder();
    // Object 7: a line in colour 1 beside object 2's, and object 8 in colour 2 like object 1.
    b.push({ kind: "stroke", colour: 1, path: makePath([-5000, 100, 5000, 100]), widthUm: 400, cap: "butt", join: "miter" }, 7, 7);
    b.push({ kind: "stroke", colour: 2, path: makePath([-5000, -100, 5000, -100]), widthUm: 400, cap: "butt", join: "miter" }, 8, 8);
    return b.build();
  })();

  it("orders by colour, then kind, then the patch's source over the pinned one", () => {
    const hits = hitTestStreams([{ stream: pinned }, { stream: patch }], 0, 0, { toleranceUm: 0 });
    expect(hits.map((h) => [h.source, h.objectIdx])).toEqual([[1, 8], [0, 1], [1, 7], [0, 2], [0, 0]]);
  });

  it("each source tests its own passes and objects only", () => {
    const hits = hitTestStreams([{ stream: pinned, objects: (o) => o !== 1 }, { stream: patch, passes: [0] }], 0, 0, { toleranceUm: 0 });
    expect(hits.map((h) => [h.source, h.objectIdx])).toEqual([[1, 7], [0, 2], [0, 0]]);
  });

  it("one hit per object and source, with its topmost pass and distance", () => {
    const hits = hitTestStreams([{ stream: pinned }], 4000, 300, { toleranceUm: 200 });
    expect(hits.map((h) => h.objectIdx)).toEqual([1, 0]);
    expect(hits[0].distanceUm).toBeCloseTo(100, 5);
    expect(pinned.passes[hits[0].passIdx].kind).toBe("stroke");
  });
});
