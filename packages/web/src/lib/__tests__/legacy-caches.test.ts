import { describe, it, expect, vi } from "vitest";
import { dropLegacyCaches, LEGACY_CACHE_NAMES } from "../legacy-caches";

describe("dropLegacyCaches", () => {
  it("deletes the tile cache the service worker no longer routes (E4b)", async () => {
    const del = vi.fn(async () => true);
    await dropLegacyCaches({ delete: del });
    expect(LEGACY_CACHE_NAMES).toEqual(["map-tiles"]);
    expect(del).toHaveBeenCalledWith("map-tiles");
  });

  it("does nothing without Cache Storage", async () => {
    await expect(dropLegacyCaches(undefined)).resolves.toBeUndefined();
  });

  it("logs and swallows a failing delete (private mode, blocked storage)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(dropLegacyCaches({ delete: async () => { throw new Error("SecurityError"); } })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
