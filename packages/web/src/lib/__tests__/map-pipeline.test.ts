import { describe, it, expect } from "vitest";
import { resolveMapPipeline } from "../map-pipeline";

const HASH = "a".repeat(64);

describe("resolveMapPipeline (docs/map-pipeline-switch.md §3)", () => {
  it("draws vector only for a vector event with a pinned document", () => {
    expect(resolveMapPipeline("vector", HASH)).toBe("vector");
    expect(resolveMapPipeline("vector", null)).toBe("legacy");
    expect(resolveMapPipeline("vector", undefined)).toBe("legacy");
    expect(resolveMapPipeline("legacy", HASH)).toBe("legacy");
    expect(resolveMapPipeline(undefined, HASH)).toBe("legacy");
  });

  it("falls back to tiles without WebGL2 only while legacy is allowed", () => {
    expect(resolveMapPipeline("vector", HASH, { webgl2: false, allowLegacy: true })).toBe("legacy");
    expect(resolveMapPipeline("vector", HASH, { webgl2: false, allowLegacy: false })).toBe("vector");
    expect(resolveMapPipeline("vector", HASH, { webgl2: true, allowLegacy: true })).toBe("vector");
    expect(resolveMapPipeline("legacy", HASH, { webgl2: false, allowLegacy: false })).toBe("legacy");
  });
});
