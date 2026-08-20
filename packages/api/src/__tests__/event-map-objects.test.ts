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
});
