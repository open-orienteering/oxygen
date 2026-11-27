import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mapDocument } from "@oxygen/shared";
import {
  getMapPatch,
  isMapDocumentStored,
  loadMapDocument,
  loadMapPatch,
  MAP_DOCUMENT_PATH_RE,
  MapDocumentError,
  MEMORY_ENTRIES,
  NO_PATCH,
  parseMapPatchDelivery,
  prefetchMapDocument,
  refreshMapPatch,
  requestPersistentStorage,
  resetMapDocumentCache,
  resetMapPatches,
  setMapPatch,
  storagePersisted,
  subscribeMapPatch,
} from "../map-document-cache";
import { MemoryCaches } from "../../print/__tests__/memory-caches";

const HASH = "ab".repeat(32);

function documentBytes(): ArrayBuffer {
  const u8 = mapDocument.encodeMapDocument({
    header: {
      format: { version: 1, importer: "test-1" },
      source: { kind: "ocad", version: "2018.8.3", hash: "00".repeat(32), bytes: 1 },
      unitsPerMm: 100,
      mapScale: 10000,
      georeferencing: { crs: { authority: "EPSG", code: 3006, name: "SWEREF99 TM" }, paperOrigin: { x: 679000, y: 6575000 }, gridRotationDeg: 2 },
      colours: [{ id: "src:0", name: "Black", cmyk: [0, 0, 0, 1], sourceNumber: 0 }],
      symbols: [{ code: "101.0", name: "Contour", kind: "line", render: null }],
    },
    objects: [{ symbolIdx: 0, type: mapDocument.OBJECT_TYPE.line, sourceIndex: 0, coords: [0, 0, 1000, 500], flags: [0, 0] }],
  });
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

const ok = () => new Response(documentBytes(), { status: 200 });

describe("map document cache", () => {
  beforeEach(() => resetMapDocumentCache());
  afterEach(() => vi.unstubAllGlobals());

  it("matches the document route only, not previews", () => {
    expect(MAP_DOCUMENT_PATH_RE.test(`/api/map-documents/${HASH}`)).toBe(true);
    expect(MAP_DOCUMENT_PATH_RE.test(`/api/map-documents/${HASH}/thumbnail.png`)).toBe(false);
    expect(MAP_DOCUMENT_PATH_RE.test(`/api/map-documents/${HASH}/symbols/0.png`)).toBe(false);
    expect(MAP_DOCUMENT_PATH_RE.test(`/api/map-documents/${HASH.toUpperCase()}`)).toBe(false);
    expect(MAP_DOCUMENT_PATH_RE.test("/api/map-tile-progress")).toBe(false);
  });

  it("asks the hash URL with the event and kiosk key as headers, never in the query", async () => {
    const fetchImpl = vi.fn(async () => ok());
    const doc = await loadMapDocument(HASH, { eventId: "itest", kioskKey: "k1", fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/map-documents/${HASH}`);
    expect(init.headers).toEqual({ "x-event-id": "itest", "x-kiosk-key": "k1" });
    expect(doc.header.mapScale).toBe(10000);
    expect(doc.header.unitsPerMm).toBe(100);
  });

  it("shares one request and the same bytes between callers", async () => {
    const fetchImpl = vi.fn(async () => ok());
    const [a, b] = await Promise.all([
      loadMapDocument(HASH, { kioskKey: null, fetchImpl }),
      loadMapDocument(HASH, { kioskKey: null, fetchImpl }),
    ]);
    const c = await loadMapDocument(HASH, { kioskKey: null, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(a.bytes).toBe(b.bytes);
    expect(c.bytes).toBe(a.bytes);
  });

  it("keeps a bounded number of documents in memory", async () => {
    const fetchImpl = vi.fn(async () => ok());
    for (let i = 0; i <= MEMORY_ENTRIES; i++) await loadMapDocument(String(i).padStart(64, "0"), { kioskKey: null, fetchImpl });
    await loadMapDocument("0".repeat(64), { kioskKey: null, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(MEMORY_ENTRIES + 2);
  });

  it.each([
    [401, "unauthorised"],
    [403, "unauthorised"],
    [404, "missing"],
    [500, "failed"],
  ])("maps HTTP %i to %s and does not cache the failure", async (status, kind) => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status }));
    await expect(loadMapDocument(HASH, { kioskKey: null, fetchImpl })).rejects.toMatchObject({ kind });
    await expect(loadMapDocument(HASH, { kioskKey: null, fetchImpl })).rejects.toBeInstanceOf(MapDocumentError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reports offline when the network is gone", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const fetchImpl = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    await expect(loadMapDocument(HASH, { kioskKey: null, fetchImpl })).rejects.toMatchObject({ kind: "offline" });
  });

  it("rejects bytes that are not a map document", async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    await expect(loadMapDocument(HASH, { kioskKey: null, fetchImpl })).rejects.toMatchObject({ kind: "failed" });
  });

  it("asks for persistent storage once, after the first load", async () => {
    const persist = vi.fn(async () => true);
    vi.stubGlobal("navigator", { onLine: true, storage: { persist } });
    await loadMapDocument(HASH, { kioskKey: null, fetchImpl: async () => ok() });
    await loadMapDocument("cd".repeat(32), { kioskKey: null, fetchImpl: async () => ok() });
    expect(await requestPersistentStorage()).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("tolerates a browser without the storage API", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    expect(await requestPersistentStorage()).toBe(false);
  });
});

describe("the event's patch (docs/map-patches.md §3.3)", () => {
  beforeEach(() => resetMapPatches());
  afterEach(() => vi.unstubAllGlobals());

  const patch = { documentHash: HASH, enabled: true, ops: { "hide:3": { op: "hide", sourceIndex: 3 } }, symbols: {} };
  const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", etag: '"7"' }, ...init });

  it("asks the event's route with the kiosk key as a header, and keeps the delivery for the session", async () => {
    const fetchImpl = vi.fn(async () => json({ version: "7", patch }));
    const d = await loadMapPatch("itest", { kioskKey: "k1", fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/maps/itest/patch");
    expect(init.headers).toEqual({ "x-kiosk-key": "k1" });
    expect(d).toEqual({ version: "7", patch });
    expect(getMapPatch("itest")).toEqual(d);
  });

  it("revalidates with If-None-Match: a 304 keeps the copy, a 200 replaces it and tells subscribers", async () => {
    await loadMapPatch("itest", { kioskKey: null, fetchImpl: async () => json({ version: "7", patch }) });
    const seen = vi.fn();
    const off = subscribeMapPatch("itest", seen);
    const notModified = vi.fn(async () => new Response(null, { status: 304 }));
    expect(await loadMapPatch("itest", { kioskKey: null, fetchImpl: notModified })).toEqual({ version: "7", patch });
    expect((notModified.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toEqual({ "if-none-match": '"7"' });
    expect(seen).not.toHaveBeenCalled();
    await loadMapPatch("itest", { kioskKey: null, fetchImpl: async () => json({ version: "8", patch: { ...patch, enabled: false } }) });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(getMapPatch("itest")?.patch?.enabled).toBe(false);
    off();
    setMapPatch("itest", NO_PATCH);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("no row is the identity; a failure keeps the session's copy, else no patch; never rejects", async () => {
    expect(await loadMapPatch("a", { kioskKey: null, fetchImpl: async () => json({ version: "0", patch: null }) })).toEqual(NO_PATCH);
    expect(await loadMapPatch("b", { kioskKey: null, fetchImpl: async () => { throw new TypeError("offline"); } })).toEqual(NO_PATCH);
    expect(getMapPatch("b")).toBeUndefined();
    await loadMapPatch("c", { kioskKey: null, fetchImpl: async () => json({ version: "7", patch }) });
    expect(await loadMapPatch("c", { kioskKey: null, fetchImpl: async () => new Response("", { status: 500 }) })).toEqual({ version: "7", patch });
  });

  it("a wanted version joining a stale in-flight request asks once more; a held one asks nothing", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => json({ version: String(7 + n++), patch }));
    const stale = loadMapPatch("itest", { kioskKey: null, fetchImpl });
    const fresh = refreshMapPatch("itest", "8", { kioskKey: null, fetchImpl });
    expect((await stale).version).toBe("7");
    expect((await fresh).version).toBe("8");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(await refreshMapPatch("itest", "8", { kioskKey: null, fetchImpl })).toEqual({ version: "8", patch });
    expect(await refreshMapPatch("itest", undefined, { kioskKey: null, fetchImpl })).toEqual({ version: "8", patch });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("one request per event at a time", async () => {
    const fetchImpl = vi.fn(async () => json({ version: "7", patch }));
    await Promise.all([loadMapPatch("itest", { kioskKey: null, fetchImpl }), loadMapPatch("itest", { kioskKey: null, fetchImpl })]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("an unparseable patch is no patch, with its version kept", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(parseMapPatchDelivery({ version: "5", patch: { documentHash: "nope" } })).toEqual({ version: "5", patch: null });
    expect(parseMapPatchDelivery({ patch: null })).toBeNull();
    expect(parseMapPatchDelivery({ version: "5", patch })).toEqual({ version: "5", patch });
  });
});

describe("the app-code copy, prefetch and offline ready (map-storage.md §7.1, G17)", () => {
  beforeEach(() => resetMapDocumentCache());
  afterEach(() => vi.unstubAllGlobals());

  it("keeps a document it fetched in map-documents under the hash URL, once", async () => {
    const cacheStorage = new MemoryCaches();
    const fetchImpl = vi.fn(async () => ok());
    await loadMapDocument(HASH, { eventId: "ev", fetchImpl, cacheStorage, kioskKey: null });
    expect(cacheStorage.get("map-documents").paths()).toEqual([`/api/map-documents/${HASH}`]);
    const put = vi.spyOn(cacheStorage.get("map-documents"), "put");
    resetMapDocumentCache();
    await loadMapDocument(HASH, { eventId: "ev", fetchImpl, cacheStorage, kioskKey: null });
    expect(put).not.toHaveBeenCalled();
  });

  it("reads the stored copy back when the request fails without a response, else it is offline", async () => {
    const cacheStorage = new MemoryCaches();
    await loadMapDocument(HASH, { eventId: "ev", fetchImpl: async () => ok(), cacheStorage, kioskKey: null });
    resetMapDocumentCache();
    vi.stubGlobal("navigator", { onLine: false });
    const down = async (): Promise<Response> => { throw new TypeError("Failed to fetch"); };
    const doc = await loadMapDocument(HASH, { eventId: "ev", fetchImpl: down, cacheStorage, kioskKey: null });
    expect(doc.header.mapScale).toBe(10000);
    const other = "cd".repeat(32);
    await expect(loadMapDocument(other, { eventId: "ev", fetchImpl: down, cacheStorage, kioskKey: null })).rejects.toMatchObject({ kind: "offline" });
  });

  it("a non-200 while offline reads the stored copy too; a 403 online is still unauthorised", async () => {
    const cacheStorage = new MemoryCaches();
    await loadMapDocument(HASH, { fetchImpl: async () => ok(), cacheStorage, kioskKey: null });
    resetMapDocumentCache();
    vi.stubGlobal("navigator", { onLine: false });
    const doc = await loadMapDocument(HASH, { fetchImpl: async () => new Response("", { status: 503 }), cacheStorage, kioskKey: null });
    expect(doc.hash).toBe(HASH);
    vi.unstubAllGlobals();
    resetMapDocumentCache();
    await expect(loadMapDocument(HASH, { fetchImpl: async () => new Response("", { status: 403 }), cacheStorage, kioskKey: null })).rejects.toMatchObject({ kind: "unauthorised" });
  });

  it("prefetch stores the document without decoding it, once per hash, and not when it is stored already", async () => {
    const cacheStorage = new MemoryCaches();
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => ok());
    expect(await isMapDocumentStored(HASH, cacheStorage)).toBe(false);
    expect(await prefetchMapDocument(HASH, "ev", { fetchImpl, cacheStorage, kioskKey: null })).toBe(true);
    expect(await prefetchMapDocument(HASH, "ev", { fetchImpl, cacheStorage, kioskKey: null })).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![1]!.headers).toEqual({ "x-event-id": "ev" });
    expect(await isMapDocumentStored(HASH, cacheStorage)).toBe(true);
    resetMapDocumentCache();
    expect(await prefetchMapDocument(HASH, "ev", { fetchImpl, cacheStorage, kioskKey: null })).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("prefetch is skipped offline and when the browser saves data, and a failure is retried later", async () => {
    const cacheStorage = new MemoryCaches();
    const fetchImpl = vi.fn(async () => ok());
    vi.stubGlobal("navigator", { onLine: false });
    expect(await prefetchMapDocument(HASH, "ev", { fetchImpl, cacheStorage, kioskKey: null })).toBe(false);
    vi.stubGlobal("navigator", { onLine: true, connection: { saveData: true } });
    expect(await prefetchMapDocument(HASH, "ev", { fetchImpl, cacheStorage, kioskKey: null })).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    vi.stubGlobal("navigator", { onLine: true });
    expect(await prefetchMapDocument(HASH, "ev", { fetchImpl: async () => new Response("", { status: 500 }), cacheStorage, kioskKey: null })).toBe(false);
    expect(await prefetchMapDocument(HASH, "ev", { fetchImpl, cacheStorage, kioskKey: null })).toBe(true);
  });

  it("storagePersisted answers navigator.storage.persisted(), false without the API", async () => {
    vi.stubGlobal("navigator", { storage: { persisted: async () => true } });
    expect(await storagePersisted()).toBe(true);
    vi.stubGlobal("navigator", {});
    expect(await storagePersisted()).toBe(false);
  });
});

describe("setMapPatch: an older delivery never replaces a newer one (MAP-8)", () => {
  beforeEach(() => resetMapPatches());
  const patch = (enabled: boolean, documentHash = HASH) => ({ documentHash, enabled, ops: {}, symbols: {} }) as unknown as mapDocument.MapPatch;

  it("drops a lower version of the same document's patch, without telling subscribers", () => {
    expect(setMapPatch("ev", { version: "9", patch: patch(true) })).toBe(true);
    const seen = vi.fn();
    const off = subscribeMapPatch("ev", seen);
    expect(setMapPatch("ev", { version: "8", patch: patch(false) })).toBe(false);
    expect(getMapPatch("ev")?.version).toBe("9");
    expect(seen).not.toHaveBeenCalled();
    expect(setMapPatch("ev", { version: "10", patch: patch(false) })).toBe(true);
    expect(seen).toHaveBeenCalledTimes(1);
    off();
  });

  it("another document, no patch, or version 0 always replaces it", () => {
    setMapPatch("ev", { version: "9", patch: patch(true) });
    expect(setMapPatch("ev", { version: "3", patch: patch(true, "cd".repeat(32)) })).toBe(true);
    expect(setMapPatch("ev", NO_PATCH)).toBe(true);
    setMapPatch("ev", { version: "9", patch: patch(true) });
    expect(setMapPatch("ev", { version: "0", patch: patch(true) })).toBe(true);
  });

  it("a read answering after a newer write's reply keeps the newer copy", async () => {
    setMapPatch("ev", { version: "9", patch: patch(true) });
    const fetchImpl = async () => new Response(JSON.stringify({ version: "8", patch: patch(false) }), { status: 200, headers: { "content-type": "application/json" } });
    expect(await loadMapPatch("ev", { kioskKey: null, fetchImpl })).toEqual({ version: "9", patch: patch(true) });
  });
});
