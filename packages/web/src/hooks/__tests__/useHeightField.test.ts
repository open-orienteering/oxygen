import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeHeightField } from "@oxygen/shared/src/terrain/field/read.js";
import { HEIGHTFIELDS_CACHE, HeightFieldError, loadHeightField, resetHeightFields } from "../useHeightField";
import { coneField } from "../../map-gl/terrain/synthetic";
import { MemoryCaches } from "../../print/__tests__/memory-caches";

const HASH = "cd".repeat(32);
const URL1 = `/api/map-documents/${HASH}/height.bin?v=1`;

const bytes = (): ArrayBuffer => {
  const u8 = encodeHeightField(coneField());
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
};
const ok = () => new Response(bytes(), { status: 200 });

describe("loadHeightField (map-rendering.md §5.4 \"3D mode\" \"Field\")", () => {
  beforeEach(() => resetHeightFields());
  afterEach(() => vi.unstubAllGlobals());

  it("asks the descriptor's URL with the document's headers and decodes it", async () => {
    const fetchImpl = vi.fn(async () => ok());
    const f = await loadHeightField(URL1, { eventId: "itest", kioskKey: "k1", fetchImpl, cacheStorage: null });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(URL1);
    expect(init.headers).toEqual({ "x-event-id": "itest", "x-kiosk-key": "k1" });
    expect(f.header.width).toBe(coneField().header.width);
    expect(f.z).toEqual(coneField().z);
  });

  it("shares one request between callers and keeps the decoded field", async () => {
    const fetchImpl = vi.fn(async () => ok());
    const [a, b] = await Promise.all([loadHeightField(URL1, { fetchImpl, cacheStorage: null, kioskKey: null }), loadHeightField(URL1, { fetchImpl, cacheStorage: null, kioskKey: null })]);
    expect(a).toBe(b);
    expect(await loadHeightField(URL1, { fetchImpl, cacheStorage: null, kioskKey: null })).toBe(a);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps a copy that serves it offline, replacing the same document's other versions", async () => {
    const storage = new MemoryCaches();
    const old = `/api/map-documents/${HASH}/height.bin?v=0`;
    await (await storage.open(HEIGHTFIELDS_CACHE)).put(old, new Response(bytes()));
    const dem = `/api/map-documents/${HASH}/height.bin?v=0&source=ground.glo30-30m`;
    await (await storage.open(HEIGHTFIELDS_CACHE)).put(dem, new Response(bytes()));
    await loadHeightField(URL1, { fetchImpl: async () => ok(), cacheStorage: storage, kioskKey: null });
    expect(storage.get(HEIGHTFIELDS_CACHE).paths().sort()).toEqual([dem, URL1].sort());
    resetHeightFields();
    vi.stubGlobal("navigator", { onLine: false });
    const f = await loadHeightField(URL1, { fetchImpl: async () => { throw new TypeError("offline"); }, cacheStorage: storage, kioskKey: null });
    expect(f.header.width).toBe(coneField().header.width);
  });

  it("classifies failures and does not keep them", async () => {
    const fail = async (res: Response | Error) => {
      resetHeightFields();
      return loadHeightField(URL1, { fetchImpl: async () => { if (res instanceof Error) throw res; return res; }, cacheStorage: null, kioskKey: null }).then(
        () => null,
        (e: HeightFieldError) => [e.kind, e.reason],
      );
    };
    expect(await fail(new Response("", { status: 403 }))).toEqual(["unauthorised", undefined]);
    expect(await fail(new Response(JSON.stringify({ reason: "no-contours" }), { status: 404 }))).toEqual(["missing", "no-contours"]);
    expect(await fail(new Response("", { status: 503 }))).toEqual(["pending", undefined]);
    expect(await fail(new Response("", { status: 500 }))).toEqual(["failed", undefined]);
    expect(await fail(new Response(new Uint8Array([1, 2, 3]), { status: 200 }))).toEqual(["failed", undefined]);
    vi.stubGlobal("navigator", { onLine: false });
    expect(await fail(new TypeError("no network"))).toEqual(["offline", undefined]);
    vi.unstubAllGlobals();
    // a failure is not kept: the next call asks again
    resetHeightFields();
    const fetchImpl = vi.fn(async () => new Response("", { status: 503 }));
    await loadHeightField(URL1, { fetchImpl, cacheStorage: null, kioskKey: null }).catch(() => undefined);
    fetchImpl.mockImplementation(async () => ok());
    await loadHeightField(URL1, { fetchImpl, cacheStorage: null, kioskKey: null });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
