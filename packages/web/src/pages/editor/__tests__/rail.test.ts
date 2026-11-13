import { describe, it, expect } from "vitest";
import { AREA_CHOICES, AREA_KEYS, areaChoiceOfKey, CORRIDOR_KEY, isCorridorKey, railKeyOf } from "../tools/rail";

describe("the A menu's keys (docs/course-editor.md §6.4)", () => {
  it("picks area kinds by their chord key, either case", () => {
    expect(areaChoiceOfKey("w")).toBe("whiteout");
    expect(areaChoiceOfKey("R")).toBe("marked_route");
    expect(areaChoiceOfKey("Q")).toBeNull();
  });

  it("Corridor on selected leg has its own key, no area kind's (§6.7)", () => {
    expect(isCorridorKey("c")).toBe(true);
    expect(isCorridorKey("C")).toBe(true);
    expect(isCorridorKey("O")).toBe(false);
    expect(AREA_CHOICES.map((c) => AREA_KEYS[c])).not.toContain(CORRIDOR_KEY);
    expect(areaChoiceOfKey(CORRIDOR_KEY)).toBeNull();
  });
});

describe("railKeyOf (docs/course-editor.md §2)", () => {
  it("lights the armed placement tool's key, X for the map exchange (§6.9)", () => {
    const place = (tool: "start" | "control" | "finish" | "crossing" | "exchange") => railKeyOf({ kind: "place", chain: { tool, insertAt: null, anchorId: null, placed: [] } });
    expect(["start", "control", "finish", "crossing", "exchange"].map((x) => place(x as Parameters<typeof place>[0]))).toEqual(["S", "K", "M", "C", "X"]);
  });
});
