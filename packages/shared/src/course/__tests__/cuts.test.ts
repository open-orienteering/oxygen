/**
 * The automatic-cut rule over feature lists — the cases of
 * `packages/api/src/__tests__/overprint-cuts.test.ts`, with the same
 * numbers (course-layer.md §3.4), plus the document feature source.
 */

import { describe, expect, it } from "vitest";
import { CUT_CODES, circleCuts, cutFeaturesOfDocument, legGaps } from "../cuts.js";
import { OBJECT_TYPE, decodeMapDocument, encodeMapDocument, type MapDocumentInput } from "../../map-document/index.js";
import { SYMBOL_LIBRARY_VERSION } from "../../symbol-library/index.js";

const R = 2.5;
const f = (x: number, y: number) => ({ x, y });
const gapAt = (gaps: Array<{ start: number; end: number }>, deg: number) =>
  gaps.some((g) => (g.start <= g.end ? deg >= g.start && deg <= g.end : deg >= g.start || deg <= g.end));

describe("circleCuts", () => {
  it("slits the rim over a feature sitting on it, tightly", () => {
    const cuts = circleCuts([f(R, 0)], 0, 0, R);
    expect(cuts).toHaveLength(1);
    expect(gapAt(cuts, 90)).toBe(true);
    expect(gapAt(cuts, 270)).toBe(false);
    const width = (cuts[0].end - cuts[0].start + 360) % 360;
    expect(width).toBeGreaterThan(10);
    expect(width).toBeLessThan(22);
    expect((width / 360) * 2 * Math.PI * R).toBeLessThan(1);
  });

  it("leaves the circle whole for a centred feature and wraps north", () => {
    expect(gapAt(circleCuts([f(0, R)], 0, 0, R), 0)).toBe(true);
    expect(circleCuts([f(0, 0)], 0, 0, R)).toEqual([]);
    const north = circleCuts([f(-0.1, R)], 0, 0, R);
    expect(north).toHaveLength(1);
    expect(gapAt(north, 359)).toBe(true);
    expect(gapAt(north, 5)).toBe(true);
  });

  it("follows a larger circle and scales the cut with the document factor", () => {
    expect(circleCuts([f(R, 0)], 0, 0, 3.75)).toEqual([]);
    const big = circleCuts([f(3.75, 0)], 0, 0, 3.75, 1.5);
    expect(big).toHaveLength(1);
    // Same angular width as the reference: radius and cut both × 1.5.
    expect(big[0].end - big[0].start).toBeCloseTo(circleCuts([f(R, 0)], 0, 0, R)[0].end - circleCuts([f(R, 0)], 0, 0, R)[0].start, 9);
  });
});

describe("legGaps", () => {
  const A = f(0, 0), B = f(40, 0);

  it("gaps the leg around a feature on the line", () => {
    const gaps = legGaps(A, B, [f(20, 0.3)], R);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].from).toBeLessThan(0.5);
    expect(gaps[0].to).toBeGreaterThan(0.5);
    expect((gaps[0].to - gaps[0].from) * 40).toBeLessThan(1);
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
    expect(cutFeaturesOfDocument(doc).sort(byX)).toEqual([f(-5, 2.5), f(3, 3), f(10, 20)]);
  });

  it("is today's CUT_SYMBOLS set", () => {
    expect([...CUT_CODES].sort()).toEqual([109, 110, 203, 204, 205, 207]);
  });
});
