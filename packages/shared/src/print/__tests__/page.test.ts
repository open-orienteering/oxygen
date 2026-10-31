/**
 * The page model (docs/course-print.md §4): `T_map` agrees with the
 * legacy `mapToPage`, page objects flip into y-up page mm, and the
 * pass-stream transform the page oracle uses moves geometry, widths,
 * glyphs and hatches together.
 */

import { describe, expect, it } from "vitest";
import { mapToPage, mapWindowForFrame } from "../../course-maps/geometry.js";
import type { CourseMapObject } from "../../course-maps/schema.js";
import { hatchLines, pathBounds } from "../../render/path.js";
import { makePath, type PassStream } from "../../render/pass-stream.js";
import { flipPageObject, frameInMap, frameRectUm, mapLayerTransform, mapPointToPage, pagePointToMap, transformPassStream } from "../page.js";

const H = 297;
const frame = { x: 10, y: 20, width: 150, height: 200 };

describe("T_map", () => {
  for (const rot of [0, 20, -15]) {
    it(`maps paper points where mapToPage puts them (rotation ${rot}°), y flipped`, () => {
      const window = mapWindowForFrame(frame, { x: 120, y: -40 }, 15000, 10000, rot);
      const t = mapLayerTransform(frame, window, H);
      expect(t.scaleRatio).toBeCloseTo(1.5, 12);
      expect(t.rotationDeg).toBe(rot === 0 ? 0 : -rot);
      for (const p of [{ x: 120, y: -40 }, { x: 100, y: -10 }, { x: 160, y: -90 }]) {
        const legacy = mapToPage(p, frame, window);
        const [x, y] = mapPointToPage(t, p.x * 1000, p.y * 1000);
        expect(x / 1000).toBeCloseTo(legacy.x, 2);
        expect(H - y / 1000).toBeCloseTo(legacy.y, 2);
        const [mx, my] = pagePointToMap(t, x, y);
        expect(mx).toBeCloseTo(p.x * 1000, 3);
        expect(my).toBeCloseTo(p.y * 1000, 3);
      }
    });
  }

  it("the frame in map space is the window (unrotated) and the rotated rectangle otherwise", () => {
    const window = mapWindowForFrame(frame, { x: 0, y: 0 }, 10000, 10000);
    const t = mapLayerTransform(frame, window, H);
    const ring = frameInMap(t, frameRectUm(frame, H));
    expect(ring[0].x).toBeCloseTo(window.minX, 6);
    expect(ring[0].y).toBeCloseTo(window.minY, 6);
    expect(ring[2].x).toBeCloseTo(window.minX + window.width, 6);
    const rot = frameInMap(mapLayerTransform(frame, { ...window, rotationDeg: 30 }, H), frameRectUm(frame, H));
    // Corners stay at the same distance from the centre; the lower-left one turns counter-clockwise in map space.
    expect(Math.hypot(rot[0].x, rot[0].y)).toBeCloseTo(Math.hypot(ring[0].x, ring[0].y), 6);
    expect(rot[0].x).not.toBeCloseTo(ring[0].x, 1);
  });

  it("frameRectUm flips the y-down frame to a y-up rectangle", () => {
    expect(frameRectUm(frame, H)).toEqual({ x: 10000, y: 77000, width: 150000, height: 200000 });
  });
});

describe("flipPageObject", () => {
  it("text and lines by y, rectangles by their lower-left corner, handles negated; anchor becomes map", () => {
    const text: CourseMapObject = { id: "t", anchor: "page", kind: "text", x: 5, y: 10, text: "x", fontSizeMm: 3, color: "#000000" };
    expect(flipPageObject(text, H)).toMatchObject({ anchor: "map", x: 5, y: 287 });
    const rect: CourseMapObject = { id: "r", anchor: "page", kind: "rectangle", x: 5, y: 10, width: 20, height: 30, fillMode: "whiteout" };
    expect(flipPageObject(rect, H)).toMatchObject({ x: 5, y: 257, width: 20, height: 30 });
    const path: CourseMapObject = { id: "p", anchor: "page", kind: "path", points: [{ x: 0, y: 0, hOut: { x: 1, y: 2 } }, { x: 4, y: 8 }], fillMode: "none", closed: false };
    const flipped = flipPageObject(path, H) as Extract<CourseMapObject, { kind: "path" }>;
    expect(flipped.points[0]).toEqual({ x: 0, y: 297, hOut: { x: 1, y: -2 } });
    expect(flipped.points[1]).toEqual({ x: 4, y: 289 });
  });
});

describe("transformPassStream", () => {
  const window = mapWindowForFrame(frame, { x: 0, y: 0 }, 15000, 10000, 30);
  const t = mapLayerTransform(frame, window, H);
  const stream: PassStream = {
    objectIdx: new Uint32Array(4),
    symbolIdx: new Uint32Array(4),
    glyphTable: [],
    fontTable: [],
    passes: [
      { kind: "stroke", colour: 0, path: makePath([0, 0, 10000, 0, 10000, 10000]), slices: [{ seg0: 0, t0: 0.25, seg1: 1, t1: 0.5 }], widthUm: 140, cap: "butt", join: "miter", taper: { endUm: 800 } },
      { kind: "glyph", colour: 1, glyphId: 0, partIdx: 0, instances: new Float32Array([1000, 2000, 1, 0, 1]) },
      { kind: "hatch", colour: 2, path: makePath([-20000, -20000, 20000, -20000, 20000, 20000, -20000, 20000], undefined, true), widthUm: 200, spacingUm: 1400, offsetUm: 300, angleDeg: 45 },
      { kind: "text", colour: 3, fontId: 0, sizeUm: 4000, glyphs: new Uint16Array([1, 2]), positions: new Float32Array([0, 0, 2000, 0]), haloWidthUm: 100 },
    ],
  };
  const out = transformPassStream(stream, t);
  const k = t.scaleRatio;

  it("strokes: points moved, slices kept, width and taper scaled", () => {
    const s = out.passes[0];
    if (s.kind !== "stroke") throw new Error("kind");
    const [x, y] = mapPointToPage(t, 10000, 0);
    expect(s.path.coords[2]).toBe(Math.round(x));
    expect(s.path.coords[3]).toBe(Math.round(y));
    expect(s.slices).toEqual([{ seg0: 0, t0: 0.25, seg1: 1, t1: 0.5 }]);
    expect(s.widthUm).toBeCloseTo(140 * k, 9);
    expect(s.taper?.endUm).toBeCloseTo(800 * k, 9);
  });

  it("glyph instances turn by the layer rotation and scale by the ratio", () => {
    const g = out.passes[1];
    if (g.kind !== "glyph") throw new Error("kind");
    const a = (t.rotationDeg * Math.PI) / 180;
    expect(g.instances[2]).toBeCloseTo(Math.cos(a), 6);
    expect(g.instances[3]).toBeCloseTo(Math.sin(a), 6);
    expect(g.instances[4]).toBeCloseTo(k, 6);
  });

  it("hatch lines land on the transformed lines of the original", () => {
    const src = stream.passes[2], dst = out.passes[2];
    if (src.kind !== "hatch" || dst.kind !== "hatch") throw new Error("kind");
    const a = (dst.angleDeg * Math.PI) / 180;
    const n = [-Math.sin(a), Math.cos(a)];
    for (const l of hatchLines(pathBounds(src.path), src).slice(0, 5)) {
      const [x, y] = mapPointToPage(t, (l.x0 + l.x1) / 2, (l.y0 + l.y1) / 2);
      const p = (x * n[0] + y * n[1] - dst.offsetUm) / dst.spacingUm;
      expect(Math.abs(p - Math.round(p))).toBeLessThan(1e-3);
    }
    expect(dst.spacingUm).toBeCloseTo(1400 * k, 9);
  });

  it("filter masks: region paths moved like the passes", () => {
    const region = makePath([0, 0, 10000, 0, 10000, 10000], undefined, true);
    const m = transformPassStream({ ...stream, masks: [{ regions: [region] }], maskIdx: Int32Array.from([0, -1, -1, -1]) }, t);
    const [x, y] = mapPointToPage(t, 10000, 10000);
    expect(m.masks![0].regions[0].coords[4]).toBe(Math.round(x));
    expect(m.masks![0].regions[0].coords[5]).toBe(Math.round(y));
    expect(Array.from(m.maskIdx!)).toEqual([0, -1, -1, -1]);
    expect(out).not.toHaveProperty("masks");
  });

  it("text: positions moved, size and halo scaled, every glyph turned", () => {
    const x = out.passes[3];
    if (x.kind !== "text") throw new Error("kind");
    expect(x.sizeUm).toBeCloseTo(4000 * k, 6);
    expect(x.haloWidthUm).toBeCloseTo(100 * k, 6);
    expect(Array.from(x.angles!)).toEqual([t.rotationDeg, t.rotationDeg].map((v) => Math.fround(v)));
  });
});
