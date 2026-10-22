import { describe, it, expect } from "vitest";
import {
  MAP_PIPELINE_SETTINGS,
  parseAllowLegacy,
  parseDefaultPipeline,
  readMapPipelineFlags,
  canSwitchTo,
} from "../map-pipeline.js";

describe("map pipeline instance flags (docs/map-pipeline-switch.md §1)", () => {
  it("names the two settings keys", () => {
    expect(MAP_PIPELINE_SETTINGS).toEqual({
      default: "map.pipeline.default",
      allowLegacy: "map.pipeline.allowLegacy",
    });
  });

  it("map.pipeline.default is legacy unless it says vector", () => {
    expect(parseDefaultPipeline(null)).toBe("legacy");
    expect(parseDefaultPipeline("legacy")).toBe("legacy");
    expect(parseDefaultPipeline("vector")).toBe("vector");
    expect(parseDefaultPipeline(" Vector ")).toBe("vector");
    expect(parseDefaultPipeline("tiles")).toBe("legacy");
  });

  it("map.pipeline.allowLegacy is true unless it says false", () => {
    expect(parseAllowLegacy(null)).toBe(true);
    expect(parseAllowLegacy("true")).toBe(true);
    expect(parseAllowLegacy("false")).toBe(false);
    expect(parseAllowLegacy(" FALSE ")).toBe(false);
    expect(parseAllowLegacy("0")).toBe(true);
  });

  it("reads both keys through the given reader", async () => {
    const store: Record<string, string> = {
      "map.pipeline.default": "vector",
      "map.pipeline.allowLegacy": "false",
    };
    const flags = await readMapPipelineFlags(async (k) => store[k] ?? null);
    expect(flags).toEqual({ defaultPipeline: "vector", allowLegacy: false });
    expect(await readMapPipelineFlags(async () => null)).toEqual({
      defaultPipeline: "legacy",
      allowLegacy: true,
    });
  });

  it("switching to legacy needs allowLegacy; vector is always allowed", () => {
    expect(canSwitchTo("vector", { defaultPipeline: "legacy", allowLegacy: false })).toBe(true);
    expect(canSwitchTo("legacy", { defaultPipeline: "vector", allowLegacy: true })).toBe(true);
    expect(canSwitchTo("legacy", { defaultPipeline: "vector", allowLegacy: false })).toBe(false);
  });
});
