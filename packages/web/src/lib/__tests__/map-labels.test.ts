import { describe, expect, it } from "vitest";
import { placeMapLabels } from "../map-labels";

describe("placeMapLabels: the alternatives' labels on the map (docs/course-elevation.md §7.8)", () => {
  const size = { w: 800, h: 600 };

  it("keeps labels that are apart where they are", () => {
    const out = placeMapLabels([{ id: "a", at: { x: 100, y: 100 } }, { id: "b", at: { x: 400, y: 300 } }], size);
    expect(out).toEqual([{ id: "a", at: { x: 100, y: 100 } }, { id: "b", at: { x: 400, y: 300 } }]);
  });

  it("moves an overlapping label under the one before it, the first keeping its place", () => {
    const out = placeMapLabels([{ id: "a", at: { x: 100, y: 100 } }, { id: "b", at: { x: 120, y: 105 } }, { id: "c", at: { x: 110, y: 110 } }], size);
    expect(out.map((l) => l.at.y)).toEqual([100, 122, 144]);
    expect(out.map((l) => l.at.x)).toEqual([100, 120, 110]);
  });

  it("moves a label off a handle under it, and off the next one below", () => {
    const out = placeMapLabels([{ id: "a", at: { x: 100, y: 100 } }], size, [{ x: 130, y: 104 }, { x: 60, y: 130 }, { x: 400, y: 100 }]);
    // Under the first handle (104 + 11 + 12), then under the second (130 + 23).
    expect(out[0].at).toEqual({ x: 100, y: 153 });
  });

  it("a handle beside the label's box leaves it in place", () => {
    const out = placeMapLabels([{ id: "a", at: { x: 100, y: 100 } }], size, [{ x: 100, y: 130 }, { x: 190, y: 100 }]);
    expect(out[0].at).toEqual({ x: 100, y: 100 });
  });

  it("leaves out a label whose anchor is off screen", () => {
    const out = placeMapLabels([{ id: "a", at: { x: -5, y: 100 } }, { id: "b", at: { x: 100, y: 700 } }, { id: "c", at: { x: 10, y: 10 } }], size);
    expect(out.map((l) => l.id)).toEqual(["c"]);
  });
});
