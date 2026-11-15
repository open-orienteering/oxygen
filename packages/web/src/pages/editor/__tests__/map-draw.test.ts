/**
 * Map mode's drawing reducers (docs/course-editor.md §13 "Drawing"): the add of a point, a line and an area in
 * document units, through `applyPatch` with no issue; the minimums.
 */

import { describe, expect, it } from "vitest";
import { mapDocument } from "@oxygen/shared";
import { ringsOfCoords } from "../../../lib/editor/geometry-edit";
import { drawOp, minNodes, pathCoords, pointCoords } from "../modes/map/draw";
import { patchOf, pinnedDoc } from "./map-fixture";

const ID = "0190a000-0000-7000-8000-000000000002";

const applied = (op: mapDocument.PatchOp) => mapDocument.applyPatch(pinnedDoc(), mapDocument.mergePatch(patchOf([]), { put: [op] }));

describe("drawOp", () => {
  it("a point: one coordinate rounded to units, angle only when set", () => {
    expect(pointCoords({ x: 12.345, y: 6.789 }, 100)).toEqual([[1235, 679]]);
    expect(drawOp(ID, "point", { doc: 2 }, 100, { at: { x: 1, y: 2 } })).toEqual({ op: "add", id: ID, type: 1, symbol: { doc: 2 }, coords: [[100, 200]] });
    expect(drawOp(ID, "point", { doc: 3 }, 100, { at: { x: 1, y: 2 }, angle: 450 })?.angle).toBe(450);
    expect(applied(drawOp(ID, "point", { doc: 2 }, 100, { at: { x: 1, y: 2 } })!).issues).toEqual([]);
  });

  it("a line of straight and curved nodes: Bézier pairs, no close; applies as a line", () => {
    const vertices = [{ x: 0, y: 0 }, { x: 10, y: 0, hIn: { x: -2, y: 0 }, hOut: { x: 2, y: 0 } }, { x: 20, y: 10 }];
    const coords = pathCoords(vertices, "line", 100);
    expect(coords[0]).toEqual([0, 0]);
    expect(coords.at(-1)).toEqual([2000, 1000]);
    expect(coords.some((c) => c[2] === 1)).toBe(true);
    const op = drawOp(ID, "line", { doc: 1 }, 100, { vertices })!;
    expect(op.type).toBe(2);
    const { document: doc, issues } = applied(op);
    expect(issues).toEqual([]);
    expect(doc.attrs.type[4]).toBe(2);
    // Round trip through the node adapter: the same nodes come back.
    const rings = ringsOfCoords(op.coords, 100, false)!;
    expect(rings).toHaveLength(1);
    expect(rings[0].vertices.map(({ x, y }) => [x, y])).toEqual([[0, 0], [10, 0], [20, 10]]);
  });

  it("an area: closed with the first point repeated; applies as an area", () => {
    const vertices = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
    expect(pathCoords(vertices, "area", 100)).toEqual([[0, 0], [1000, 0], [1000, 1000], [0, 0]]);
    const op = drawOp(ID, "area", { doc: 0 }, 100, { vertices })!;
    expect(op.type).toBe(3);
    expect(applied(op).issues).toEqual([]);
    expect(ringsOfCoords(op.coords, 100, true)![0]).toMatchObject({ closed: true, repeatsFirst: true });
  });

  it("below the minimum nothing; a point's geometry for a line kind nothing", () => {
    expect([minNodes("line"), minNodes("area")]).toEqual([2, 3]);
    expect(drawOp(ID, "line", { doc: 1 }, 100, { vertices: [{ x: 0, y: 0 }] })).toBeNull();
    expect(drawOp(ID, "area", { doc: 0 }, 100, { vertices: [{ x: 0, y: 0 }, { x: 1, y: 0 }] })).toBeNull();
    expect(drawOp(ID, "line", { doc: 1 }, 100, { at: { x: 0, y: 0 } })).toBeNull();
    expect(drawOp(ID, "point", { doc: 2 }, 100, { vertices: [{ x: 0, y: 0 }] })).toBeNull();
  });
});
