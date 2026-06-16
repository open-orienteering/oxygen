import { describe, it, expect } from "vitest";
import { isOnMap, clampToMap } from "../projection-utils";

// Kotka-Jukola map dimensions, the case that motivated these guards.
const MAP_W = 3354;
const MAP_H = 4724;

describe("isOnMap", () => {
  it("accepts a position inside the map", () => {
    expect(isOnMap(1677, 2362, MAP_W, MAP_H)).toBe(true);
    expect(isOnMap(0, 0, MAP_W, MAP_H)).toBe(true);
    expect(isOnMap(MAP_W, MAP_H, MAP_W, MAP_H)).toBe(true);
  });

  it("accepts a position just past the edge (within the margin)", () => {
    expect(isOnMap(-MAP_W * 0.5, MAP_H * 1.5, MAP_W, MAP_H)).toBe(true);
  });

  it("rejects the mis-decoded coordinate from the EPSG:3067 bug", () => {
    // Before the CRS fix every waypoint projected here, ~1000 km off-map.
    expect(isOnMap(-1036056, -381454, MAP_W, MAP_H)).toBe(false);
  });

  it("rejects positions well beyond the one-map-dimension margin", () => {
    expect(isOnMap(MAP_W * 3, 0, MAP_W, MAP_H)).toBe(false);
    expect(isOnMap(0, -MAP_H * 2, MAP_W, MAP_H)).toBe(false);
  });

  it("rejects NaN / Infinity", () => {
    expect(isOnMap(NaN, 0, MAP_W, MAP_H)).toBe(false);
    expect(isOnMap(0, Infinity, MAP_W, MAP_H)).toBe(false);
  });

  it("respects a custom margin factor", () => {
    // With a zero margin only strictly-in-bounds positions pass.
    expect(isOnMap(MAP_W + 1, 0, MAP_W, MAP_H, 0)).toBe(false);
    expect(isOnMap(MAP_W, 0, MAP_W, MAP_H, 0)).toBe(true);
  });
});

describe("clampToMap", () => {
  it("leaves an in-bounds centre unchanged", () => {
    expect(clampToMap(1677, 2362, MAP_W, MAP_H)).toEqual({ cx: 1677, cy: 2362 });
  });

  it("clamps a runaway centre back onto the map", () => {
    expect(clampToMap(-1034425, -380919, MAP_W, MAP_H)).toEqual({ cx: 0, cy: 0 });
    expect(clampToMap(MAP_W * 10, MAP_H * 10, MAP_W, MAP_H)).toEqual({
      cx: MAP_W,
      cy: MAP_H,
    });
  });
});
