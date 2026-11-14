import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mapDocument } from "@oxygen/shared";
import {
  getMapPatch,
  loadMapDocument,
  loadMapPatch,
  MAP_DOCUMENT_PATH_RE,
  MapDocumentError,
  MEMORY_ENTRIES,
  NO_PATCH,
  parseMapPatchDelivery,
  refreshMapPatch,
  requestPersistentStorage,
  resetMapDocumentCache,
  resetMapPatches,
  setMapPatch,
  subscribeMapPatch,
} from "../map-document-cache";

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
