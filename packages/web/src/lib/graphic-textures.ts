/**
 * Image textures for the map engine (J6; docs/map-rendering.md §5.2
 * "Images"): an image pass's graphic as an `ImageBitmap` the renderer
 * uploads. One loader per `VectorMapLayer` (textures belong to one GL
 * context).
 *
 * - **Bytes** come only from `print.png` (docs/course-print.md §8.5): the
 *   browser never rasterises SVG. A graphic is first asked without a box;
 *   a PNG answers as stored, an SVG answers 400 (it needs `w` / `h`) and is
 *   then asked over its **window** (the union of the crops drawn this frame,
 *   `unionWindow`; none for an uncropped placement) at the larger of the
 *   print's raster box of the window (`svgRasterBox`, course-print.md §6.3)
 *   and the window's size on screen rounded up to a power of two, at most
 *   `SVG_RASTER_MAX_PX` (4096) on the longer side and 8 MP in all
 *   (`SVG_WINDOW_MAX_PIXELS`, so one fits the budget) — so a crop of a large
 *   drawing, or a logo zoomed in, stays sharp. The box only grows while the
 *   window is unchanged (zooming out asks nothing). The answer is
 *   remembered per graphic for the loader's life.
 * - **Offline** (course-print.md §8.6): a request the network refuses is
 *   read from the offline print store under the same URL (never written
 *   here; storing stays with `prepareOfflinePrint`). An SVG box not stored
 *   falls back to the print's own box of the window, which the offline
 *   prepare stored.
 * - **Decoded** unpremultiplied and without colour conversion, as the text
 *   atlas is, and at most `maxPx` (2048) on the longer side for a PNG,
 *   `svgMaxPx` (4096) for an SVG's window.
 * - **Budget**: the decoded bytes with mip chains (× 4/3) are held under
 *   `budgetBytes` (64 MiB), apart from the map's budget: over it, the
 *   largest texture is decoded again at half size until the set fits. An
 *   image is never dropped for the budget.
 * - An SVG whose placed size changes keeps drawing its last texture
 *   (stretched) and is asked at the new box `resizeDelayMs` after the last
 *   change, so a drag makes no request per frame. An SVG drawn at several
 *   sizes in one frame is asked at the largest of them (by area), once.
 * - **Kept while drawn**: a graphic no frame has asked for in
 *   `EVICT_FRAMES` frames that drew images is dropped and its texture
 *   released (a deleted object, a switched course).
 * - **Retried**: only a definitive answer is remembered (200, 400, 404 and
 *   other 4xx). A network failure with nothing stored, a 5xx, 408 or 429 is
 *   asked again after a backoff (2 s doubling to 60 s); until then the image
 *   is loading. Offline, a graphic not stored unboxed is taken for an SVG
 *   for its box request; a miss there too is retried from the probe.
 *
 * States per request: `undefined` loading, `null` failed (no graphic, a
 * refused request, an undecodable answer), else the bitmap.
 */

import { type ImageWindow, cropInWindow, unionWindow, windowParam } from "@oxygen/shared/src/render/image-window.js";
import type { ImageDraw } from "../map-gl/buckets";
import type { WindowedTexture } from "../map-gl/renderer";
import { graphicUrl, type OfflinePrintStore } from "../print/offline-store";

/** `svgRasterBox` (shared/print, course-print.md §6.3) — the web may not import the print module at runtime; a test keeps the two equal. */
export const SVG_RASTER_DPI = 600;
export const SVG_RASTER_MAX_PX = 4096;
export function svgRasterBox(widthMm: number, heightMm: number, crop?: { width: number; height: number }): [number, number] {
  return capBox(Math.max(1, Math.round(((widthMm / (crop?.width ?? 1)) / 25.4) * SVG_RASTER_DPI)), Math.max(1, Math.round(((heightMm / (crop?.height ?? 1)) / 25.4) * SVG_RASTER_DPI)));
}

/** A box with its longer side at most `SVG_RASTER_MAX_PX`, aspect kept (`svgRasterBox`'s cap). */
function capBox(w: number, h: number): [number, number] {
  const k = Math.min(1, SVG_RASTER_MAX_PX / Math.max(w, h));
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
}

/** The box an SVG placement wants over `window`: the print's box, or its size on screen rounded up to a power of two, whichever is larger, capped. */
export function svgDrawBox(img: Pick<ImageDraw, "sizeUm" | "crop">, window: ImageWindow | undefined, pxPerUm: number | undefined): [number, number] {
  const crop = cropInWindow({ x: img.crop[0], y: img.crop[1], width: img.crop[2], height: img.crop[3] }, window)!;
  const print = svgRasterBox(img.sizeUm[0] / 1000, img.sizeUm[1] / 1000, crop);
  if (!pxPerUm || !(pxPerUm > 0)) return print;
  const sw = (img.sizeUm[0] * pxPerUm) / crop.width, sh = (img.sizeUm[1] * pxPerUm) / crop.height;
  const longer = Math.max(sw, sh);
  if (!(longer > 0) || !Number.isFinite(longer)) return print;
  const k = 2 ** Math.ceil(Math.log2(longer)) / longer;
  const screen = capBox(Math.max(1, Math.round(sw * k)), Math.max(1, Math.round(sh * k)));
  return capArea(screen[0] * screen[1] > print[0] * print[1] ? screen : print);
}

/** The most pixels an SVG window texture is asked at: 8 MP (≈ 45 MiB with mips), so one fits the 64 MiB budget undivided. */
export const SVG_WINDOW_MAX_PIXELS = 4096 * 2048;

function capArea([w, h]: [number, number]): [number, number] {
  if (w * h <= SVG_WINDOW_MAX_PIXELS) return [w, h];
  const k = Math.sqrt(SVG_WINDOW_MAX_PIXELS / (w * h));
  return [Math.max(1, Math.floor(w * k)), Math.max(1, Math.floor(h * k))];
}

/** The print's own box (the offline fallback): `svgRasterBox` of the window, uncapped by area. */
function svgPrintBox(img: Pick<ImageDraw, "sizeUm" | "crop">, window: ImageWindow | undefined): [number, number] {
  const crop = cropInWindow({ x: img.crop[0], y: img.crop[1], width: img.crop[2], height: img.crop[3] }, window)!;
  return svgRasterBox(img.sizeUm[0] / 1000, img.sizeUm[1] / 1000, crop);
}

export const GRAPHIC_TEXTURE_MAX_PX = 2048;
export const GRAPHIC_BUDGET_BYTES = 64 * 1024 * 1024;
/** Frames that drew images without asking for a graphic before it is dropped. */
export const EVICT_FRAMES = 120;
/** Below this longer side the budget does not halve a texture further. */
const MIN_SHRINK_PX = 64;
const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 60000;

export interface GraphicTextureDeps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** `createImageBitmap`; the options are always unpremultiplied and unconverted. */
  decode: (blob: Blob, opts: ImageBitmapOptions) => Promise<ImageBitmap>;
  /** The offline print store to read on a network failure; null none. */
  store?: Pick<OfflinePrintStore, "getGraphic"> | null;
  kioskKey?: string | null;
  budgetBytes?: number;
  maxPx?: number;
  /** The longer side an SVG window texture is decoded at, at most (default `SVG_RASTER_MAX_PX`). */
  svgMaxPx?: number;
  resizeDelayMs?: number;
  /** Retry backoff base, ms (tests). */
  retryBaseMs?: number;
}

type Kind = "png" | "svg" | "failed";

interface Texture {
  blob: Blob;
  /** The decoded size the source has (before the cap). */
  natural: [number, number];
  bitmap: ImageBitmap;
  bytes: number;
}

interface Entry {
  kind?: Kind;
  /** SVG taken from an offline probe miss: a box miss too starts again from the probe. */
  tentative?: boolean;
  probing?: Promise<void>;
  /** PNG: the one texture; SVG: the texture of `box`. */
  tex?: Texture | null;
  /** SVG: the request `tex` answers (`boxKey`), the request asked now, and the delayed request. */
  box?: string;
  want?: string;
  /** SVG: the window and box of `tex` (absent window = the whole graphic). */
  texWindow?: ImageWindow;
  texBox?: [number, number];
  /** SVG: the request of `want`. */
  wantReq?: SvgRequest;
  timer?: ReturnType<typeof setTimeout>;
  loading?: boolean;
  /** SVG: the placements drawn in this frame (their window and box are worked out after it). */
  asked?: { img: Pick<ImageDraw, "sizeUm" | "crop">; pxPerUm?: number }[];
  /** The frame this graphic was last asked in. */
  seen: number;
  /** Transient failures in a row, and when it may be asked again. */
  failures: number;
  retryAt?: number;
  retryTimer?: ReturnType<typeof setTimeout>;
  /** Re-decoding failed: the budget passes over it. */
  noShrink?: boolean;
}

interface SvgRequest {
  box: [number, number];
  window?: ImageWindow;
  /** The print's own box of the window: read from the offline store when `box` is not there. */
  printBox: [number, number];
}

const textureBytes = (w: number, h: number) => Math.round((w * h * 4 * 4) / 3);
const boxKey = (box: readonly [number, number], window: ImageWindow | undefined) => `${box[0]}x${box[1]}${window ? `@${windowParam(window)}` : ""}`;
const sameWindow = (a: ImageWindow | undefined, b: ImageWindow | undefined) =>
  a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);
/** A failure worth asking again: no network and nothing stored, a server error, a timeout, a rate limit. */
const transient = (status: number) => status === 0 || status >= 500 || status === 408 || status === 429;

export class GraphicTextures {
  /** Called when a texture arrives or changes: the host redraws. */
  onChange: (() => void) | undefined;
  /** Called with a bitmap the loader no longer holds (replaced, dropped or disposed): the renderer frees its texture. */
  onRelease: ((bitmap: ImageBitmap) => void) | undefined;
  private readonly entries = new Map<number, Entry>();
  private readonly budget: number;
  private readonly maxPx: number;
  private readonly svgMaxPx: number;
  private readonly delay: number;
  private readonly retryBase: number;
  private readonly nameId: string;
  private readonly deps: GraphicTextureDeps;
  private disposed = false;
  private shrinking = false;
  private frame = 0;
  private flushQueued = false;

  constructor(nameId: string, deps: GraphicTextureDeps) {
    this.nameId = nameId;
    this.deps = deps;
    this.budget = deps.budgetBytes ?? GRAPHIC_BUDGET_BYTES;
    this.maxPx = deps.maxPx ?? GRAPHIC_TEXTURE_MAX_PX;
    this.svgMaxPx = deps.svgMaxPx ?? SVG_RASTER_MAX_PX;
    this.delay = deps.resizeDelayMs ?? 250;
    this.retryBase = deps.retryBaseMs ?? RETRY_BASE_MS;
  }

  /** Decoded bytes held (with mip chains). */
  get bytes(): number {
    let n = 0;
    for (const e of this.entries.values()) n += e.tex?.bytes ?? 0;
    return n;
  }

  /** Requests in flight or waiting (a retry's backoff is not counted). */
  get pending(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.probing || e.loading || e.timer) n++;
    return n;
  }

  /**
   * The texture an image draws with (an SVG's with its window); starts or
   * updates its load. `pxPerUm` is the density it is drawn at (the screen's).
   */
  get(img: Pick<ImageDraw, "graphicId" | "sizeUm" | "crop">, pxPerUm?: number): ImageBitmap | WindowedTexture | null | undefined {
    if (this.disposed) return null;
    let e = this.entries.get(img.graphicId);
    if (!e) {
      e = { seen: this.frame, failures: 0 };
      this.entries.set(img.graphicId, e);
      this.probe(img.graphicId, e);
    }
    e.seen = this.frame;
    this.queueFlush();
    if (!e.kind && !e.probing && Date.now() >= (e.retryAt ?? 0)) this.probe(img.graphicId, e);
    if (e.kind === "failed") return null;
    if (e.kind === "svg") (e.asked ??= []).push({ img: { sizeUm: img.sizeUm, crop: img.crop }, pxPerUm });
    if (e.tex === null) return null;
    if (!e.tex) return undefined;
    const w = e.texWindow;
    return w ? { source: e.tex.bitmap, window: [w.x, w.y, w.width, w.height] } : e.tex.bitmap;
  }

  dispose(): void {
    this.disposed = true;
    for (const e of this.entries.values()) this.drop(e);
    this.entries.clear();
  }

  private drop(e: Entry): void {
    if (e.timer) clearTimeout(e.timer);
    if (e.retryTimer) clearTimeout(e.retryTimer);
    e.timer = e.retryTimer = undefined;
    if (e.tex) this.release(e.tex);
    e.tex = undefined;
  }

  /** After the frame's `get`s (a microtask): each SVG's box is the largest asked; graphics not asked lately are dropped. */
  private queueFlush(): void {
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => {
      this.flushQueued = false;
      if (this.disposed) return;
      for (const [id, e] of this.entries) {
        if (e.asked) {
          this.wantBox(id, e, this.svgRequest(e, e.asked));
          e.asked = undefined;
        }
        if (this.frame - e.seen >= EVICT_FRAMES && !e.probing && !e.loading) {
          this.drop(e);
          this.entries.delete(id);
        }
      }
      this.frame++;
    });
  }

  private headers(): Record<string, string> {
    return this.deps.kioskKey ? { "x-kiosk-key": this.deps.kioskKey } : {};
  }

  /** The answer for `url`: the network's, else the offline store's (at `url`, then `storedUrl`) on a network failure; status 0 when neither has it. */
  private async bytesOf(url: string, storedUrl?: string): Promise<{ status: number; blob?: Blob }> {
    try {
      const res = await this.deps.fetch(url, { headers: this.headers() });
      if (!res.ok) return { status: res.status };
      return { status: 200, blob: await res.blob() };
    } catch {
      const read = (u: string) => this.deps.store?.getGraphic(u).catch(() => null) ?? Promise.resolve(null);
      const stored = (await read(url)) ?? (storedUrl ? await read(storedUrl) : null);
      return stored ? { status: 200, blob: new Blob([stored], { type: "image/png" }) } : { status: 0 };
    }
  }

  /** A transient failure: forget the answer, ask again after the backoff (a redraw then asks). */
  private retryLater(e: Entry): void {
    const wait = Math.min(RETRY_MAX_MS, this.retryBase * 2 ** e.failures);
    e.failures++;
    e.retryAt = Date.now() + wait;
    if (e.retryTimer) clearTimeout(e.retryTimer);
    e.retryTimer = setTimeout(() => {
      e.retryTimer = undefined;
      if (!this.disposed) this.onChange?.();
    }, wait);
  }

  private probe(id: number, e: Entry): void {
    e.probing = (async () => {
      const r = await this.bytesOf(graphicUrl(this.nameId, id));
      if (this.disposed) return;
      e.tentative = false;
      if (r.blob) {
        const tex = await this.decode(r.blob);
        if (this.disposed) { tex?.bitmap.close(); return; }
        e.kind = "png";
        e.tex = tex;
        e.failures = 0;
      } else if (r.status === 400) {
        e.kind = "svg";
      } else if (r.status === 0) {
        // Offline and not stored unboxed: an SVG stored at some box is found when its box is asked.
        e.kind = "svg";
        e.tentative = true;
      } else if (transient(r.status)) {
        e.kind = undefined;
        this.retryLater(e);
      } else {
        e.kind = "failed";
        console.warn(`[vector-map] GRAPHIC_MISSING: graphic ${id}: print.png ${r.status}`);
      }
    })().catch((err: unknown) => {
      e.kind = "failed";
      console.warn(`[vector-map] GRAPHIC_MISSING: graphic ${id}:`, err);
    }).finally(() => {
      e.probing = undefined;
      if (this.disposed) return;
      this.onChange?.();
      this.fitBudget();
    });
  }

  /**
   * The request for an SVG's placements of a frame: the union window of their
   * crops, at the largest box one of them wants. While the window is the one
   * held (or asked), a box no larger than that one keeps it: zooming out asks
   * nothing.
   */
  private svgRequest(e: Entry, placed: NonNullable<Entry["asked"]>): SvgRequest {
    const window = unionWindow(placed.map(({ img }) => ({ x: img.crop[0], y: img.crop[1], width: img.crop[2], height: img.crop[3] })));
    let box: [number, number] = [0, 0], printBox: [number, number] = [0, 0];
    for (const p of placed) {
      const b = svgDrawBox(p.img, window, p.pxPerUm);
      if (b[0] * b[1] > box[0] * box[1]) box = b;
      const pb = svgPrintBox(p.img, window);
      if (pb[0] * pb[1] > printBox[0] * printBox[1]) printBox = pb;
    }
    const held = e.wantReq ?? (e.texBox ? { box: e.texBox, window: e.texWindow, printBox: e.texBox } : undefined);
    if (held && sameWindow(held.window, window) && held.box[0] >= box[0] && held.box[1] >= box[1]) return held;
    return { box, window, printBox };
  }

  private wantBox(id: number, e: Entry, req: SvgRequest): void {
    const box = boxKey(req.box, req.window);
    if (e.want === box || (!e.want && e.box === box)) return;
    if (Date.now() < (e.retryAt ?? 0)) return;
    e.want = box;
    e.wantReq = req;
    if (e.timer) clearTimeout(e.timer);
    // The first box is asked at once; a change waits for the size to settle.
    const delay = e.tex === undefined && !e.loading ? 0 : this.delay;
    e.timer = setTimeout(() => {
      e.timer = undefined;
      void this.loadBox(id, e, box, req);
    }, delay);
  }

  private async loadBox(id: number, e: Entry, box: string, req: SvgRequest): Promise<void> {
    e.loading = true;
    try {
      const printUrl = req.printBox[0] !== req.box[0] || req.printBox[1] !== req.box[1] ? graphicUrl(this.nameId, id, req.printBox, req.window) : undefined;
      const r = await this.bytesOf(graphicUrl(this.nameId, id, req.box, req.window), printUrl);
      if (this.disposed || e.want !== box) return;
      if (!r.blob && transient(r.status)) {
        e.want = undefined;
        e.wantReq = undefined;
        if (e.tentative) {
          // Offline and stored at neither URL: maybe a PNG; start again from the probe.
          e.kind = undefined;
          e.tentative = false;
        }
        this.retryLater(e);
        return;
      }
      const tex = r.blob ? await this.decode(r.blob, undefined, this.svgMaxPx) : null;
      if (this.disposed || e.want !== box) {
        if (tex) tex.bitmap.close();
        return;
      }
      if (!tex) console.warn(`[vector-map] GRAPHIC_MISSING: graphic ${id} at ${box}: print.png ${r.status}`);
      if (e.tex) this.release(e.tex);
      e.tex = tex;
      e.box = box;
      e.texWindow = req.window;
      e.texBox = req.box;
      e.want = undefined;
      e.wantReq = undefined;
      e.failures = 0;
      e.tentative = false;
    } catch (err) {
      console.warn(`[vector-map] GRAPHIC_MISSING: graphic ${id} at ${box}:`, err);
      if (e.want === box) {
        if (e.tex) this.release(e.tex);
        e.tex = null;
        e.box = box;
        e.texWindow = req.window;
        e.texBox = req.box;
        e.want = undefined;
        e.wantReq = undefined;
      }
    } finally {
      e.loading = false;
    }
    if (this.disposed) return;
    this.onChange?.();
    this.fitBudget();
  }

  /** Decodes at most `maxPx` (or `limitPx`) on the longer side, unpremultiplied. */
  private async decode(blob: Blob, natural?: [number, number], limitPx = this.maxPx): Promise<Texture | null> {
    const base: ImageBitmapOptions = { premultiplyAlpha: "none", colorSpaceConversion: "none" };
    let bitmap: ImageBitmap;
    try {
      bitmap = await this.deps.decode(blob, base);
      const size: [number, number] = natural ?? [bitmap.width, bitmap.height];
      const longer = Math.max(bitmap.width, bitmap.height);
      if (longer > limitPx) {
        const k = limitPx / longer;
        const resizeWidth = Math.max(1, Math.round(bitmap.width * k)), resizeHeight = Math.max(1, Math.round(bitmap.height * k));
        bitmap.close();
        bitmap = await this.deps.decode(blob, { ...base, resizeWidth, resizeHeight, resizeQuality: "high" });
      }
      return { blob, natural: size, bitmap, bytes: textureBytes(bitmap.width, bitmap.height) };
    } catch (err) {
      console.warn("[vector-map] GRAPHIC_MISSING: undecodable graphic:", err);
      return null;
    }
  }

  private release(t: Texture): void {
    this.onRelease?.(t.bitmap);
    t.bitmap.close();
  }

  /** Over the budget: the largest texture decoded again at half its longer side, until the set fits. */
  private fitBudget(): void {
    if (this.shrinking || this.disposed) return;
    this.shrinking = true;
    void (async () => {
      try {
        while (!this.disposed && this.bytes > this.budget) {
          let worst: Entry | undefined;
          for (const e of this.entries.values()) {
            const t = e.tex;
            if (!t || e.noShrink || Math.max(t.bitmap.width, t.bitmap.height) / 2 < MIN_SHRINK_PX) continue;
            if (!worst || t.bytes > worst.tex!.bytes) worst = e;
          }
          if (!worst) return;
          const old = worst.tex!;
          const half = Math.floor(Math.max(old.bitmap.width, old.bitmap.height) / 2);
          const next = await this.decode(old.blob, old.natural, half);
          if (this.disposed) { next?.bitmap.close(); return; }
          if (!next) { worst.noShrink = true; continue; }
          if (worst.tex !== old) { next.bitmap.close(); continue; }
          worst.tex = next;
          this.release(old);
          this.onChange?.();
        }
      } finally {
        this.shrinking = false;
      }
    })();
  }
}
