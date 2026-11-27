import { describe, expect, it } from "vitest";
import { canReloadForChunk, isChunkLoadError, shouldResetBoundary } from "../error-recovery";

function memory() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

describe("isChunkLoadError (WEB-15)", () => {
  it("recognises the browsers' failed dynamic import messages", () => {
    expect(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: http://x/assets/ResultsPage-abc.js"))).toBe(true);
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isChunkLoadError(new Error("error loading dynamically imported module"))).toBe(true);
  });
  it("does not take a render error for one", () => {
    expect(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'name')"))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });
});

describe("canReloadForChunk", () => {
  it("allows two reloads per five minutes, then none until the window passes", () => {
    const s = memory();
    expect(canReloadForChunk(s, 0)).toBe(true);
    expect(canReloadForChunk(s, 1000)).toBe(true);
    expect(canReloadForChunk(s, 2000)).toBe(false);
    expect(canReloadForChunk(s, 5 * 60_000 + 1)).toBe(true);
  });
  it("without storage it allows, and junk is ignored", () => {
    expect(canReloadForChunk(null)).toBe(true);
    const s = memory();
    s.setItem("oxygen.chunkReloads", "{bad");
    expect(canReloadForChunk(s, 0)).toBe(true);
  });
});

describe("shouldResetBoundary", () => {
  it("resets an errored boundary when its key changes, never otherwise", () => {
    expect(shouldResetBoundary("results", "runners", true)).toBe(true);
    expect(shouldResetBoundary("results", "results", true)).toBe(false);
    expect(shouldResetBoundary("results", "runners", false)).toBe(false);
  });
});

describe("canReloadBounded", () => {
  it("counts each key on its own", async () => {
    const { canReloadBounded } = await import("../error-recovery");
    const s = memory();
    expect(canReloadBounded("a", s, 0)).toBe(true);
    expect(canReloadBounded("a", s, 1)).toBe(true);
    expect(canReloadBounded("a", s, 2)).toBe(false);
    expect(canReloadBounded("b", s, 2)).toBe(true);
  });
});
