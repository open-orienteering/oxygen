import { describe, it, expect } from "vitest";
import { slimObject } from "../event-map-objects.js";

/**
 * `slimObject` is the filter that decides what the description autodetect
 * can ever see. The parsing itself belongs to `ocad2geojson` (covered by
 * the integration test against the real fixture); what matters here is
 * that nothing unsearchable slips through and that geometry survives.
 */
describe("slimObject", () => {
  const coord = (x: number, y: number) => [x, y] as unknown as ArrayLike<number>;

  it("keeps a mapped point object with its bbox", () => {
    const slim = slimObject({ sym: 204000, objType: 1, coordinates: [coord(100, 200)] });
    expect(slim).toEqual({
      sym: 204000,
      objType: 1,
      coordinates: [[100, 200]],
      bbox: [100, 200, 100, 200],
    });
  });

  it("computes the bbox of a polyline", () => {
    const slim = slimObject({
      sym: 505000,
      objType: 2,
      coordinates: [coord(0, 0), coord(300, -50), coord(100, 400)],
    });
    expect(slim!.bbox).toEqual([0, -50, 300, 400]);
  });

  it("drops symbols with no description meaning", () => {
    // Contour, course overprint control circle.
    expect(slimObject({ sym: 101000, objType: 2, coordinates: [coord(0, 0)] })).toBeNull();
    expect(slimObject({ sym: 702000, objType: 1, coordinates: [coord(0, 0)] })).toBeNull();
  });

  it("drops text and rectangle object types", () => {
    for (const objType of [4, 5, 6, 7]) {
      expect(slimObject({ sym: 204000, objType, coordinates: [coord(0, 0)] })).toBeNull();
    }
  });

  it("drops objects with no usable coordinates", () => {
    expect(slimObject({ sym: 204000, objType: 1, coordinates: [] })).toBeNull();
    expect(
      slimObject({
        sym: 204000,
        objType: 1,
        coordinates: [coord(Number.NaN, 0)],
      }),
    ).toBeNull();
  });

  it("keeps only the outer ring of an area with holes", () => {
    const hole = (x: number, y: number) =>
      Object.assign([x, y] as unknown as ArrayLike<number>, {
        isFirstHolePoint: () => true,
      });
    const slim = slimObject({
      sym: 521000,
      objType: 3,
      coordinates: [coord(0, 0), coord(100, 0), coord(100, 100), hole(20, 20), coord(40, 20)],
    });
    expect(slim!.coordinates).toEqual([
      [0, 0],
      [100, 0],
      [100, 100],
    ]);
    expect(slim!.bbox).toEqual([0, 0, 100, 100]);
  });

  it("flattens Bezier segments onto the drawn curve instead of keeping the handles", () => {
    const bez1 = (x: number, y: number) =>
      Object.assign([x, y] as unknown as ArrayLike<number>, { isFirstBezier: () => true });
    const bez2 = (x: number, y: number) =>
      Object.assign([x, y] as unknown as ArrayLike<number>, { isSecondBezier: () => true });
    // A path from (0,0) to (1000,0) bowing north: handles 800 units above
    // the chord. The drawn curve peaks at 0.75 × 800 = 600 — never at the
    // handle height, and never at the handle x positions' raw values.
    const slim = slimObject({
      sym: 505000,
      objType: 2,
      coordinates: [coord(0, 0), bez1(0, 800), bez2(1000, 800), coord(1000, 0)],
    });
    expect(slim).not.toBeNull();
    const ys = slim!.coordinates.map((c) => c[1]);
    expect(Math.max(...ys)).toBeCloseTo(600, 0);
    expect(slim!.coordinates[0]).toEqual([0, 0]);
    expect(slim!.coordinates.at(-1)).toEqual([1000, 0]);
    // 1 anchor + 8 flattened steps.
    expect(slim!.coordinates).toHaveLength(9);
    expect(slim!.bbox[3]).toBeCloseTo(600, 0);
  });

  it("keeps a lone Bezier-flagged vertex when the segment is incomplete", () => {
    const bez1 = (x: number, y: number) =>
      Object.assign([x, y] as unknown as ArrayLike<number>, { isFirstBezier: () => true });
    const slim = slimObject({
      sym: 505000,
      objType: 2,
      coordinates: [coord(0, 0), bez1(50, 50)],
    });
    expect(slim!.coordinates).toEqual([
      [0, 0],
      [50, 50],
    ]);
  });
});
