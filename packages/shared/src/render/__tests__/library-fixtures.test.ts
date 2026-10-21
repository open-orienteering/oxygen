/**
 * Research 04 §8 fixture rows 1–9, colour order and precision, on the
 * canonical library (docs/map-rendering.md §6.1, §6.3). Two layers per
 * scene: hand-computed assertions on the rule the row is about, and the
 * whole stream against its committed snapshot
 * (`__fixtures__/streams/library/<name>.stream.json`, `diffPassStreams`
 * at the default 1 µm). Regenerate the snapshots only when a rule change
 * is intended: `UPDATE_STREAMS=1 pnpm --filter @oxygen/shared exec vitest
 * run src/render/__tests__/library-fixtures.test.ts`, then review the diff.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PRECISION_OFFSET_UM, type LibrarySceneName, libraryScene, librarySceneNames } from "../__fixtures__/library/index.js";
import { PathMeasure } from "../measure.js";
import { type GlyphPass, type Pass, type PassStream, type RenderPath, type Slice, type StrokePass, type TextPass } from "../pass-stream.js";
import { hatchLines, pathBounds } from "../path.js";
import { diffPassStreams, passStreamFromJson, passStreamToJson, type PassStreamJson } from "../stream-json.js";
import { symbolise } from "../symbolise.js";
import { liberation } from "./fonts.js";

const fonts = () => [liberation().sans, liberation().narrow];
const SNAP_DIR = fileURLToPath(new URL("../__fixtures__/streams/library/", import.meta.url));

function run(name: LibrarySceneName) {
  const scene = libraryScene(name);
  const { stream, warnings } = symbolise({ objects: scene.objects, symbols: scene.symbols, fonts: fonts() });
  return { scene, stream, warnings };
}

/** One pass per line, so a snapshot diff in review shows which pass moved. */
function formatStream(j: PassStreamJson): string {
  const list = (xs: unknown[]) => (xs.length ? `[\n${xs.map((x) => JSON.stringify(x)).join(",\n")}\n]` : "[]");
  return `{\n"objectIdx": ${JSON.stringify(j.objectIdx)},\n"symbolIdx": ${JSON.stringify(j.symbolIdx)},\n"passes": ${list(j.passes)},\n"glyphTable": ${list(j.glyphTable ?? [])},\n"fontTable": ${JSON.stringify(j.fontTable)}\n}\n`;
}

function matchSnapshot(name: LibrarySceneName, stream: PassStream): void {
  const file = `${SNAP_DIR}${name}.stream.json`;
  if (process.env.UPDATE_STREAMS) {
    mkdirSync(SNAP_DIR, { recursive: true });
    writeFileSync(file, formatStream(passStreamToJson(stream)));
  }
  expect(existsSync(file), `missing ${name}.stream.json — see the header of this file`).toBe(true);
  const expected = passStreamFromJson(JSON.parse(readFileSync(file, "utf8")));
  expect(diffPassStreams(expected, stream)).toEqual([]);
}

const of = <K extends Pass["kind"]>(s: PassStream, kind: K, objectIdx?: number) =>
  s.passes.filter((p, i): p is Extract<Pass, { kind: K }> => p.kind === kind && (objectIdx === undefined || s.objectIdx[i] === objectIdx));

/** Slices as arc-length intervals along a polyline (t is linear in length on straight segments). */
function sliceLens(path: RenderPath, slices: Slice[] | undefined): [number, number][] {
  const m = new PathMeasure(path);
  const len = (seg: number, t: number) => m.cumulative[seg] + t * (m.cumulative[seg + 1] - m.cumulative[seg]);
  return (slices ?? [{ seg0: 0, t0: 0, seg1: m.segments.length - 1, t1: 1 }]).map((s) => [len(s.seg0, s.t0), len(s.seg1, s.t1)]);
}
const near3 = (xs: [number, number][]) => xs.map(([a, b]) => [Math.round(a * 1000) / 1000, Math.round(b * 1000) / 1000]);
/** Instance rows `[x, y, cos, sin, scale]`, rounded. */
const rows = (g: GlyphPass) =>
  Array.from({ length: g.instances.length / 5 }, (_, i) => Array.from(g.instances.subarray(5 * i, 5 * i + 5), (v, k) => (k < 2 ? Math.round(v) : Math.round(v * 1e4) / 1e4)));

describe("library fixtures — every scene", () => {
  for (const name of librarySceneNames) {
    it(`${name}: symbolises warning-free and matches its stream snapshot`, () => {
      const { stream, warnings } = run(name);
      expect(warnings).toEqual([]);
      matchSnapshot(name, stream);
    });
  }
});

describe("row 1 — OCAD dash fitting (ISOM 505, 507)", () => {
  const { stream } = run("lib-dash-ocad");

  it("sections restart at the corner and at the dash point; the dash point centres a dash", () => {
    const [p] = of(stream, "stroke", 0);
    // Section 1 (10 mm, E 2000 both ends): n = round(8000 / 2250) = 4, r = 9000 / 10000 → dashes 1800, gaps 250.
    // Section 2 (5 mm, corner → dash point): n = 2, r = 4500 / 5000; ends with half a dash (900).
    // Section 3 (5 mm, dash point → end): mirror image. Touching pieces are one slice.
    expect(near3(sliceLens(p.path, p.slices))).toEqual([
      [0, 1800], [2050, 3850], [4100, 5900], [6150, 7950],
      [8200, 11800], // the end dashes meeting at the corner, one slice round it
      [12050, 13850],
      [14100, 15900], // centred on the dash point at 15000, 1800 long
      [16150, 17950], [18200, 20000],
    ]);
  });

  it("a closed loop is one section with a dash centred on the start point", () => {
    const [p] = of(stream, "stroke", 1);
    // 18 mm: n = 8 gaps, r = 1; the seam dash [−1000, 1000] is cut at the start (a slice never wraps).
    const lens = near3(sliceLens(p.path, p.slices));
    expect(lens[0]).toEqual([0, 1000]);
    expect(lens[1]).toEqual([1250, 3250]);
    expect(lens[lens.length - 1]).toEqual([17000, 18000]);
    expect(lens).toHaveLength(9);
  });

  it("507: interior dashes cut by the secondary gap, end dashes whole", () => {
    const [p] = of(stream, "stroke", 2);
    // 11.4 mm = 2·2250 + 2250 + 3·800, r = 1; interior parts (2250 − 250) / 2 = 1000.
    expect(near3(sliceLens(p.path, p.slices))).toEqual([
      [0, 2250], [3050, 4050], [4300, 5300], [6100, 7100], [7350, 8350], [9150, 11400],
    ]);
  });

  it("minGaps: absent leaves a short line solid, 2 forces two gaps", () => {
    const [solid] = of(stream, "stroke", 3);
    expect(solid.slices).toEqual([{ seg0: 0, t0: 0, seg1: 0, t1: 1 }]);
    const [forced] = of(stream, "stroke", 4);
    // n = max(round(1000 / 2250), 2) = 2; r = (3000 − 500) / 6000.
    const d = 2000 * (2500 / 6000);
    expect(near3(sliceLens(forced.path, forced.slices))).toEqual(near3([[0, d], [d + 250, 2 * d + 250], [2 * d + 500, 3000]]));
  });
});

describe("row 2 — OMAP dash fitting (ISOM 505 as layout omap)", () => {
  const { stream } = run("lib-dash-omap");
  const lens = (o: number) => near3(sliceLens(of(stream, "stroke", o)[0].path, of(stream, "stroke", o)[0].slices));

  it("single dashes, f = 1", () => {
    expect(lens(0)).toEqual([0, 1, 2, 3, 4, 5].map((i) => [i * 2250, i * 2250 + 2000]));
  });
  it("half outer dashes", () => {
    expect(lens(1)).toEqual([[0, 1000], ...[0, 1, 2, 3, 4].map((i) => [1250 + i * 2250, 3250 + i * 2250]), [12500, 13500]]);
  });
  it("groups of two with the in-group break", () => {
    expect(lens(2)).toEqual([[0, 2000], [2250, 4250], [4500, 6500], [6750, 8750], [9000, 11000], [11250, 13250]]);
  });
  it("too short for a group: solid without showAtLeastOne, one dash scaled to the line with it — the same ink", () => {
    expect(lens(3)).toEqual([[0, 800]]);
    expect(lens(4)).toEqual([[0, 800]]);
  });
  it("a dash point centres a single dash", () => {
    // Each 7.75 mm section: hs/he = 1 at the point: n = round((7750 − 1000) / 2250) = 3, nominal 7750, f = 1.
    expect(lens(5)).toEqual([[0, 2000], [2250, 4250], [4500, 6500], [6750, 8750], [9000, 11000], [11250, 13250], [13500, 15500]]);
  });
});

describe("row 3 — glyph placement (ISOM 516, 201, 529 at corners, 510, 416, 510 at corners)", () => {
  const { stream } = run("lib-line-glyphs");

  it("516 fence: spaced 2 mm from 1 mm, rotated to the tangent", () => {
    const [g] = of(stream, "glyph", 0);
    expect(rows(g)).toEqual([1000, 3000, 5000, 7000, 9000].map((x) => [x, 0, 1, 0, 1]));
  });
  it("201 cliff: tags from 0.06 mm, 7 spots evenly over the inner length", () => {
    const [g] = of(stream, "glyph", 1);
    // inner = 3000 − 120 = 2880: n = round(2880 / 500) + 1 = 7, step 480.
    expect(rows(g).map((r) => r[0])).toEqual([60, 540, 1020, 1500, 1980, 2460, 2940]);
  });
  it("529 variant at corners, ends ignored: one glyph at the corner, bisector angle, mitre scale", () => {
    const glyphs = of(stream, "glyph", 2);
    expect(glyphs).toHaveLength(2); // one pass per glyph part
    expect(rows(glyphs[0])).toEqual([[9000, -6000, Math.round(Math.SQRT1_2 * 1e4) / 1e4, Math.round(Math.SQRT1_2 * 1e4) / 1e4, Math.round(Math.SQRT2 * 1e4) / 1e4]]);
  });
  it("510 power line: a glyph on the dash point only — unflagged ends get none (§4.5, B9)", () => {
    expect(rows(of(stream, "glyph", 3)[0])).toEqual([[2000, -5000, 1, 0, 1]]);
  });
  it("416 on a closed path: max(minCountClosed, round(L / distance)) dots from the start point", () => {
    const [g] = of(stream, "glyph", 4);
    expect(g.instances.length / 5).toBe(27);
    expect(rows(g)[0].slice(0, 2)).toEqual([12000, -6000]);
    expect(rows(g)[1][0]).toBe(Math.round(12000 + 12000 / 27));
  });
  it("510 as imported from OCAD (corners): poles on the corner point and the flagged end, none on the plain start", () => {
    expect(rows(of(stream, "glyph", 5)[0])).toEqual([[2000, -8000, 1, 0, 1], [4000, -8000, 1, 0, 1]]);
  });
});

describe("row 4 — pattern origin and clip modes (ISOM 402, 208, 213)", () => {
  const { stream } = run("lib-pattern");
  const pts = (o: number) => of(stream, "glyph", o).flatMap((g) => rows(g).map((r) => [r[0], r[1]]));

  it("adjacent areas share one grid anchored at the paper origin", () => {
    // 402: 0.7 mm cells at 45°: every instance is a lattice point i·a + j·b.
    const c = 700 * Math.SQRT1_2;
    for (const [x, y] of [...pts(0), ...pts(1)]) {
      const i = (x + y) / (2 * c), j = (y - x) / (2 * c);
      expect(Math.abs(i - Math.round(i))).toBeLessThan(0.002);
      expect(Math.abs(j - Math.round(j))).toBeLessThan(0.002);
    }
    expect(pts(0).every(([x]) => x < 8000) && pts(1).every(([x]) => x > 8000)).toBe(true);
  });
  it("an object angle of 30° turns a manual-rotate grid about the origin", () => {
    const rad = (30 * Math.PI) / 180;
    for (const [x, y] of pts(2)) {
      // Back into grid space: multiples of 700.
      const u = x * Math.cos(rad) + y * Math.sin(rad), v = -x * Math.sin(rad) + y * Math.cos(rad);
      expect(Math.abs(u / 700 - Math.round(u / 700))).toBeLessThan(0.002);
      expect(Math.abs(v / 700 - Math.round(v / 700))).toBeLessThan(0.002);
    }
  });
  it("208: odd rows shifted by half a cell", () => {
    const byRow = new Map<number, number[]>();
    for (const [x, y] of pts(3)) byRow.set(y, [...(byRow.get(y) ?? []), x]);
    for (const [y, xs] of byRow) {
      const shifted = Math.round(y / 1200) % 2 !== 0;
      for (const x of xs) expect(((x / 1200 - (shifted ? 0.5 : 0)) % 1 + 1) % 1).toBeCloseTo(0, 3);
    }
  });
  it("213 in the four clip modes: completelyInside ⊂ centreInside ⊂ partiallyInside = clip, clip carries the area", () => {
    const local = (o: number) => new Set(pts(4 + o).map(([x, y]) => `${x - 4500 * o},${y}`));
    const [centre, complete, partial, clip] = [0, 1, 2, 3].map(local);
    expect(complete.size).toBeLessThan(centre.size);
    expect(centre.size).toBeLessThan(partial.size);
    for (const k of complete) expect(centre.has(k)).toBe(true);
    for (const k of centre) expect(partial.has(k)).toBe(true);
    expect([...clip].sort()).toEqual([...partial].sort());
    expect(of(stream, "glyph", 7)[0].clip).toBeDefined();
    expect(of(stream, "glyph", 4)[0].clip).toBeUndefined();
  });
});

describe("row 5 — hatch (ISOM 709, 407, crossed 709)", () => {
  const { stream } = run("lib-hatch");

  it("passes carry the symbol's parameters; crossed is two passes", () => {
    // Colour-major: 407's green (8) before 709's purple (28); within purple by symbol, then insertion.
    expect(of(stream, "hatch").map((h) => [h.colour, h.widthUm, h.spacingUm, h.offsetUm, h.angleDeg])).toEqual([
      [8, 120, 840, 0, 90], [28, 250, 1200, 0, 45], [28, 250, 1200, 0, 45], [28, 250, 1200, 0, 45], [28, 250, 1200, 0, 135],
    ]);
  });
  it("line k satisfies x·nx + y·ny = offset + k·spacing — the formula the GL stripe shader samples", () => {
    for (const h of of(stream, "hatch")) {
      const a = (h.angleDeg * Math.PI) / 180, nx = -Math.sin(a), ny = Math.cos(a);
      const lines = hatchLines(pathBounds(h.path), { spacingUm: h.spacingUm, offsetUm: h.offsetUm, angleDeg: h.angleDeg });
      expect(lines.length).toBeGreaterThan(3);
      for (const l of lines) {
        for (const [x, y] of [[l.x0, l.y0], [l.x1, l.y1]]) {
          const k = (x * nx + y * ny - h.offsetUm) / h.spacingUm;
          expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-6);
        }
      }
    }
  });
  it("adjacent areas hatch one family: both use the same parameters in paper space", () => {
    const [a, b] = of(stream, "hatch").filter((h) => h.angleDeg === 45 && h.path.coords[0] < 20000);
    expect([a.spacingUm, a.offsetUm, a.angleDeg]).toEqual([b.spacingUm, b.offsetUm, b.angleDeg]);
  });
});

describe("row 6 — borders (ISSprOM 509.1, 505, 505 asymmetric)", () => {
  const { stream } = run("lib-borders");
  const strokes = (o: number) => of(stream, "stroke", o);

  it("509.1: band under the borders, dashed main line between, borders at ±shift", () => {
    const s = strokes(0);
    expect(s.map((p) => [p.colour, p.widthUm, p.path.coords[1]])).toEqual([[28, 350, 0], [28, 100, 175], [28, 100, -175], [29, 350, 0]]);
  });
  it("505 round a corner: both dashed borders share the main line's phase, scaled to their own length", () => {
    const [left, right] = strokes(1).filter((p) => p.widthUm === 120);
    const L = (p: StrokePass) => new PathMeasure(p.path).totalLength;
    const main = 12000; // the centre line
    const l = sliceLens(left.path, left.slices).map(([a, b]) => [a / L(left), b / L(left)]);
    const r = sliceLens(right.path, right.slices).map(([a, b]) => [a / L(right), b / L(right)]);
    expect(L(left)).not.toBeCloseTo(L(right), 0);
    expect(l.length).toBe(r.length);
    l.forEach(([a, b], i) => {
      expect(a).toBeCloseTo(r[i][0], 6);
      expect(b).toBeCloseTo(r[i][1], 6);
    });
    // First section 6 mm: n = round(4000 / 2250) = 2, r = 5500 / 6000 → first dash ends at 1833.3 / 12000 of the way.
    expect(l[0][1]).toBeCloseTo((2000 * (5500 / 6000)) / main, 6);
  });
  it("asymmetric edges: band of left + right shift, centred between the edges", () => {
    const s = strokes(2);
    const band = s.find((p) => p.colour === 20)!;
    expect(band.widthUm).toBe(350); // backgroundWidthUm is explicit in the entry
    const edges = s.filter((p) => p.colour === 19).map((p) => [p.widthUm, p.path.coords[1]]);
    expect(edges).toEqual([[120, -3000 + 225], [200, -3000 - 300]]);
  });
});

describe("row 7 — holes and winding (ISOM 401)", () => {
  const { scene, stream } = run("lib-holes");

  it("one even-odd fill per area, rings passed through untouched", () => {
    const fills = of(stream, "fill");
    expect(fills).toHaveLength(2);
    expect(fills.every((f) => f.rule === "evenodd")).toBe(true);
    expect(Array.from(fills[0].path.coords)).toEqual(Array.from(scene.objects[0].path.coords));
    expect(Array.from(fills[0].path.flags)).toEqual(Array.from(scene.objects[0].path.flags));
    expect(Array.from(fills[1].path.coords)).toEqual(Array.from(scene.objects[1].path.coords));
  });
});

describe("row 8 — text metrics (ISOM 704, 603.b)", () => {
  const { stream } = run("lib-text");
  const { sans } = liberation();
  const texts = (o: number) => of(stream, "text", o);

  it("704 \"31\": em from the 4.0 mm digit height, advances from the font", () => {
    const [t] = texts(0);
    // Liberation Sans "0" is 1430 font units tall (outline, overshoot included) → em 5.73 mm.
    expect(sans.digitHeight).toBe(1430);
    expect(t.sizeUm).toBeCloseTo((4000 * 2048) / 1430, 3);
    const k = t.sizeUm / 2048;
    expect(t.positions[2]).toBeCloseTo((sans.advance(sans.glyphId(0x33)) + sans.kerning(sans.glyphId(0x33), sans.glyphId(0x31))) * k, 1);
  });
  it("603.b left / centre / right: the line shifts by 0, −w/2, −w; kerning applied", () => {
    const [l] = texts(1), [c] = texts(2), [r] = texts(3);
    const k = l.sizeUm / 2048;
    const A = sans.glyphId(0x41), V = sans.glyphId(0x56);
    expect(sans.kerning(A, V)).toBeLessThan(0);
    expect(l.positions[0]).toBe(4000);
    expect(l.positions[2] - l.positions[0]).toBeCloseTo((sans.advance(A) + sans.kerning(A, V)) * k, 2);
    const w = 2 * (l.positions[0] - c.positions[0]);
    expect(r.positions[0]).toBeCloseTo(4000 - w, 2);
    // The space advances but is not drawn: A, V, 1, 2.
    expect(l.glyphs).toHaveLength(4);
  });
  it("two lines: the second baseline lineSpacing × em below the first", () => {
    const [t] = texts(4);
    const second = t.positions.findIndex((v, i) => i % 2 === 1 && v !== t.positions[1]);
    expect(t.positions[1] - t.positions[second]).toBeCloseTo(1.2 * t.sizeUm, 3);
  });
});

describe("row 9 — halos as own passes (ISSprOM 704.b over 521, framed ride over 406)", () => {
  const { scene, stream } = run("lib-halos");

  it("the white outline sorts at its own stack position: above the building's black, below upper purple", () => {
    const colours = stream.passes.map((p) => p.colour);
    const halo = stream.passes.findIndex((p) => p.kind === "text" && (p as TextPass).haloWidthUm);
    const text = stream.passes.findIndex((p) => p.kind === "text" && !(p as TextPass).haloWidthUm);
    expect(scene.colours[stream.passes[halo].colour].id).toBe("iof2024:white-upper");
    expect(scene.colours[stream.passes[text].colour].id).toBe("iof2024:purple-upper");
    const black = colours.lastIndexOf(28);
    expect(black).toBeLessThan(halo);
    expect(halo).toBeLessThan(text);
    expect((stream.passes[halo] as TextPass).haloWidthUm).toBe(150);
  });
  it("the ride's band is a separate continuous stroke over the green, under the black line", () => {
    const s = of(stream, "stroke", 3);
    expect(s.map((p) => [p.colour, p.widthUm, p.slices === undefined])).toEqual([[12, 610, true], [28, 210, false]]);
    expect(stream.passes.findIndex((p) => p.kind === "fill" && p.colour === 5)).toBeLessThan(stream.passes.indexOf(s[0]));
  });
});

describe("colour order (ten ISSprOM colours incl. lower and upper purple)", () => {
  const { scene, stream } = run("lib-colour-order");
  it("passes pushed in reverse come out colour-major, lower purple under the black, upper purple on top", () => {
    const colours = stream.passes.map((p) => p.colour);
    expect(colours).toEqual([...colours].sort((a, b) => a - b));
    expect(new Set(colours).size).toBe(10);
    const ids = [...new Set(colours)].map((c) => scene.colours[c].id);
    expect(ids.indexOf("iof2024:purple-lower")).toBeLessThan(ids.indexOf("iof2024:black100"));
    expect(ids[ids.length - 1]).toBe("iof2024:purple-upper");
  });
});

describe("precision (rows 1 and 3 at the far corner of a 1.2 m document)", () => {
  it("every pass is the near pass translated, to 1 µm", () => {
    const far = run("lib-precision").stream;
    const parts = [run("lib-dash-ocad"), run("lib-line-glyphs")];
    let objectBase = 0;
    parts.forEach((part, n) => {
      const dy = -n * 12000;
      for (let o = 0; o < part.scene.objects.length; o++) {
        const nearPasses = part.stream.passes.filter((_, i) => part.stream.objectIdx[i] === o);
        const farPasses = far.passes.filter((_, i) => far.objectIdx[i] === objectBase + o);
        expect(farPasses.map((p) => [p.kind, p.colour])).toEqual(nearPasses.map((p) => [p.kind, p.colour]));
        nearPasses.forEach((p, k) => {
          const q = farPasses[k];
          if (p.kind === "stroke" && q.kind === "stroke") expect(q.slices).toEqual(p.slices);
          if (p.kind === "glyph" && q.kind === "glyph") {
            for (let i = 0; i < p.instances.length; i += 5) {
              expect(Math.abs(q.instances[i] - p.instances[i] - PRECISION_OFFSET_UM)).toBeLessThanOrEqual(1);
              expect(Math.abs(q.instances[i + 1] - p.instances[i + 1] - PRECISION_OFFSET_UM - dy)).toBeLessThanOrEqual(1);
            }
          }
        });
      }
      objectBase += part.scene.objects.length;
    });
  });
});
