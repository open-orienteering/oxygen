import { describe, it, expect } from "vitest";
import { GpuArena, RangeAllocator } from "../arena";

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

/** A WebGL2 stand-in that records buffer calls and keeps each buffer's bytes. */
function fakeGl() {
  const buffers = new Map<object, Uint8Array>();
  const bound = new Map<number, object>();
  const calls: string[] = [];
  const gl = {
    COPY_WRITE_BUFFER: 36663, COPY_READ_BUFFER: 36662, STATIC_DRAW: 35044,
    createBuffer: () => { const b = {}; buffers.set(b, new Uint8Array(0)); calls.push("create"); return b as WebGLBuffer; },
    bindBuffer: (target: number, b: object) => { bound.set(target, b); },
    bufferData: (target: number, size: number) => { buffers.set(bound.get(target)!, new Uint8Array(size)); calls.push(`data:${size}`); },
    bufferSubData: (target: number, offset: number, v: ArrayBufferView) => {
      buffers.get(bound.get(target)!)!.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength), offset);
      calls.push(`sub:${offset}:${v.byteLength}`);
    },
    copyBufferSubData: () => { calls.push("copy"); },
    deleteBuffer: (b: object) => { buffers.delete(b); calls.push("delete"); },
  };
  return { gl: gl as unknown as WebGL2RenderingContext, buffers, calls, bytes: (b: object) => buffers.get(b)! };
}

describe("GpuArena growth (bugfix-adreno-arena-grow)", () => {
  const vertices = (n: number, tag: number) => { const v = new Uint8Array(n * 4); for (let i = 0; i < v.length; i++) v[i] = (tag + i) & 255; return v; };

  it("grows by re-uploading every live range into the new buffer and never copyBufferSubData", () => {
    const f = fakeGl();
    const a = new GpuArena(f.gl, 4, 8);
    const x = vertices(5, 10), y = vertices(3, 50);
    const ax = a.put(x), ay = a.put(y);
    expect([ax, ay]).toEqual([0, 5]);
    f.calls.length = 0;
    const z = vertices(6, 90);          // does not fit in 8: grows to max(10, 14) = 14
    const az = a.put(z);
    expect(az).toBe(8);
    expect(a.generation).toBe(1);
    expect(a.alloc.capacity).toBe(14);
    expect(f.calls.filter((c) => c === "copy")).toEqual([]);
    expect(f.calls).toEqual(["create", "data:56", "sub:0:20", "sub:20:12", "delete", "sub:32:24"]);
    const gpu = f.bytes(a.buffer);
    expect([...gpu.subarray(0, 20)]).toEqual([...x]);
    expect([...gpu.subarray(20, 32)]).toEqual([...y]);
    expect([...gpu.subarray(32, 56)]).toEqual([...z]);
  });

  it("released ranges are not re-uploaded and their space is reused", () => {
    const f = fakeGl();
    const a = new GpuArena(f.gl, 4, 8);
    const x = vertices(4, 1), y = vertices(4, 2);
    a.put(x); const ay = a.put(y);
    a.release(0, 4);
    expect(a.liveRanges()).toEqual([[ay, 4]]);
    f.calls.length = 0;
    a.put(vertices(9, 3));              // grows to max(10, 17) = 17; only y re-uploaded
    expect(f.calls.filter((c) => c.startsWith("sub"))).toEqual(["sub:16:16", "sub:32:36"]);
    expect([...f.bytes(a.buffer).subarray(16, 32)]).toEqual([...y]);
    expect(a.put(vertices(4, 4))).toBe(0);   // the released hole is reused
  });
});
