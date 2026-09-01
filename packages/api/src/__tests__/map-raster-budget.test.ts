import { describe, it, expect } from "vitest";
import {
  DEFAULT_RASTER_PIXEL_BUDGET,
  rasterPixelBudget,
  rasterPxPerUnit,
  evictForInsert,
  rasterCacheCap,
} from "../map-raster-budget.js";

describe("rasterPixelBudget", () => {
  it("defaults to 800M pixels when the env var is unset", () => {
    expect(rasterPixelBudget(undefined)).toBe(DEFAULT_RASTER_PIXEL_BUDGET);
    expect(rasterPixelBudget("")).toBe(DEFAULT_RASTER_PIXEL_BUDGET);
  });

  it("honors a numeric override (Cloud Run sets a smaller budget)", () => {
    expect(rasterPixelBudget("200000000")).toBe(200_000_000);
  });

  it("rejects garbage and implausibly small values", () => {
    expect(rasterPixelBudget("lots")).toBe(DEFAULT_RASTER_PIXEL_BUDGET);
    expect(rasterPixelBudget("-5")).toBe(DEFAULT_RASTER_PIXEL_BUDGET);
    expect(rasterPixelBudget("0")).toBe(DEFAULT_RASTER_PIXEL_BUDGET);
    // Below 1M pixels a map would be unusable — treat as misconfiguration.
    expect(rasterPixelBudget("999999")).toBe(DEFAULT_RASTER_PIXEL_BUDGET);
  });

  it("floors fractional values", () => {
    expect(rasterPixelBudget("1500000.75")).toBe(1_500_000);
  });
});

describe("rasterPxPerUnit", () => {
  it("keeps the ideal 1 px/unit when the map fits the budget", () => {
    // 10k × 10k OCAD units = 100M px < 800M budget.
    expect(rasterPxPerUnit(10_000, 10_000, 800_000_000)).toBe(1);
  });

  it("scales down so the raster hits exactly the budget", () => {
    // 40k × 40k = 1.6G px ideal; budget 400M → scale = sqrt(400M/1.6G) = 0.5.
    const px = rasterPxPerUnit(40_000, 40_000, 400_000_000);
    expect(px).toBeCloseTo(0.5, 10);
    expect(px * 40_000 * (px * 40_000)).toBeCloseTo(400_000_000, 0);
  });

  it("a tighter budget yields a proportionally smaller raster", () => {
    const big = rasterPxPerUnit(40_000, 40_000, 800_000_000);
    const small = rasterPxPerUnit(40_000, 40_000, 200_000_000);
    expect(small).toBeCloseTo(big / 2, 10);
  });
});

describe("rasterCacheCap", () => {
  it("defaults to 4 cached event bitmaps", () => {
    expect(rasterCacheCap(undefined)).toBe(4);
    expect(rasterCacheCap("")).toBe(4);
  });

  it("honors a numeric override down to 1", () => {
    expect(rasterCacheCap("1")).toBe(1);
    expect(rasterCacheCap("2")).toBe(2);
  });

  it("rejects garbage and values below 1", () => {
    expect(rasterCacheCap("0")).toBe(4);
    expect(rasterCacheCap("nope")).toBe(4);
    expect(rasterCacheCap("-3")).toBe(4);
  });
});

describe("evictForInsert", () => {
  it("evicts oldest entries until an insert stays within the cap", () => {
    const cache = new Map<bigint, string>([
      [1n, "a"],
      [2n, "b"],
      [3n, "c"],
    ]);
    evictForInsert(cache, 3);
    expect([...cache.keys()]).toEqual([2n, 3n]);
  });

  it("evicts everything when the cap is 1 (Cloud Run single-map mode)", () => {
    const cache = new Map<bigint, string>([
      [1n, "a"],
      [2n, "b"],
    ]);
    evictForInsert(cache, 1);
    expect(cache.size).toBe(0);
  });

  it("does nothing while there is room", () => {
    const cache = new Map<bigint, string>([[1n, "a"]]);
    evictForInsert(cache, 3);
    expect(cache.size).toBe(1);
  });
});
