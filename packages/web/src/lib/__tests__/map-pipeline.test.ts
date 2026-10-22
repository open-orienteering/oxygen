import { describe, it, expect } from "vitest";
import { resolveMapPipeline } from "../map-pipeline";

describe("resolveMapPipeline (docs/map-pipeline-switch.md §3)", () => {
  it("draws vector only for a vector event with a pinned document", () => {
    expect(resolveMapPipeline("vector", "a".repeat(64))).toBe("vector");
    expect(resolveMapPipeline("vector", null)).toBe("legacy");
    expect(resolveMapPipeline("vector", undefined)).toBe("legacy");
    expect(resolveMapPipeline("legacy", "a".repeat(64))).toBe("legacy");
  });
});
