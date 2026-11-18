/**
 * Reading a document frame back (docs/map-rendering.md §5.2 "Render
 * target", row I8b): an offscreen render target as the canvas has it — 4×
 * MSAA colour and depth / stencil (pattern clips need the stencil),
 * resolved into a single-sampled framebuffer — and the frame reader a
 * `VectorMapLayer` hands its host (`onFrameReader`, §5.4 "Layer").
 *
 * A read draws a view complete offscreen: `setView(view)` →
 * `whenComplete()` → `render(opts, target)` → resolve → `readPixels`, then
 * the layer's own view again. Reads are serialised; while one is in flight
 * the layer's own draws wait (`busy`), and `onIdle` asks for the draw they
 * skipped. GL rows come bottom first: the frame is flipped to top row first.
 */

import type { ViewRect } from "./buckets";
import type { DocumentRenderOptions } from "./renderer";
import type { RenderTarget } from "./view";

/** RGBA, top row first: straight into `ImageData`. */
export interface Frame {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface FrameReadOptions {
  /**
   * `false`: without the screen-only skips (glyphs under 2 px, text under 4 px em, hatch tints) — the
   * difference scan's reads, so a difference in small detail is found at overview scale (user 2026-11-18).
   * Default `true`: as the layer draws.
   */
  lod?: boolean;
}

export type FrameReader = (view: ViewRect, opts?: FrameReadOptions) => Promise<Frame>;

/** GL's bottom-first rows → top first. */
export function flipRows(px: Uint8Array, width: number, height: number): Uint8ClampedArray<ArrayBuffer> {
  const row = width * 4;
  if (px.length !== row * height) throw new Error(`flipRows: ${px.length} bytes is not ${width} × ${height} RGBA`);
  const out = new Uint8ClampedArray(px.length);
  for (let y = 0; y < height; y++) out.set(px.subarray((height - 1 - y) * row, (height - y) * row), y * row);
  return out;
}

export interface OffscreenTarget {
  target: RenderTarget;
  /** Blits the multisampled colour into the single-sampled framebuffer. */
  resolve(): void;
  /** The resolved pixels as GL has them (bottom row first). */
  read(): Uint8Array;
  dispose(): void;
}

/** An offscreen render target as the canvas has it (moved from the dev page's `target=fbo`, row I8b). */
export function offscreenTarget(gl: WebGL2RenderingContext, w: number, h: number): OffscreenTarget {
  const samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES) as number);
  const rb = (format: number, ms: boolean) => {
    const r = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, r);
    if (ms) gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, format, w, h);
    else gl.renderbufferStorage(gl.RENDERBUFFER, format, w, h);
    return r;
  };
  const colour = rb(gl.RGBA8, true), depth = rb(gl.DEPTH24_STENCIL8, true), resolved = rb(gl.RGBA8, false);
  const msaa = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, msaa);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, colour);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, depth);
  const single = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, single);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, resolved);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return {
    target: { framebuffer: msaa, width: w, height: h },
    resolve: () => {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, msaa);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, single);
      gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    },
    read: () => {
      const px = new Uint8Array(w * h * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, single);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return px;
    },
    dispose: () => {
      gl.deleteFramebuffer(msaa);
      gl.deleteFramebuffer(single);
      for (const r of [colour, depth, resolved]) gl.deleteRenderbuffer(r);
    },
  };
}

/** What a read needs of the engine. */
export interface ReadableEngine {
  setView(view: ViewRect): void;
  whenComplete(): Promise<void>;
  render(opts: DocumentRenderOptions, target?: RenderTarget): unknown;
}

/** The screen-only skips off (the renderer's `DocumentRenderOptions`; the dev page's `lod=0`). */
export const NO_LOD: Pick<DocumentRenderOptions, "minGlyphPx" | "minTextPx" | "hatchTintPx"> = { minGlyphPx: 0, minTextPx: 0, hatchTintPx: 0 };

/** Targets kept per reader: one per size, the pane's and the scan tile's. */
const MAX_TARGETS = 2;

export interface FrameReaderHandle {
  read: FrameReader;
  /** A read is in flight: the layer's own draws wait. */
  busy(): boolean;
  /** Later reads reject; the targets go. */
  dispose(): void;
}

export function createFrameReader(input: {
  engine: ReadableEngine;
  makeTarget: (w: number, h: number) => OffscreenTarget;
  /** The options the layer draws with now. */
  renderOptions: () => DocumentRenderOptions;
  /** The layer's own view, set again after each read. */
  restoreView: () => ViewRect | null;
  /** A read finished: the layer draws what it skipped. */
  onIdle: () => void;
}): FrameReaderHandle {
  const targets = new Map<string, OffscreenTarget>();
  let chain: Promise<unknown> = Promise.resolve();
  let pending = 0;
  let disposed = false;
  const targetFor = (w: number, h: number): OffscreenTarget => {
    const key = `${w}x${h}`;
    let t = targets.get(key);
    if (t) {
      targets.delete(key);
      targets.set(key, t);
      return t;
    }
    t = input.makeTarget(w, h);
    targets.set(key, t);
    while (targets.size > MAX_TARGETS) {
      const [oldKey, old] = targets.entries().next().value as [string, OffscreenTarget];
      targets.delete(oldKey);
      old.dispose();
    }
    return t;
  };
  const gone = () => new Error("frame reader disposed");
  const once = async (view: ViewRect, opts: FrameReadOptions): Promise<Frame> => {
    if (disposed) throw gone();
    try {
      input.engine.setView(view);
      await input.engine.whenComplete();
      if (disposed) throw gone();
      const t = targetFor(view.widthPx, view.heightPx);
      input.engine.render(opts.lod === false ? { ...input.renderOptions(), ...NO_LOD } : input.renderOptions(), t.target);
      t.resolve();
      return { width: view.widthPx, height: view.heightPx, data: flipRows(t.read(), view.widthPx, view.heightPx) };
    } finally {
      if (!disposed) {
        const back = input.restoreView();
        if (back) input.engine.setView(back);
      }
    }
  };
  const read: FrameReader = (view, opts = {}) => {
    if (disposed) return Promise.reject(gone());
    pending++;
    const p = chain.then(() => once(view, opts));
    chain = p.then(
      () => undefined,
      () => undefined,
    );
    return p.finally(() => {
      pending--;
      if (pending === 0 && !disposed) input.onIdle();
    });
  };
  return {
    read,
    busy: () => pending > 0,
    dispose: () => {
      disposed = true;
      for (const t of targets.values()) t.dispose();
      targets.clear();
    },
  };
}
