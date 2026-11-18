import { describe, expect, it } from "vitest";
import { canSwitchOrder, chosenOrder, deviationSummary, layerLabel, layersTopFirst, orderedFlags, retryUrl } from "../map-review-colours";

describe("the colour panel's helpers (docs/map-symbols.md §8.7)", () => {
  it("lists the layers top first", () => {
    expect(layersTopFirst([{ row: 0 }, { row: 2 }, { row: 1 }]).map((l) => l.row)).toEqual([2, 1, 0]);
  });

  it("names a layer by its role, else by its place (a colour split only by place)", () => {
    expect(layerLabel({ role: "brown50-road", roleName: "Brown 50 % road infill", place: null })).toEqual({ kind: "role", name: "Brown 50 % road infill" });
    expect(layerLabel({ role: "x", roleName: null, place: null })).toEqual({ kind: "role", name: "x" });
    expect(layerLabel({ role: null, roleName: null, place: "area" })).toEqual({ kind: "place", key: "colours.layers.place.area" });
    expect(layerLabel({ role: null, roleName: null, place: "graphic" })).toEqual({ kind: "place", key: "colours.layers.place.graphic" });
    expect(layerLabel({ role: null, roleName: null, place: null })).toEqual({ kind: "place", key: "colours.layers.place.other" });
  });

  it("orders the flags and drops unknown ones", () => {
    expect(orderedFlags(["draws-nothing", "no-role", "split", "whatever"])).toEqual(["split", "no-role", "draws-nothing"]);
  });

  it("enables the switch with edit rights and a target, while no job runs", () => {
    expect(canSwitchOrder({ canEdit: true, busy: false, hasTarget: true })).toBe(true);
    expect(canSwitchOrder({ canEdit: false, busy: false, hasTarget: true })).toBe(false);
    expect(canSwitchOrder({ canEdit: true, busy: true, hasTarget: true })).toBe(false);
    expect(canSwitchOrder({ canEdit: true, busy: false, hasTarget: false })).toBe(false);
  });

  it("shows the map's setting as chosen, else the document's order", () => {
    expect(chosenOrder({ order: "iof", setting: { order: "source" } })).toBe("source");
    expect(chosenOrder({ order: "source", setting: null })).toBe("source");
  });

  it("adds a retry counter to a picture URL, keeping its event scope", () => {
    expect(retryUrl("/api/map-documents/x/colour-order/iof.png", 0)).toBe("/api/map-documents/x/colour-order/iof.png");
    expect(retryUrl("/api/map-documents/x/colour-order/iof.png", 2)).toBe("/api/map-documents/x/colour-order/iof.png?retry=2");
    expect(retryUrl("/api/map-documents/x/colour-order/iof.png?event=e1", 1)).toBe("/api/map-documents/x/colour-order/iof.png?event=e1&retry=1");
  });

  it("summarises the deviations", () => {
    expect(deviationSummary([{ kept: true }, { kept: false }, { kept: true }])).toEqual({ count: 3, kept: 2 });
  });
});
