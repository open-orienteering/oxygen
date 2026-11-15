import { describe, expect, it } from "vitest";
import { render } from "@oxygen/shared";
import {
  coordsOfRings, deleteVertex, dragGrip, insertVertex, retractHandles, ringsOfCoords, smoothHandles, toggleSmooth, type DocCoord,
} from "../geometry-edit";

const F = render.COORD_FLAG;
const U = 100; // document units per mm (OCAD's 0.01 mm)

describe("document coordinates ↔ path vertices (docs/course-editor.md §13 \"Nodes\")", () => {
  it("a straight open line: paper mm vertices, back to the same coordinates", () => {
    const coords: DocCoord[] = [[0, 0], [100, 0], [100, 250]];
    const rings = ringsOfCoords(coords, U, false)!;
    expect(rings).toHaveLength(1);
    expect(rings[0].closed).toBe(false);
    expect(rings[0].vertices).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 2.5 }]);
    expect(coordsOfRings(rings, U)).toEqual(coords);
  });

  it("a cubic segment: its two control points become the ends' handles, and back", () => {
    const coords: DocCoord[] = [[0, 0], [0, 100, F.bezierFirst], [100, 100, F.bezierSecond], [100, 0], [200, 0]];
    const [ring] = ringsOfCoords(coords, U, false)!;
    expect(ring.vertices).toEqual([{ x: 0, y: 0, hOut: { x: 0, y: 1 } }, { x: 1, y: 0, hIn: { x: 0, y: 1 } }, { x: 2, y: 0 }]);
    expect(coordsOfRings([ring], U)).toEqual(coords);
  });

  it("a control point on its own anchor is kept (a zero-length handle written back as it was)", () => {
    const coords: DocCoord[] = [[0, 0], [0, 0, F.bezierFirst], [100, 100, F.bezierSecond], [100, 0]];
    const [ring] = ringsOfCoords(coords, U, false)!;
    // The zero-length end is no handle (as the edits drop one); the segment stays a curve by the other.
    expect(ring.vertices[0].hOut).toBeUndefined();
    expect(ring.vertices[1].hIn).toEqual({ x: 0, y: 1 });
    expect(coordsOfRings([ring], U)).toEqual(coords);
  });

  it("an area with a hole: two closed rings, the hole flag on the hole's first point only, and back", () => {
    const coords: DocCoord[] = [
      [0, 0], [1000, 0], [1000, 1000], [0, 1000],
      [200, 200, F.hole], [400, 200], [400, 400], [200, 400],
    ];
    const rings = ringsOfCoords(coords, U, true)!;
    expect(rings.map((r) => [r.closed, r.vertices.length])).toEqual([[true, 4], [true, 4]]);
    expect(rings[1].vertices[0]).toEqual({ x: 2, y: 2 });
    expect(coordsOfRings(rings, U)).toEqual(coords);
  });

  it("other anchor flags (dash, corner, gap, no-left) ride on their vertex through the edits", () => {
    const coords: DocCoord[] = [[0, 0], [100, 0, F.dash], [200, 0, F.corner | F.noLeft], [300, 0, F.gap]];
    const [ring] = ringsOfCoords(coords, U, false)!;
    expect(ring.vertices.map((v) => v.flags ?? 0)).toEqual([0, F.dash, F.corner | F.noLeft, F.gap]);
    const edited = retractHandles(dragGrip(smoothHandles(ring.vertices, 1, false), 1, "out", { x: 0.5, y: 0.5 }, false), 2);
    expect(edited.map((v) => v.flags ?? 0)).toEqual([0, F.dash, F.corner | F.noLeft, F.gap]);
    // An inserted vertex has none; its neighbours keep theirs (a curve's split too).
    const straight = insertVertex(edited, false, 2, 0.5);
    expect(straight.map((v) => v.flags ?? 0)).toEqual([0, F.dash, F.corner | F.noLeft, 0, F.gap]);
    const curved = insertVertex(edited, false, 1, 0.5);
    expect(curved.map((v) => v.flags ?? 0)).toEqual([0, F.dash, 0, F.corner | F.noLeft, F.gap]);
    expect(coordsOfRings([{ ...ring, vertices: deleteVertex(edited, 3, 2)! }], U).map((c) => c[2] ?? 0)).toEqual(
      [0, F.bezierFirst, F.bezierSecond, F.dash, F.bezierFirst, F.bezierSecond, F.corner | F.noLeft],
    );
  });

  it("a ring that repeats its first point at the end is closed; the repeat is written back from the first vertex", () => {
    const coords: DocCoord[] = [[0, 0], [1000, 0], [1000, 1000], [0, 1000], [0, 0]];
    const [ring] = ringsOfCoords(coords, U, false)!;
    expect(ring.closed).toBe(true);
    expect(ring.repeatsFirst).toBe(true);
    expect(ring.vertices).toHaveLength(4);
    expect(coordsOfRings([ring], U)).toEqual(coords);
    // Vertex 0 deleted: the ring starts and ends on the old second vertex.
    const out = coordsOfRings([{ ...ring, vertices: deleteVertex(ring.vertices, 0, 3)! }], U);
    expect(out).toEqual([[1000, 0], [1000, 1000], [0, 1000], [1000, 0]]);
  });

  it("a hole ring's first vertex deleted: the hole flag moves to the new first point", () => {
    const coords: DocCoord[] = [
      [0, 0], [1000, 0], [1000, 1000], [0, 1000],
      [200, 200, F.hole], [400, 200], [400, 400], [200, 400],
    ];
    const rings = ringsOfCoords(coords, U, true)!;
    rings[1] = { ...rings[1], vertices: deleteVertex(rings[1].vertices, 0, 3)! };
    expect(coordsOfRings(rings, U).slice(4)).toEqual([[400, 200, F.hole], [400, 400], [200, 400]]);
  });

  it("a curved closing segment (written out to the repeated first point) is the first vertex's in-handle and the last's out-handle", () => {
    const coords: DocCoord[] = [[0, 0], [1000, 0], [1000, 1000], [500, 1500, F.bezierFirst], [-500, 500, F.bezierSecond], [0, 0]];
    const [ring] = ringsOfCoords(coords, U, true)!;
    expect(ring.vertices).toHaveLength(3);
    expect(ring.vertices[2].hOut).toEqual({ x: -5, y: 5 });
    expect(ring.vertices[0].hIn).toEqual({ x: -5, y: 5 });
    expect(coordsOfRings([ring], U)).toEqual(coords);
  });

  it("an area ring closed implicitly whose closing segment becomes curved gains the written-out close", () => {
    const coords: DocCoord[] = [[0, 0], [1000, 0], [1000, 1000], [0, 1000]];
    const [ring] = ringsOfCoords(coords, U, true)!;
    const smooth = toggleSmooth(ring.vertices, 0, true)!;
    const out = coordsOfRings([{ ...ring, vertices: smooth }], U);
    expect(out.at(-1)).toEqual([0, 0]);
    expect(out.at(-2)?.[2]).toBe(F.bezierSecond);
    // Read back, it is the same path (within the unit the handles were rounded to).
    const back = ringsOfCoords(out, U, true)![0];
    expect(back.vertices).toHaveLength(4);
    const near = (a: { x: number; y: number } | undefined, b: { x: number; y: number } | undefined) =>
      expect(!!a && !!b && Math.abs(a.x - b.x) <= 1 / U && Math.abs(a.y - b.y) <= 1 / U).toBe(true);
    near(back.vertices[0].hIn, smooth[0].hIn);
    near(back.vertices[0].hOut, smooth[0].hOut);
    expect(back.vertices.slice(1).every((v) => !v.hIn && !v.hOut)).toBe(true);
  });

  it("the repeated end point's own flags are kept, none included (not the first point's)", () => {
    const dash: DocCoord[] = [[0, 0, F.corner], [1000, 0], [1000, 1000], [0, 0, F.dash]];
    expect(coordsOfRings(ringsOfCoords(dash, U, true)!, U)).toEqual(dash);
    const plain: DocCoord[] = [[0, 0, F.corner], [1000, 0], [1000, 1000], [0, 0], [200, 200, F.hole], [400, 200], [400, 400], [200, 200]];
    expect(coordsOfRings(ringsOfCoords(plain, U, true)!, U)).toEqual(plain);
  });

  it("a control point's own bits (no-left, no-right) are kept and ride with its handle through the edits", () => {
    const coords: DocCoord[] = [
      [0, 0, F.noLeft], [0, 100, F.bezierFirst | F.noLeft], [100, 100, F.bezierSecond | F.noRight], [100, 0, F.noRight], [200, 0],
    ];
    const [ring] = ringsOfCoords(coords, U, false)!;
    expect(coordsOfRings([ring], U)).toEqual(coords);
    // A grip dragged and the far vertex moved: the bits stay on their control points.
    const edited = dragGrip(ring.vertices, 0, "out", { x: 0.5, y: 1 }, false).map((v, i) => (i === 2 ? { ...v, x: 3 } : v));
    expect(coordsOfRings([{ ...ring, vertices: edited }], U).map((c) => c[2] ?? 0)).toEqual(
      [F.noLeft, F.bezierFirst | F.noLeft, F.bezierSecond | F.noRight, F.noRight, 0],
    );
  });

  it("a closed ring's curved close repeated at the end: its in-control's bits go with the first vertex's in-handle", () => {
    const coords: DocCoord[] = [[0, 0], [1000, 0], [1000, 1000], [500, 1500, F.bezierFirst | F.noLeft], [-500, 500, F.bezierSecond | F.noRight], [0, 0]];
    const [ring] = ringsOfCoords(coords, U, true)!;
    expect(coordsOfRings([ring], U)).toEqual(coords);
  });

  it("vertices moved off the unit grid are rounded to whole units", () => {
    const [ring] = ringsOfCoords([[0, 0], [100, 0]], U, false)!;
    const moved = ring.vertices.map((v) => ({ ...v, x: v.x + 0.123456 }));
    expect(coordsOfRings([{ ...ring, vertices: moved }], U)).toEqual([[12, 0], [112, 0]]);
  });

  it("a malformed curve (a lone control point, a path starting on one) is not editable", () => {
    expect(ringsOfCoords([[0, 0], [0, 100, F.bezierFirst], [100, 0]], U, false)).toBeNull();
    expect(ringsOfCoords([[0, 0, F.bezierFirst], [0, 100, F.bezierSecond], [100, 0]], U, false)).toBeNull();
    expect(ringsOfCoords([[0, 0], [0, 100, F.bezierFirst], [100, 100, F.bezierSecond]], U, false)).toBeNull();
    expect(ringsOfCoords([], U, false)).toBeNull();
  });
});
