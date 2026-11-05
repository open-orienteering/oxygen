/** Aligning the stored geometry's points with a structure's items (docs/course-layer.md §6.4). */

import { describe, expect, it } from "vitest";
import { alignPointsToItems } from "../course-structure-backfill.js";

describe("alignPointsToItems", () => {
  const points = ["start", "control", "control", "finish"];

  it("every item has a point", () => {
    expect(alignPointsToItems(points, ["start", "control", "control", "finish"])).toEqual([0, 1, 2, 3]);
  });

  it("tolerates an absent finish item (the pre-D1 importer never set it) or start item", () => {
    expect(alignPointsToItems(points, ["start", "control", "control"])).toEqual([0, 1, 2]);
    expect(alignPointsToItems(points, ["control", "control", "finish"])).toEqual([1, 2, 3]);
    expect(alignPointsToItems(points, ["control", "control"])).toEqual([1, 2]);
  });

  it("refuses a different number of controls", () => {
    expect(alignPointsToItems(points, ["start", "control", "finish"])).toBeNull();
  });
});
