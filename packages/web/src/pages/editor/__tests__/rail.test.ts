import { describe, it, expect } from "vitest";
import { AREA_CHOICES, AREA_KEYS, areaChoiceOfKey, CORRIDOR_KEY, isCorridorKey } from "../tools/rail";

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
