import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mapDocument } from "@oxygen/shared";
import {
  loadMapDocument,
  MAP_DOCUMENT_PATH_RE,
  MapDocumentError,
  MEMORY_ENTRIES,
  requestPersistentStorage,
  resetMapDocumentCache,
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
