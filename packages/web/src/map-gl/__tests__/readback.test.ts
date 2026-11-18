import { describe, expect, it } from "vitest";
import { createFrameReader, flipRows, NO_LOD, type OffscreenTarget, type ReadableEngine } from "../readback";
import type { ViewRect } from "../buckets";

const view = (w: number, h: number, cx = 0): ViewRect => ({ centreX: cx, centreY: 0, pxPerUm: 0.01, widthPx: w, heightPx: h, rotationDeg: 0 });

describe("flipRows", () => {
  it("turns GL's bottom-first rows top first", () => {
    // 2 × 3, each pixel's red the GL row index.
    const px = new Uint8Array(2 * 3 * 4);
    for (let y = 0; y < 3; y++) for (let x = 0; x < 2; x++) px[(y * 2 + x) * 4] = y;
    const out = flipRows(px, 2, 3);
    expect([out[0], out[4], out[8], out[12], out[16], out[20]]).toEqual([2, 2, 1, 1, 0, 0]);
    expect(out).toBeInstanceOf(Uint8ClampedArray);
  });

  it("keeps a one-row image and refuses a size mismatch", () => {
    const px = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...flipRows(px, 2, 1)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(() => flipRows(px, 3, 1)).toThrow(/RGBA/);
  });
});

/** A fake engine and targets: every call logged, `whenComplete` resolved by hand. */
function harness() {
  const log: string[] = [];
  const waiters: (() => void)[] = [];
  const engine: ReadableEngine = {
    setView: (v) => log.push(`setView ${v.widthPx}x${v.heightPx}@${v.centreX}`),
    whenComplete: () => new Promise<void>((r) => { log.push("whenComplete"); waiters.push(r); }),
    render: (opts, t) => log.push(`render ${t?.width}x${t?.height} minGlyphPx=${opts.minGlyphPx ?? "-"}`),
  };
  let made = 0;
  const disposed: string[] = [];
  const makeTarget = (w: number, h: number): OffscreenTarget => {
    made++;
    return {
      target: { framebuffer: null, width: w, height: h },
      resolve: () => log.push("resolve"),
      read: () => {
        log.push("read");
        const px = new Uint8Array(w * h * 4);
        px[0] = 9; // bottom-left in GL
        return px;
      },
      dispose: () => disposed.push(`${w}x${h}`),
    };
  };
  let idle = 0;
  const reader = createFrameReader({ engine, makeTarget, renderOptions: () => ({ colour: () => [0, 0, 0] }), restoreView: () => view(100, 50, 7), onIdle: () => idle++, timeoutMs: 50 });
  const settle = async () => {
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
      while (waiters.length) waiters.shift()!();
    }
  };
  /** Lets microtasks run without completing the engine. */
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  return { log, reader, settle, flush, made: () => made, disposed, idle: () => idle };
}

describe("createFrameReader", () => {
  it("draws the view complete offscreen, reads it top row first, and sets the layer's view again", async () => {
    const h = harness();
    const p = h.reader.read(view(2, 2, 1));
    expect(h.reader.busy()).toBe(true);
    await h.settle();
    const frame = await p;
    expect(h.log).toEqual(["setView 2x2@1", "whenComplete", "render 2x2 minGlyphPx=-", "resolve", "read", "setView 100x50@7"]);
    expect(frame.width).toBe(2);
    expect(frame.height).toBe(2);
    // GL's first pixel (bottom left) is the frame's third (row 1, column 0).
    expect(frame.data[8]).toBe(9);
    expect(h.reader.busy()).toBe(false);
    expect(h.idle()).toBe(1);
  });

  it("reads without the screen-only skips when asked", async () => {
    const h = harness();
    const p = h.reader.read(view(2, 2), { lod: false });
    await h.settle();
    await p;
    expect(h.log).toContain(`render 2x2 minGlyphPx=${NO_LOD.minGlyphPx}`);
  });

  it("never interleaves two reads, and calls idle once both are done", async () => {
    const h = harness();
    const a = h.reader.read(view(2, 2, 1));
    const b = h.reader.read(view(2, 2, 2));
    await h.settle();
    await Promise.all([a, b]);
    expect(h.log.filter((l) => l.startsWith("setView"))).toEqual(["setView 2x2@1", "setView 100x50@7", "setView 2x2@2", "setView 100x50@7"]);
    expect(h.idle()).toBe(1);
  });

  it("keeps a target per size, at most two", async () => {
    const h = harness();
    for (const [w, hh] of [[2, 2], [2, 2], [4, 4], [8, 8]] as const) {
      const p = h.reader.read(view(w, hh));
      await h.settle();
      await p;
    }
    expect(h.made()).toBe(3);
    expect(h.disposed).toEqual(["2x2"]);
  });

  it("rejects after dispose, and a read in flight does not draw", async () => {
    const h = harness();
    const p = h.reader.read(view(2, 2));
    h.reader.dispose();
    await h.settle();
    await expect(p).rejects.toThrow(/disposed/);
    expect(h.log).not.toContain("render 2x2 minGlyphPx=-");
    await expect(h.reader.read(view(2, 2))).rejects.toThrow(/disposed/);
  });

  it("rejects a read parked on its detail when disposed, without drawing", async () => {
    const h = harness();
    const p = h.reader.read(view(2, 2));
    await h.flush();
    expect(h.log).toContain("whenComplete");
    h.reader.dispose();
    await expect(p).rejects.toThrow(/disposed/);
    expect(h.log.some((l) => l.startsWith("render"))).toBe(false);
  });

  it("times out a read whose detail never comes, sets the view back and goes idle", async () => {
    const h = harness();
    const p = h.reader.read(view(2, 2));
    await expect(p).rejects.toThrow(/timed out/);
    expect(h.log.at(-1)).toBe("setView 100x50@7");
    expect(h.reader.busy()).toBe(false);
    expect(h.idle()).toBe(1);
  });

  it("rejects an aborted read before it moves the view", async () => {
    const h = harness();
    const ac = new AbortController();
    ac.abort();
    await expect(h.reader.read(view(2, 2), { signal: ac.signal })).rejects.toThrow(/aborted/);
    expect(h.log).toEqual([]);
  });
});
