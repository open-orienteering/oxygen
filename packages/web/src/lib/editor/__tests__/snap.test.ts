import { describe, expect, it } from "vitest";
import { mapDocument, render } from "@oxygen/shared";
import { SNAP_MM, nearestOnLines, nearestOnPath, snapIndexOf } from "../snap";

const T = mapDocument.OBJECT_TYPE;
const B1 = render.COORD_FLAG.bezierFirst, B2 = render.COORD_FLAG.bezierSecond;

/** A hand-built decoded document: OCAD units (100 per mm). */
function doc(objects: { type: number; symbol?: number; coords: number[]; flags?: number[] }[], hidden: number[] = []) {
  const coordStart = new Uint32Array(objects.length + 1);
  const coords: number[] = [], flags: number[] = [];
  objects.forEach((o, i) => {
    coordStart[i] = coords.length / 2;
    coords.push(...o.coords.map((v) => v * 100));
    flags.push(...(o.flags ?? o.coords.filter((_, j) => j % 2 === 0).map(() => 0)));
  });
  coordStart[objects.length] = coords.length / 2;
  return {
    header: { unitsPerMm: 100, symbols: [0, 1, 2].map((i) => ({ hidden: hidden.includes(i) })) } as unknown as mapDocument.MapDocumentHeader,
    attrs: { symbolIdx: Uint16Array.from(objects.map((o) => o.symbol ?? 0)), type: Uint8Array.from(objects.map((o) => o.type)) } as mapDocument.ObjectAttrs,
    coords: Int32Array.from(coords),
    flags: Uint8Array.from(flags),
    coordStart,
  };
}

describe("snapping (docs/course-editor.md §6.2)", () => {
  it("snaps to a point object's centre within 0.5 mm, not beyond", () => {
    const index = snapIndexOf(doc([{ type: T.point, coords: [10, 10] }]));
    expect(index.nearest({ x: 10.3, y: 10.2 })).toEqual({ x: 10, y: 10 });
    expect(index.nearest({ x: 10 + SNAP_MM + 0.01, y: 10 })).toBeNull();
  });

  it("snaps to line and area vertices, never to Bézier control points", () => {
    const index = snapIndexOf(doc([
      { type: T.line, coords: [0, 0, 1, 1, 2, 1, 3, 0], flags: [0, B1, B2, 0] },
      { type: T.area, coords: [20, 0, 22, 0, 22, 2] },
    ]));
    expect(index.nearest({ x: 1, y: 1 })).toBeNull();
    expect(index.nearest({ x: 2.9, y: 0.1 })).toEqual({ x: 3, y: 0 });
    expect(index.nearest({ x: 21.8, y: 1.9 })).toEqual({ x: 22, y: 2 });
  });

  it("the nearest candidate wins, across grid cells", () => {
    const index = snapIndexOf(doc([{ type: T.point, coords: [3.9, 0] }, { type: T.point, coords: [4.2, 0] }]));
    expect(index.nearest({ x: 4.1, y: 0 })).toEqual({ x: 4.2, y: 0 });
  });

  it("texts and hidden symbols do not snap", () => {
    const index = snapIndexOf(doc([{ type: T.text, coords: [5, 5] }, { type: T.point, symbol: 1, coords: [6, 6] }], [1]));
    expect(index.size).toBe(0);
  });

  it("reads the effective document: a hidden object does not snap, a modified or added one snaps where the patch puts it (map-patches §2.4)", () => {
    const base = mapDocument.decodeMapDocument(mapDocument.encodeMapDocument({
      header: {
        format: { version: 1, importer: "test-1" },
        source: { kind: "ocad", version: "2018.8.3", hash: "00".repeat(32), bytes: 1 },
        unitsPerMm: 100, mapScale: 15000, georeferencing: { crs: null, paperOrigin: null },
        colours: [{ id: "src:0", name: "Black", cmyk: [0, 0, 0, 1] }],
        symbols: [{ code: "204.0", name: "Boulder", kind: "point", render: null }],
      },
      objects: [
        { symbolIdx: 0, type: T.point, sourceIndex: 1, coords: [1000, 1000], flags: [0] },
        { symbolIdx: 0, type: T.point, sourceIndex: 2, coords: [2000, 2000], flags: [0] },
      ],
    }));
    const eff = mapDocument.applyPatch(base, {
      documentHash: "ab".repeat(32), enabled: true, symbols: {},
      ops: {
        "hide:1": { op: "hide", sourceIndex: 1 },
        "modify:2": { op: "modify", sourceIndex: 2, coords: [[2500, 2500]] },
        "add:00000000-0000-7000-8000-000000000001": { op: "add", id: "00000000-0000-7000-8000-000000000001", type: T.point, symbol: { doc: 0 }, coords: [[4000, 4000]] },
      },
    }).document;
    const index = snapIndexOf(eff);
    expect(index.nearest({ x: 10, y: 10 })).toBeNull();
    expect(index.nearest({ x: 20, y: 20 })).toBeNull();
    expect(index.nearest({ x: 25.1, y: 25 })).toEqual({ x: 25, y: 25 });
    expect(index.nearest({ x: 40, y: 40.1 })).toEqual({ x: 40, y: 40 });
    expect(index.size).toBe(2);
  });
});

describe("the nearest point on a line (§6.2; row G28)", () => {
  const all = () => true;
  const H = render.COORD_FLAG.hole;

  it("finds the nearest point inside a segment, within reach and not beyond; the reach is inclusive", () => {
    const d = doc([{ type: T.line, coords: [0, 0, 10, 0, 10, 10] }]);
    const hit = nearestOnLines(d, { x: 4, y: 1 }, 1.5, all)!;
    expect(hit.object).toBe(0);
    expect(hit.point.x).toBeCloseTo(4, 9);
    expect(hit.point.y).toBeCloseTo(0, 9);
    expect(hit.distanceMm).toBeCloseTo(1, 9);
    expect(hit.ends).toEqual([{ x: 0, y: 0 }, { x: 10, y: 10 }]);
    expect(nearestOnLines(d, { x: 4, y: 1.5 }, 1.5, all)).not.toBeNull();
    expect(nearestOnLines(d, { x: 4, y: 1.51 }, 1.5, all)).toBeNull();
  });

  it("only lines whose symbol passes the filter; points, areas and texts are never lines", () => {
    const d = doc([
      { type: T.point, coords: [0, 0] },
      { type: T.area, coords: [0, 0, 5, 0, 5, 5] },
      { type: T.text, coords: [0, 0.5] },
      { type: T.line, symbol: 1, coords: [0, 1, 5, 1] },
      { type: T.line, symbol: 2, coords: [0, 1.2, 5, 1.2] },
    ]);
    expect(nearestOnLines(d, { x: 2, y: 0 }, 1.5, all)!.object).toBe(3);
    expect(nearestOnLines(d, { x: 2, y: 0 }, 1.5, (s) => s === 2)!.object).toBe(4);
    expect(nearestOnLines(d, { x: 2, y: 0 }, 1.5, () => false)).toBeNull();
  });

  it("hidden symbols and the skipped object are not candidates; a tie goes to the lower index", () => {
    const d = doc([{ type: T.line, symbol: 1, coords: [0, 1, 5, 1] }, { type: T.line, coords: [0, -1, 5, -1] }, { type: T.line, coords: [0, 1, 5, 1] }], [1]);
    expect(nearestOnLines(d, { x: 2, y: 0 }, 1.5, all)!.object).toBe(1);
    expect(nearestOnLines(d, { x: 2, y: 0 }, 1.5, all, 1)!.object).toBe(2);
  });

  it("a Bézier line is measured on its curve; the ends are those of the part hit", () => {
    // A quarter-circle-like cubic from (0,0) to (10,10) bulging towards (10,0); then a second part.
    const d = doc([{ type: T.line, coords: [0, 0, 5.523, 0, 10, 4.477, 10, 10, 20, 0, 30, 0], flags: [0, B1, B2, 0, H, 0] }]);
    const curve = render.makePath([0, 0, 5523, 0, 10000, 4477, 10000, 10000], [0, B1, B2, 0]);
    const mid = render.flattenRings(curve, 0.1)[0];
    const k = Math.floor(mid.length / 4) * 2;
    const on = { x: mid[k] / 1000, y: mid[k + 1] / 1000 };
    const hit = nearestOnLines(d, { x: on.x + 0.3, y: on.y - 0.3 }, 1.5, all)!;
    expect(Math.hypot(hit.point.x - on.x, hit.point.y - on.y)).toBeLessThan(0.02);
    expect(hit.ends).toEqual([{ x: 0, y: 0 }, { x: 10, y: 10 }]);
    expect(nearestOnLines(d, { x: 25, y: 1 }, 1.5, all)!.ends).toEqual([{ x: 20, y: 0 }, { x: 30, y: 0 }]);
  });

  it("reads the effective document: a hidden line is not found, an added one is", () => {
    const base = mapDocument.decodeMapDocument(mapDocument.encodeMapDocument({
      header: {
        format: { version: 1, importer: "test-1" },
        source: { kind: "ocad", version: "2018.8.3", hash: "00".repeat(32), bytes: 1 },
        unitsPerMm: 100, mapScale: 15000, georeferencing: { crs: null, paperOrigin: null },
        colours: [{ id: "src:0", name: "Black", cmyk: [0, 0, 0, 1] }],
        symbols: [{ code: "801.0", name: "Track", kind: "line", render: null }],
      },
      objects: [{ symbolIdx: 0, type: T.line, sourceIndex: 1, coords: [0, 0, 1000, 0], flags: [0, 0] }],
    }));
    const eff = mapDocument.applyPatch(base, {
      documentHash: "ab".repeat(32), enabled: true, symbols: {},
      ops: {
        "hide:1": { op: "hide", sourceIndex: 1 },
        "add:00000000-0000-7000-8000-000000000001": { op: "add", id: "00000000-0000-7000-8000-000000000001", type: T.line, symbol: { doc: 0 }, coords: [[0, 5000], [1000, 5000]] },
      },
    }).document;
    expect(nearestOnLines(eff, { x: 5, y: 1 }, 1.5, all)).toBeNull();
    expect(nearestOnLines(eff, { x: 5, y: 49 }, 1.5, all)!.object).toBe(1);
    // The bounding-box reject does not drop a line within reach of its box's edge.
    expect(nearestOnLines(eff, { x: 11.4, y: 50 }, 1.5, all)!.distanceMm).toBeCloseTo(1.4, 9);
  });

  it("nearestOnPath: one line not in the document, in its units", () => {
    const hit = nearestOnPath([[0, 0], [1000, 0]], 100, { x: 3, y: -1 }, 1.5)!;
    expect(hit.object).toBe(-1);
    expect(hit.point).toEqual({ x: 3, y: 0 });
    expect(nearestOnPath([[0, 0], [1000, 0]], 100, { x: 3, y: -2 }, 1.5)).toBeNull();
  });
});
