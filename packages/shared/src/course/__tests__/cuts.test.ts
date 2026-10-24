/**
 * The automatic-cut rule over feature lists (course-layer.md §3.4): a cut
 * clears the feature's symbol radius + half the line + `CUT_AIR_MM`, and a
 * feature is on the line by the same sum; plus the document feature source.
 */

import { describe, expect, it } from "vitest";
import { CUT_AIR_MM, CUT_CODES, DEFAULT_FEATURE_RADIUS_MM, circleCuts, cutContextForScale, cutFeaturesOfDocument, cutSymbolRadiusMm, legGaps, ocadCutSymbolRadiiMm } from "../cuts.js";
import type { OcadSymbolDefLike } from "../../import/ocad-symbols.js";
import { OBJECT_TYPE, decodeMapDocument, encodeMapDocument, type MapDocumentInput } from "../../map-document/index.js";
import { SYMBOL_LIBRARY_VERSION } from "../../symbol-library/index.js";

const R = 2.5;
const W = 0.35;
const f = (x: number, y: number, r?: number) => (r === undefined ? { x, y } : { x, y, r });
const gapAt = (gaps: Array<{ start: number; end: number }>, deg: number) =>
  gaps.some((g) => (g.start <= g.end ? deg >= g.start && deg <= g.end : deg >= g.start || deg <= g.end));
/** Rim point at a compass bearing. */
const rim = (deg: number, r = R): [number, number] => [r * Math.sin((deg * Math.PI) / 180), r * Math.cos((deg * Math.PI) / 180)];
const clearance = (r: number, w = W) => r + w / 2 + CUT_AIR_MM;

describe("circleCuts", () => {
  it("opens the rim exactly to the clearance of a feature on it", () => {
    const boulder = f(R, 0, 0.2);
    const cuts = circleCuts([boulder], 0, 0, R, W);
    expect(cuts).toHaveLength(1);
    expect(gapAt(cuts, 90)).toBe(true);
    expect(gapAt(cuts, 270)).toBe(false);
    // Both arc ends sit at symbol + half line + air from the boulder's centre.
    for (const deg of [cuts[0].start, cuts[0].end]) {
      const [x, y] = rim(deg);
      expect(Math.hypot(x - boulder.x, y - boulder.y)).toBeCloseTo(clearance(0.2), 9);
    }
    // 0.625 mm clearance on a 2.5 mm rim: ~28.7°, 1.25 mm of chord (was ±0.4 mm, 0.8 mm).
    expect((cuts[0].end - cuts[0].start + 360) % 360).toBeCloseTo((4 * Math.asin(clearance(0.2) / (2 * R)) * 180) / Math.PI, 9);
  });

  it("widens with the feature's symbol and the line, defaults the radius", () => {
    const width = (g: Array<{ start: number; end: number }>) => (g[0].end - g[0].start + 360) % 360;
    const boulder = width(circleCuts([f(R, 0, 0.2)], 0, 0));
    const cluster = width(circleCuts([f(R, 0, 0.46)], 0, 0));
    expect(cluster).toBeGreaterThan(boulder);
    expect(width(circleCuts([f(R, 0, 0.2)], 0, 0, R, 0.525))).toBeGreaterThan(boulder);
    expect(circleCuts([f(R, 0)], 0, 0)).toEqual(circleCuts([f(R, 0, DEFAULT_FEATURE_RADIUS_MM)], 0, 0));
  });

  it("is on the rim within the clearance, off it beyond", () => {
    const c = clearance(0.2);
    expect(circleCuts([f(R + c - 0.01, 0, 0.2)], 0, 0)).toHaveLength(1);
    expect(circleCuts([f(R + c + 0.01, 0, 0.2)], 0, 0)).toEqual([]);
    expect(circleCuts([f(R - c + 0.01, 0, 0.2)], 0, 0)).toHaveLength(1);
    expect(circleCuts([f(R - c - 0.01, 0, 0.2)], 0, 0)).toEqual([]);
    // A feature off the rim opens less than one on it.
    const on = circleCuts([f(R, 0, 0.2)], 0, 0)[0], off = circleCuts([f(R + 0.4, 0, 0.2)], 0, 0)[0];
    expect(off.end - off.start).toBeLessThan(on.end - on.start);
  });

  it("leaves the circle whole for a centred feature and wraps north", () => {
    expect(gapAt(circleCuts([f(0, R)], 0, 0, R), 0)).toBe(true);
    expect(circleCuts([f(0, 0)], 0, 0, R)).toEqual([]);
    const north = circleCuts([f(-0.1, R)], 0, 0, R);
    expect(north).toHaveLength(1);
    expect(gapAt(north, 359)).toBe(true);
    expect(gapAt(north, 5)).toBe(true);
  });

  it("follows a larger circle", () => {
    expect(circleCuts([f(R, 0, 0.2)], 0, 0, 3.75)).toEqual([]);
    expect(circleCuts([f(3.75, 0, 0.3)], 0, 0, 3.75, 0.525)).toHaveLength(1);
  });

  it("keeps a circle whole when cuts would leave almost nothing", () => {
    const ring = Array.from({ length: 24 }, (_, i) => rim(i * 15)).map(([x, y]) => f(x, y, 0.4));
    expect(circleCuts(ring, 0, 0)).toEqual([]);
  });
});

describe("legGaps", () => {
  const A = f(0, 0), B = f(40, 0);

  it("opens the leg exactly to the clearance of a feature beside it", () => {
    const boulder = f(20, 0.3, 0.2);
    const gaps = legGaps(A, B, [boulder], R, W);
    expect(gaps).toHaveLength(1);
    const c = clearance(0.2);
    for (const t of [gaps[0].from, gaps[0].to]) expect(Math.hypot(t * 40 - 20, 0.3)).toBeCloseTo(c, 9);
    expect((gaps[0].to - gaps[0].from) * 40).toBeCloseTo(2 * Math.sqrt(c * c - 0.09), 9);
  });

  it("is on the line within the clearance only", () => {
    const c = clearance(0.2);
    expect(legGaps(A, B, [f(20, c - 0.2, 0.2)], R)).toHaveLength(1);
    expect(legGaps(A, B, [f(20, c + 0.01, 0.2)], R)).toEqual([]);
  });

  it("keeps the leg ends, merges overlaps, skips short legs", () => {
    expect(legGaps(A, B, [f(1, 0)], R)).toEqual([]);
    expect(legGaps(A, B, [f(19.75, 0), f(20.25, 0)], R)).toHaveLength(1);
    expect(legGaps(A, B, [f(18, 0), f(22, 0)], R)).toHaveLength(2);
    expect(legGaps(f(0, 0), f(6, 0), [f(3, 0)], R)).toEqual([]);
  });

  it("never erases most of a leg", () => {
    const many = Array.from({ length: 40 }, (_, i) => f(4 + i * 0.8, 0));
    const gaps = legGaps(A, B, many, R);
    expect(gaps.reduce((s, g) => s + g.to - g.from, 0)).toBeLessThanOrEqual(0.7);
  });
});

describe("symbol radii", () => {
  it("measures an OCAD file's cut symbols as it draws them", () => {
    const dot = (symNum: number, diameter: number, type = 1): OcadSymbolDefLike =>
      ({ symNum, number: `${symNum / 1000}`, type, elements: [{ type: 4, color: 0, diameter, coords: [[0, 0]] }] }) as unknown as OcadSymbolDefLike;
    const radii = ocadCutSymbolRadiiMm([dot(204000, 60), dot(205000, 90), dot(418000, 50), dot(109000, 40, 2)]);
    expect([...radii.entries()]).toEqual([[204000, 0.3], [205000, 0.45]]);
  });

  it("measures the library's cut symbols", () => {
    expect(cutSymbolRadiusMm("ISOM2017-2", "204")).toBeCloseTo(0.2, 9);
    expect(cutSymbolRadiusMm("ISOM2017-2", "205")).toBeCloseTo(0.3, 9);
    expect(cutSymbolRadiusMm("ISOM2017-2", "109")).toBeCloseTo(0.25, 9);
    expect(cutSymbolRadiusMm("ISOM2017-2", "110")).toBeCloseTo(0.4, 3);
    // Triangle of side 0.8 mm: circumradius 0.8 / √3 (rounded µm vertices).
    expect(cutSymbolRadiusMm("ISOM2017-2", "207")).toBeCloseTo(0.8 / Math.sqrt(3), 2);
    // ISOM 203 has no plain entry: the heading's drawing, 203.1 rocky pit (not 203.2 dangerous pit).
    expect(cutSymbolRadiusMm("ISOM2017-2", "203")).toBe(cutSymbolRadiusMm("ISOM2017-2", "203.1"));
    expect(cutSymbolRadiusMm("ISOM2017-2", "203.0")).toBeCloseTo(0.489, 3); // the V hangs 0.49 mm below its origin
    expect(cutSymbolRadiusMm("ISSprOM2019-2", "204")).toBeCloseTo(0.3, 9);
  });

  it("chooses library and factor by scale", () => {
    expect(cutContextForScale(15000)).toEqual({ libraryId: "ISOM2017-2", documentFactor: 1 });
    expect(cutContextForScale(10000)).toEqual({ libraryId: "ISOM2017-2", documentFactor: 1.5 });
    expect(cutContextForScale(4000)).toEqual({ libraryId: "ISSprOM2019-2", documentFactor: 1 });
  });
});

describe("cutFeaturesOfDocument", () => {
  const header: MapDocumentInput["header"] = {
    format: { version: 1, importer: "test-1" },
    source: { kind: "ocad", version: "2018", hash: "00".repeat(32), bytes: 1 },
    unitsPerMm: 100,
    mapScale: 15000,
    georeferencing: { crs: null, paperOrigin: { x: 0, y: 0 }, gridRotationDeg: 0 },
    colours: [{ id: "src:0", name: "Black", cmyk: [0, 0, 0, 1] }],
    symbols: [
      // 0: matched to the library boulder although its source code is odd.
      { code: "900.0", name: "Stone", kind: "point", render: null, match: { canonicalId: "ISOM2017-2:204", method: "geometry", state: "auto", confidence: 0.9, libraryVersion: SYMBOL_LIBRARY_VERSION } },
      // 1: unmatched rocky pit by source code.
      { code: "203.0", name: "Rocky pit", kind: "point", render: null },
      // 2: cliff line — not a point.
      { code: "201.0", name: "Cliff", kind: "line", render: null },
      // 3: a knoll whose symbol is hidden.
      { code: "109.0", name: "Knoll", kind: "point", render: null, hidden: true },
      // 4: matched to a non-cut code though the source says 204.
      { code: "204.0", name: "Tree?", kind: "point", render: null, match: { canonicalId: "ISOM2017-2:418", method: "geometry", state: "auto", confidence: 0.9, libraryVersion: SYMBOL_LIBRARY_VERSION } },
      // 5: suggested (not applied) match: the source code decides.
      { code: "205.0", name: "Large boulder", kind: "point", render: null, match: { canonicalId: "ISOM2017-2:418", method: "geometry", state: "suggested", confidence: 0.5, libraryVersion: SYMBOL_LIBRARY_VERSION } },
    ],
  };
  const obj = (symbolIdx: number, type: number, coords: number[]) => ({ symbolIdx, type, sourceIndex: 0, coords, flags: new Array(coords.length / 2).fill(0) });

  it("keeps point objects of cut codes by applied match, else source code", () => {
    const doc = decodeMapDocument(encodeMapDocument({
      header,
      objects: [
        obj(0, OBJECT_TYPE.point, [1000, 2000]),
        obj(1, OBJECT_TYPE.point, [-500, 250]),
        obj(2, OBJECT_TYPE.line, [0, 0, 1000, 0]),
        obj(3, OBJECT_TYPE.point, [0, 0]),
        obj(4, OBJECT_TYPE.point, [0, 0]),
        obj(5, OBJECT_TYPE.point, [300, 300]),
      ],
    }));
    // The encoder may reorder objects; compare as a set.
    const byX = (a: { x: number }, b: { x: number }) => a.x - b.x;
    expect(cutFeaturesOfDocument(doc).sort(byX)).toEqual([
      f(-5, 2.5, cutSymbolRadiusMm("ISOM2017-2", "203")),
      f(3, 3, 0.3),
      f(10, 20, 0.2),
    ]);
  });

  it("measures an unmatched symbol by the document's own render", () => {
    const own = { ...header, symbols: [{ code: "204.0", name: "Boulder", kind: "point" as const, render: { type: "point" as const, id: "src:204.0", code: "204.0", name: "Boulder", glyph: { parts: [{ kind: "disc" as const, colour: 0, diameterUm: 520 }], rotatable: false }, orientation: "north" as const } }] };
    const doc = decodeMapDocument(encodeMapDocument({ header: own, objects: [obj(0, OBJECT_TYPE.point, [0, 100])] }));
    expect(cutFeaturesOfDocument(doc)).toEqual([f(0, 1, 0.26)]);
  });

  it("falls back to the library entry × the document factor", () => {
    const doc = decodeMapDocument(encodeMapDocument({ header: { ...header, mapScale: 10000 }, objects: [obj(0, OBJECT_TYPE.point, [1000, 2000])] }));
    expect(cutFeaturesOfDocument(doc)).toEqual([f(10, 20, 0.2 * 1.5)]);
  });

  it("is today's CUT_SYMBOLS set", () => {
    expect([...CUT_CODES].sort()).toEqual([109, 110, 203, 204, 205, 207]);
  });
});
