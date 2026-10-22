import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const page = (name: string) => ({ version: 1, page: name, width: 8, height: 4, emPx: 32, distanceRangePx: 8, faces: [] });

/** A fresh module (its session cache empty) with `fetch` and `createImageBitmap` stubbed. */
async function setup(fail: Set<string> = new Set()) {
  vi.resetModules();
  const fetched: string[] = [];
  const bitmapOpts: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    fetched.push(url);
    if ([...fail].some((f) => url.includes(f))) return new Response("", { status: 503 });
    if (url.endsWith(".json")) return new Response(JSON.stringify(page(url.includes("cyrillic") ? "cyrillic" : "latin")));
    return new Response(new Blob([new Uint8Array(4)]));
  }));
  vi.stubGlobal("createImageBitmap", vi.fn(async (_b: Blob, opts: unknown) => {
    bitmapOpts.push(opts);
    return { width: 8, height: 4 };
  }));
  const mod = await import("../map-fonts");
  return { ...mod, fetched, bitmapOpts };
}

describe("loadTextAtlas (docs/map-rendering.md §5.2 \"Text atlas\")", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("fetches only the pages asked for, in order, decoded as data", async () => {
    const { loadTextAtlas, fetched, bitmapOpts } = await setup();
    const pages = await loadTextAtlas(["latin"]);
    expect(pages.map((p) => p.page.page)).toEqual(["latin"]);
    expect(fetched).toHaveLength(2);
    expect(fetched.every((u) => u.includes("text-atlas.latin"))).toBe(true);
    expect(bitmapOpts).toEqual([{ premultiplyAlpha: "none", colorSpaceConversion: "none" }]);
  });

  it("fetches a page once per session; Cyrillic only when asked", async () => {
    const { loadTextAtlas, fetched } = await setup();
    await loadTextAtlas(["latin"]);
    const both = await loadTextAtlas(["latin", "cyrillic"]);
    expect(both.map((p) => p.page.page)).toEqual(["latin", "cyrillic"]);
    expect(fetched.filter((u) => u.includes("latin"))).toHaveLength(2);
    expect(fetched.filter((u) => u.includes("cyrillic"))).toHaveLength(2);
  });

  it("a failed page is retried on the next call", async () => {
    const fail = new Set(["text-atlas.latin.png"]);
    const { loadTextAtlas, fetched } = await setup(fail);
    await expect(loadTextAtlas(["latin"])).rejects.toThrow(/503/);
    fail.clear();
    await expect(loadTextAtlas(["latin"])).resolves.toHaveLength(1);
    expect(fetched.filter((u) => u.endsWith(".png"))).toHaveLength(2);
  });
});
