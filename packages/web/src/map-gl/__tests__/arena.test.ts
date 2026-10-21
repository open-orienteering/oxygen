import { describe, it, expect } from "vitest";
import { RangeAllocator } from "../arena";

describe("RangeAllocator (04 §6.8 point 1)", () => {
  it("allocates first fit and accounts used units exactly", () => {
    const a = new RangeAllocator(100);
    expect(a.alloc(30)).toBe(0);
    expect(a.alloc(20)).toBe(30);
    expect(a.used).toBe(50);
    expect(a.alloc(60)).toBe(-1);
    expect(a.alloc(50)).toBe(50);
    expect(a.used).toBe(100);
    expect(a.freeRanges()).toEqual([]);
  });

  it("coalesces freed neighbours and reuses the hole", () => {
    const a = new RangeAllocator(100);
    const x = a.alloc(10), y = a.alloc(10), z = a.alloc(10);
    a.release(x, 10);
    a.release(z, 10);
    expect(a.freeRanges()).toEqual([{ offset: 0, size: 10 }, { offset: 20, size: 80 }]);
    a.release(y, 10);
    expect(a.freeRanges()).toEqual([{ offset: 0, size: 100 }]);
    expect(a.used).toBe(0);
    expect(a.alloc(15)).toBe(0);
  });

  it("grows by appending free space, merging with a free tail", () => {
    const a = new RangeAllocator(10);
    a.alloc(4);
    a.grow(20);
    expect(a.capacity).toBe(20);
    expect(a.freeRanges()).toEqual([{ offset: 4, size: 16 }]);
    a.alloc(16);
    a.grow(25);
    expect(a.freeRanges()).toEqual([{ offset: 20, size: 5 }]);
    expect(a.alloc(5)).toBe(20);
  });

  it("zero-size requests are free", () => {
    const a = new RangeAllocator(0);
    expect(a.alloc(0)).toBe(0);
    a.release(0, 0);
    expect(a.used).toBe(0);
  });
});
