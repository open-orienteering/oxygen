import { describe, expect, it } from "vitest";
import { LruCache } from "../course-maps/lru-cache.js";

describe("LruCache", () => {
  it("promotes hits and evicts the least recently used entry", () => {
    const cache = new LruCache<string>(2);
    cache.set("a", "A");
    cache.set("b", "B");
    expect(cache.get("a")).toBe("A");
    cache.set("c", "C");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("A");
    expect(cache.get("c")).toBe("C");
  });

  it("also evicts entries when the byte budget is exceeded", () => {
    const cache = new LruCache<Buffer>(10, 5, (value) => value.byteLength);
    cache.set("a", Buffer.alloc(3));
    cache.set("b", Buffer.alloc(3));
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toHaveLength(3);
  });
});
