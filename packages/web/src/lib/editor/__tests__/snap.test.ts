import { describe, expect, it } from "vitest";
import { mapDocument, render } from "@oxygen/shared";
import { SNAP_MM, snapIndexOf } from "../snap";

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
});
