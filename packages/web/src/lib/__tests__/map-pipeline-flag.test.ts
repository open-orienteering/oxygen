import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  MAP_PIPELINE_KEY,
  readMapPipelineFlag,
  resolveMapPipeline,
  setMapPipelineFlag,
} from "../feature-flags";

describe("map pipeline flag (until B5's events.map_pipeline)", () => {
  // The lib test environment is node — provide a minimal localStorage.
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
  });
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("defaults to legacy", () => {
    expect(readMapPipelineFlag()).toBe("legacy");
  });

  it("reads vector and ignores anything else", () => {
    store.set(MAP_PIPELINE_KEY, "vector");
    expect(readMapPipelineFlag()).toBe("vector");
    store.set(MAP_PIPELINE_KEY, "VECTOR");
    expect(readMapPipelineFlag()).toBe("legacy");
    store.set(MAP_PIPELINE_KEY, "1");
    expect(readMapPipelineFlag()).toBe("legacy");
  });

  it("round-trips through the setter", () => {
    setMapPipelineFlag("vector");
    expect(store.get(MAP_PIPELINE_KEY)).toBe("vector");
    setMapPipelineFlag("legacy");
    expect(store.has(MAP_PIPELINE_KEY)).toBe(false);
  });

  it("stays legacy when localStorage throws", () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => {
        throw new Error("denied");
      },
    };
    expect(readMapPipelineFlag()).toBe("legacy");
  });

  it("resolves to legacy without a pinned document", () => {
    expect(resolveMapPipeline("vector", null)).toBe("legacy");
    expect(resolveMapPipeline("vector", undefined)).toBe("legacy");
    expect(resolveMapPipeline("vector", "a".repeat(64))).toBe("vector");
    expect(resolveMapPipeline("legacy", "a".repeat(64))).toBe("legacy");
  });
});
