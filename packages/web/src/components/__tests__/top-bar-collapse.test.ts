import { describe, expect, it } from "vitest";
import { TIER1_PX, TIER2_PX, TOP_BAR_TIER1_HIDE, TOP_BAR_TIER2_HIDE, TOP_BAR_TIER2_SHOW } from "../top-bar-collapse";

// Tailwind reads the class strings literally, so the numbers live twice; this keeps them in step (F29).
describe("top bar collapse tiers", () => {
  it("names the toolbar container and the measured widths in every class", () => {
    expect(TOP_BAR_TIER1_HIDE).toBe(`@max-[${TIER1_PX}px]/toolbar:hidden`);
    expect(TOP_BAR_TIER2_HIDE).toBe(`@max-[${TIER2_PX}px]/toolbar:hidden`);
    expect(TOP_BAR_TIER2_SHOW).toBe(`hidden @max-[${TIER2_PX}px]/toolbar:inline-flex`);
  });

  it("drops the labels before the mode words", () => {
    expect(TIER1_PX).toBeGreaterThan(TIER2_PX);
  });
});
