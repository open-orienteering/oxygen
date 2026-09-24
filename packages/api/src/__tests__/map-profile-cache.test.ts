import { beforeEach, describe, expect, it } from "vitest";
import {
  cachedProfileResolution,
  clearProfileResolutionCache,
  rememberProfileResolution,
} from "../map-profile-cache.js";

describe("map profile resolution cache", () => {
  beforeEach(() => clearProfileResolutionCache());

  it("returns undefined for an unknown key", () => {
    expect(cachedProfileResolution("nope")).toBeUndefined();
  });

  it("remembers a resolution by render key", () => {
    rememberProfileResolution("k1", {
      resolvedProfile: "issprom",
      resolvedBy: "file-colour",
    });
    expect(cachedProfileResolution("k1")).toEqual({
      resolvedProfile: "issprom",
      resolvedBy: "file-colour",
    });
  });

  it("is bounded: the oldest entry goes first", () => {
    for (let i = 0; i < 64; i++) {
      rememberProfileResolution(`k${i}`, {
        resolvedProfile: "isom",
        resolvedBy: "default",
      });
    }
    rememberProfileResolution("k-new", {
      resolvedProfile: "isom",
      resolvedBy: "scale",
    });
    expect(cachedProfileResolution("k0")).toBeUndefined();
    expect(cachedProfileResolution("k1")).toBeDefined();
    expect(cachedProfileResolution("k-new")).toBeDefined();
  });

  it("overwriting an existing key does not evict anything", () => {
    for (let i = 0; i < 64; i++) {
      rememberProfileResolution(`k${i}`, {
        resolvedProfile: "isom",
        resolvedBy: "default",
      });
    }
    rememberProfileResolution("k5", {
      resolvedProfile: "isskiom",
      resolvedBy: "file-colour",
    });
    expect(cachedProfileResolution("k0")).toBeDefined();
    expect(cachedProfileResolution("k5")?.resolvedProfile).toBe("isskiom");
  });
});
