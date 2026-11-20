/**
 * The raster window of an SVG graphic (docs/course-print.md §6.3): the union of the crops,
 * rounded out to 1/1024, a crop relative to it, and the `crop` query parameter.
 */
import { describe, expect, it } from "vitest";
import { WINDOW_STEP, cropInWindow, isWholeWindow, unionWindow, windowParam } from "../image-window.js";

describe("image window", () => {
  it("is the union of the crops, edges rounded out to 1/1024; an uncropped placement makes it the whole graphic", () => {
    expect(unionWindow([{ x: 0.25, y: 0, width: 0.5, height: 1 }])).toEqual({ x: 0.25, y: 0, width: 0.5, height: 1 });
    expect(unionWindow([{ x: 0, y: 0, width: 0.25, height: 0.5 }, { x: 0.5, y: 0.5, width: 0.25, height: 0.5 }])).toEqual({ x: 0, y: 0, width: 0.75, height: 1 });
    const w = unionWindow([{ x: 0.1, y: 0.2, width: 0.3, height: 0.3 }])!;
    expect(w.x).toBeLessThanOrEqual(0.1);
    expect(w.x + w.width).toBeGreaterThanOrEqual(0.4);
    expect((w.x / WINDOW_STEP) % 1).toBe(0);
    expect((w.width / WINDOW_STEP) % 1).toBe(0);
    expect(unionWindow([{ x: 0.25, y: 0, width: 0.5, height: 1 }, undefined])).toBeUndefined();
    expect(unionWindow([{ x: 0, y: 0, width: 1, height: 1 }])).toBeUndefined();
    expect(unionWindow([])).toBeUndefined();
    expect(isWholeWindow(undefined)).toBe(true);
  });

  it("a crop relative to the window fills what the raster shows of it", () => {
    const window = { x: 0, y: 0, width: 0.75, height: 1 };
    expect(cropInWindow({ x: 0.5, y: 0.5, width: 0.25, height: 0.5 }, window)).toEqual({ x: 2 / 3, y: 0.5, width: 1 / 3, height: 0.5 });
    expect(cropInWindow(undefined, { x: 0.5, y: 0, width: 0.5, height: 1 })).toEqual({ x: -1, y: 0, width: 2, height: 1 });
    expect(cropInWindow({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, undefined)).toEqual({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 });
  });

  it("the query parameter is x,y,w,h in exact 1/1024 steps", () => {
    expect(windowParam({ x: 0.25, y: 0, width: 0.5, height: 1 })).toBe("0.25,0,0.5,1");
    expect(windowParam({ x: 1 / 1024, y: 0, width: 0.5, height: 1 })).toBe("0.0009765625,0,0.5,1");
  });
});
