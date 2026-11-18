/**
 * The image-texture loader (J6; docs/map-rendering.md §5.2 "Images"): bytes from `print.png`
 * only, a PNG as stored and an SVG at the print's raster box, the kiosk key, the offline store
 * on a network failure, unpremultiplied decoding under the size cap, the budget, failures.
 */
import { describe, expect, it, vi } from "vitest";
import { svgRasterBox as printSvgRasterBox } from "@oxygen/shared/print";
import { GraphicTextures, svgRasterBox } from "../graphic-textures";

interface FakeBitmap { width: number; height: number; closed: boolean; close(): void; opts: ImageBitmapOptions }
const bitmap = (width: number, height: number, opts: ImageBitmapOptions): FakeBitmap => ({ width, height, closed: false, opts, close() { this.closed = true; } });

function setup(routes: Record<string, number | [number, number] | "offline">, opts: { store?: Record<string, ArrayBuffer>; budgetBytes?: number; maxPx?: number; kioskKey?: string } = {}) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const r = routes[url];
    if (r === "offline" || r === undefined) throw new TypeError("network");
    if (typeof r === "number") return new Response(null, { status: r });
    return new Response(new Blob([JSON.stringify(r)]), { status: 200 });
  });
  const decoded: FakeBitmap[] = [];
  const decode = vi.fn(async (blob: Blob, o: ImageBitmapOptions) => {
    const [w, h] = JSON.parse(await blob.text()) as [number, number];
    const b = bitmap(o.resizeWidth ?? w, o.resizeHeight ?? h, o);
    decoded.push(b);
    return b as unknown as ImageBitmap;
  });
  const store = { getGraphic: vi.fn(async (url: string) => opts.store?.[url] ?? null) };
  const g = new GraphicTextures("ev 1", { fetch, decode, store, kioskKey: opts.kioskKey, budgetBytes: opts.budgetBytes, maxPx: opts.maxPx, resizeDelayMs: 20 });
  const released: FakeBitmap[] = [];
  g.onRelease = (b) => released.push(b as unknown as FakeBitmap);
  const changes = vi.fn();
  g.onChange = changes;
  return { g, calls, decoded, released, changes, store };
}
const img = (graphicId: number, sizeUm: [number, number] = [20000, 10000], crop: [number, number, number, number] = [0, 0, 1, 1]) => ({ graphicId, sizeUm, crop });
const settle = () => new Promise((r) => setTimeout(r, 60));
const base = "/api/maps/ev%201/graphics";

describe("GraphicTextures", () => {
  it("svgRasterBox is the print's", () => {
    for (const [w, h, crop] of [[20, 10, undefined], [3, 900, { width: 0.5, height: 0.25 }], [0.01, 0.01, undefined]] as const) {
      expect(svgRasterBox(w, h, crop)).toEqual(printSvgRasterBox(w, h, crop));
    }
  });

  it("a PNG: asked once without a box with the kiosk key, decoded unpremultiplied and unconverted; loading until then", async () => {
    const t = setup({ [`${base}/7/print.png`]: [400, 200] }, { kioskKey: "k1" });
    expect(t.g.get(img(7))).toBeUndefined();
    expect(t.g.pending).toBe(1);
    await settle();
    const b = t.g.get(img(7, [1, 1])) as unknown as FakeBitmap;
    expect([b.width, b.height]).toEqual([400, 200]);
    expect(b.opts).toMatchObject({ premultiplyAlpha: "none", colorSpaceConversion: "none" });
    expect(t.calls).toEqual([{ url: `${base}/7/print.png`, headers: { "x-kiosk-key": "k1" } }]);
    expect(t.changes).toHaveBeenCalled();
    expect(t.g.bytes).toBe(Math.round((400 * 200 * 16) / 3));
  });

  it("an SVG: 400 without a box, then asked at the raster box of its placed size and crop; a new size after a delay, the old texture kept until then", async () => {
    const box = svgRasterBox(20, 10, { width: 0.5, height: 1 });
    const box2 = svgRasterBox(40, 20, { width: 0.5, height: 1 });
    const t = setup({ [`${base}/9/print.png`]: 400, [`${base}/9/print.png?w=${box[0]}&h=${box[1]}`]: box, [`${base}/9/print.png?w=${box2[0]}&h=${box2[1]}`]: box2 });
    t.g.get(img(9, [20000, 10000], [0.25, 0, 0.5, 1]));
    await settle();
    t.g.get(img(9, [20000, 10000], [0.25, 0, 0.5, 1]));
    await settle();
    const first = t.g.get(img(9, [20000, 10000], [0.25, 0, 0.5, 1])) as unknown as FakeBitmap;
    expect([first.width, first.height]).toEqual(box);
    expect(t.g.get(img(9, [40000, 20000], [0.25, 0, 0.5, 1]))).toBe(first);
    await settle();
    const second = t.g.get(img(9, [40000, 20000], [0.25, 0, 0.5, 1])) as unknown as FakeBitmap;
    expect([second.width, second.height]).toEqual(box2);
    expect(t.released).toEqual([first]);
    expect(first.closed).toBe(true);
  });

  it("offline: the store's copy under the same URL; nothing stored and no network is a failure", async () => {
    const t = setup({ [`${base}/7/print.png`]: "offline" }, { store: { [`${base}/7/print.png`]: await new Blob([JSON.stringify([64, 32])]).arrayBuffer() } });
    t.g.get(img(7));
    await settle();
    expect((t.g.get(img(7)) as unknown as FakeBitmap).width).toBe(64);
    expect(t.store.getGraphic).toHaveBeenCalledWith(`${base}/7/print.png`);
  });

  it("a 404 graphic is null (failed) and asked no more", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const t = setup({ [`${base}/5/print.png`]: 404 });
    t.g.get(img(5));
    await settle();
    expect(t.g.get(img(5))).toBeNull();
    expect(t.calls).toHaveLength(1);
    expect(warn.mock.calls[0][0]).toMatch(/GRAPHIC_MISSING/);
    warn.mockRestore();
  });

  it("decoded at most maxPx on the longer side; over the budget the largest is decoded again at half size", async () => {
    const t = setup({ [`${base}/1/print.png`]: [4000, 2000], [`${base}/2/print.png`]: [100, 100] }, { maxPx: 2048, budgetBytes: textureBytes(1100, 550) + textureBytes(100, 100) });
    t.g.get(img(1));
    t.g.get(img(2));
    await settle();
    await settle();
    const b = t.g.get(img(1)) as unknown as FakeBitmap;
    expect([b.width, b.height]).toEqual([1024, 512]);
    expect((t.g.get(img(2)) as unknown as FakeBitmap).width).toBe(100);
    expect(t.g.bytes).toBeLessThanOrEqual(textureBytes(1100, 550) + textureBytes(100, 100));
    expect(t.released.map((r) => r.width)).toEqual([2048]);
  });

  it("dispose releases every texture", async () => {
    const t = setup({ [`${base}/7/print.png`]: [10, 10] });
    t.g.get(img(7));
    await settle();
    t.g.dispose();
    expect(t.released).toHaveLength(1);
    expect(t.g.get(img(7))).toBeNull();
  });
});

function textureBytes(w: number, h: number): number {
  return Math.round((w * h * 16) / 3);
}
