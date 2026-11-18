/**
 * Image textures for the map engine (J6; docs/map-rendering.md §5.2
 * "Images"): an image pass's graphic as an `ImageBitmap` the renderer
 * uploads. One loader per `VectorMapLayer` (textures belong to one GL
 * context).
 *
 * - **Bytes** come only from `print.png` (docs/course-print.md §8.5): the
 *   browser never rasterises SVG. A graphic is first asked without a box;
 *   a PNG answers as stored, an SVG answers 400 (it needs `w` / `h`) and is
 *   then asked at the print's raster box of its placed size
 *   (`svgRasterBox`, course-print.md §6.3). The answer is remembered per
 *   graphic for the loader's life.
 * - **Offline** (course-print.md §8.6): a request the network refuses is
 *   read from the offline print store under the same URL (never written
 *   here; storing stays with `prepareOfflinePrint`).
 * - **Decoded** unpremultiplied and without colour conversion, as the text
 *   atlas is, and at most `maxPx` (2048) on the longer side.
 * - **Budget**: the decoded bytes with mip chains (× 4/3) are held under
 *   `budgetBytes` (64 MiB), apart from the map's budget: over it, the
 *   largest texture is decoded again at half size until the set fits. An
 *   image is never dropped for the budget.
 * - An SVG whose placed size changes keeps drawing its last texture
 *   (stretched) and is asked at the new box `resizeDelayMs` after the last
 *   change, so a drag makes no request per frame.
 *
 * States per request: `undefined` loading, `null` failed (no graphic, a
 * refused request, an undecodable answer), else the bitmap.
 */

import type { ImageDraw } from "../map-gl/buckets";
import { graphicUrl, type OfflinePrintStore } from "../print/offline-store";

/** `svgRasterBox` (shared/print, course-print.md §6.3) — the web may not import the print module at runtime; a test keeps the two equal. */
export const SVG_RASTER_DPI = 600;
export const SVG_RASTER_MAX_PX = 4096;
export function svgRasterBox(widthMm: number, heightMm: number, crop?: { width: number; height: number }): [number, number] {
  const px = (mm: number, frac: number) => Math.max(1, Math.round(((mm / frac) / 25.4) * SVG_RASTER_DPI));
  let w = px(widthMm, crop?.width ?? 1), h = px(heightMm, crop?.height ?? 1);
  const k = Math.min(1, SVG_RASTER_MAX_PX / Math.max(w, h));
  w = Math.max(1, Math.round(w * k));
  h = Math.max(1, Math.round(h * k));
  return [w, h];
}

export const GRAPHIC_TEXTURE_MAX_PX = 2048;
export const GRAPHIC_BUDGET_BYTES = 64 * 1024 * 1024;
/** Below this longer side the budget does not halve a texture further. */
const MIN_SHRINK_PX = 64;

export interface GraphicTextureDeps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** `createImageBitmap`; the options are always unpremultiplied and unconverted. */
  decode: (blob: Blob, opts: ImageBitmapOptions) => Promise<ImageBitmap>;
  /** The offline print store to read on a network failure; null none. */
  store?: Pick<OfflinePrintStore, "getGraphic"> | null;
  kioskKey?: string | null;
  budgetBytes?: number;
  maxPx?: number;
  resizeDelayMs?: number;
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
  probing?: Promise<void>;
  /** PNG: the one texture; SVG: the texture of `box`. */
  tex?: Texture | null;
  /** SVG: the box `tex` was rasterised at, the box asked now, and the delayed request. */
  box?: string;
  want?: string;
  timer?: ReturnType<typeof setTimeout>;
  loading?: boolean;
}

const textureBytes = (w: number, h: number) => Math.round((w * h * 4 * 4) / 3);

export class GraphicTextures {
  /** Called when a texture arrives or changes: the host redraws. */
  onChange: (() => void) | undefined;
  /** Called with a bitmap the loader no longer holds (replaced or disposed): the renderer frees its texture. */
  onRelease: ((bitmap: ImageBitmap) => void) | undefined;
  private readonly entries = new Map<number, Entry>();
  private readonly budget: number;
  private readonly maxPx: number;
  private readonly delay: number;
  private disposed = false;
  private shrinking = false;

  private readonly nameId: string;
  private readonly deps: GraphicTextureDeps;

  constructor(nameId: string, deps: GraphicTextureDeps) {
    this.nameId = nameId;
    this.deps = deps;
    this.budget = deps.budgetBytes ?? GRAPHIC_BUDGET_BYTES;
    this.maxPx = deps.maxPx ?? GRAPHIC_TEXTURE_MAX_PX;
    this.delay = deps.resizeDelayMs ?? 250;
  }

  /** Decoded bytes held (with mip chains). */
  get bytes(): number {
    let n = 0;
    for (const e of this.entries.values()) n += e.tex?.bytes ?? 0;
    return n;
  }

  /** Requests in flight or waiting. */
  get pending(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.probing || e.loading || e.timer) n++;
    return n;
  }

  /** The texture an image draws with; starts or updates its load. */
  get(img: Pick<ImageDraw, "graphicId" | "sizeUm" | "crop">): ImageBitmap | null | undefined {
    if (this.disposed) return null;
    let e = this.entries.get(img.graphicId);
    if (!e) {
      e = {};
      this.entries.set(img.graphicId, e);
      this.probe(img.graphicId, e);
    }
    if (e.kind === "failed") return null;
    if (e.kind === "svg") {
      const [w, h] = svgRasterBox(img.sizeUm[0] / 1000, img.sizeUm[1] / 1000, { width: img.crop[2], height: img.crop[3] });
      this.wantBox(img.graphicId, e, `${w}x${h}`);
    }
    if (e.tex === null) return null;
    return e.tex?.bitmap;
  }

  dispose(): void {
    this.disposed = true;
    for (const e of this.entries.values()) {
      if (e.timer) clearTimeout(e.timer);
      if (e.tex) this.release(e.tex);
    }
    this.entries.clear();
  }

  private headers(): Record<string, string> {
    return this.deps.kioskKey ? { "x-kiosk-key": this.deps.kioskKey } : {};
  }

  /** The answer for `url`: the network's, else the offline store's on a network failure; null when neither has it. */
  private async bytesOf(url: string): Promise<{ status: number; blob?: Blob }> {
    try {
      const res = await this.deps.fetch(url, { headers: this.headers() });
      if (!res.ok) return { status: res.status };
      return { status: 200, blob: await res.blob() };
    } catch {
      const stored = await this.deps.store?.getGraphic(url).catch(() => null);
      return stored ? { status: 200, blob: new Blob([stored], { type: "image/png" }) } : { status: 0 };
    }
  }

  private probe(id: number, e: Entry): void {
    e.probing = (async () => {
      const r = await this.bytesOf(graphicUrl(this.nameId, id));
      if (this.disposed) return;
      if (r.blob) {
        e.kind = "png";
        e.tex = await this.decode(r.blob);
      } else if (r.status === 400) {
        e.kind = "svg";
        // Offline the probe cannot tell: an SVG stored at some box is found when its box is asked.
      } else if (r.status === 0) {
        e.kind = "svg";
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

  private wantBox(id: number, e: Entry, box: string): void {
    if (e.want === box || (!e.want && e.box === box)) return;
    e.want = box;
    if (e.timer) clearTimeout(e.timer);
    // The first box is asked at once; a change waits for the size to settle.
    const delay = e.tex === undefined && !e.loading ? 0 : this.delay;
    e.timer = setTimeout(() => {
      e.timer = undefined;
      void this.loadBox(id, e, box);
    }, delay);
  }

  private async loadBox(id: number, e: Entry, box: string): Promise<void> {
    e.loading = true;
    const [w, h] = box.split("x").map(Number);
    try {
      const r = await this.bytesOf(graphicUrl(this.nameId, id, [w, h]));
      if (this.disposed || e.want !== box) return;
      const tex = r.blob ? await this.decode(r.blob) : null;
      if (this.disposed || e.want !== box) {
        if (tex) tex.bitmap.close();
        return;
      }
      if (!tex) console.warn(`[vector-map] GRAPHIC_MISSING: graphic ${id} at ${box}: print.png ${r.status}`);
      if (e.tex) this.release(e.tex);
      e.tex = tex;
      e.box = box;
      e.want = undefined;
    } catch (err) {
      console.warn(`[vector-map] GRAPHIC_MISSING: graphic ${id} at ${box}:`, err);
      if (e.want === box) {
        if (e.tex) this.release(e.tex);
        e.tex = null;
        e.box = box;
        e.want = undefined;
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
    } catch (err) {
      console.warn("[vector-map] GRAPHIC_MISSING: undecodable graphic:", err);
      return null;
    }
    const size: [number, number] = natural ?? [bitmap.width, bitmap.height];
    const longer = Math.max(bitmap.width, bitmap.height);
    if (longer > limitPx) {
      const k = limitPx / longer;
      const resizeWidth = Math.max(1, Math.round(bitmap.width * k)), resizeHeight = Math.max(1, Math.round(bitmap.height * k));
      bitmap.close();
      bitmap = await this.deps.decode(blob, { ...base, resizeWidth, resizeHeight, resizeQuality: "high" });
    }
    return { blob, natural: size, bitmap, bytes: textureBytes(bitmap.width, bitmap.height) };
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
            if (!t || Math.max(t.bitmap.width, t.bitmap.height) / 2 < MIN_SHRINK_PX) continue;
            if (!worst || t.bytes > worst.tex!.bytes) worst = e;
          }
          if (!worst) return;
          const old = worst.tex!;
          const half = Math.floor(Math.max(old.bitmap.width, old.bitmap.height) / 2);
          const next = await this.decode(old.blob, old.natural, half);
          if (this.disposed) { next?.bitmap.close(); return; }
          if (!next || worst.tex !== old) { next?.bitmap.close(); continue; }
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
