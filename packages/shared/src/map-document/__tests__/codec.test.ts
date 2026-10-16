import { describe, it, expect } from "vitest";
import {
  ATTR_BYTES,
  BBOX_BYTES,
  MAP_DOCUMENT_VERSION,
  MapDocumentFormatError,
  OBJECT_TYPE,
  decodeMapDocument,
  encodeMapDocument,
  hilbertIndex,
  mapDocumentHash,
  readMapDocumentHeader,
  type MapDocumentInput,
  type MapObjectInput,
} from "../index.js";
import { COORD_FLAG } from "../../render/pass-stream.js";

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);

const baseHeader: MapDocumentInput["header"] = {
  format: { version: 1, importer: "test-1" },
  source: { kind: "ocad", version: "2018.8.3", name: "test.ocd", hash: "00".repeat(32), bytes: 123 },
  unitsPerMm: 100,
  mapScale: 15000,
  georeferencing: { crs: { authority: "EPSG", code: 3006, name: "SWEREF99 TM" }, paperOrigin: { x: 679000, y: 6575000 }, gridRotationDeg: 4.98 },
  colours: [
    { id: "src:0", name: "Svart", cmyk: [0, 0, 0, 1], sourceNumber: 0 },
    { id: "src:3", name: "Brun", cmyk: [0, 0.56, 1, 0.18], sourceNumber: 3 },
  ],
  symbols: [
    { code: "101.0", name: "Contour", kind: "line", render: null },
    { code: "401.0", name: "Open land", kind: "area", render: { type: "area", id: "s:401", code: "401", name: "Open land", fill: 1 } },
    { code: "821.0", name: "Text", kind: "text", render: null, sourceFont: "Arial" },
  ],
};

function obj(partial: Partial<MapObjectInput> & { coords: number[] }): MapObjectInput {
  return { symbolIdx: 0, type: OBJECT_TYPE.line, sourceIndex: 0, flags: new Array(Math.floor(partial.coords.length / 2)).fill(0), ...partial };
}

const sample = (): MapDocumentInput => ({
  header: baseHeader,
  objects: [
    obj({ sourceIndex: 0, coords: [0, 0, 1000, 500, 2000, -300], flags: [0, COORD_FLAG.corner, 0] }),
    obj({
      sourceIndex: 1, symbolIdx: 1, type: OBJECT_TYPE.area, angleDeciDeg: 450,
      coords: [-5000, -5000, 5000, -5000, 5000, 5000, -5000, 5000, -1000, -1000, 1000, -1000, 0, 1000],
      flags: [0, 0, 0, 0, COORD_FLAG.hole, 0, 0],
    }),
    obj({ sourceIndex: 2, symbolIdx: 2, type: OBJECT_TYPE.text, text: "Hellasgården", coords: [8_388_607, -8_388_608] }),
    obj({ sourceIndex: 3, symbolIdx: 2, type: OBJECT_TYPE.text, text: "Hellasgården", coords: [10, 10] }),
  ],
});

describe("map document codec", () => {
  it("round-trips objects, attributes and header through bytes", () => {
    const bytes = encodeMapDocument(sample());
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("OXVM");
    const doc = decodeMapDocument(bytes);
    expect(doc.header.format.version).toBe(MAP_DOCUMENT_VERSION);
    expect(doc.header.objects.count).toBe(4);
    expect(doc.header.bounds).toEqual({ minX: -5000, minY: -8_388_608, maxX: 8_388_607, maxY: 5000 });
    expect(doc.header.strings).toEqual(["Hellasgården"]); // deduplicated
    expect(doc.header.colours[1].sourceNumber).toBe(3);
    expect(doc.header.symbols[1].render?.type).toBe("area");
    expect(doc.header.symbols[0].hidden).toBe(false); // default applied
    expect(doc.header.documentFactor).toBe(1);

    // Every source object is present once, with its data intact.
    const bySource = new Map<number, number>();
    for (let i = 0; i < 4; i++) bySource.set(doc.attrs.sourceIndex[i], i);
    expect([...bySource.keys()].sort()).toEqual([0, 1, 2, 3]);

    const area = bySource.get(1)!;
    expect(doc.attrs.type[area]).toBe(OBJECT_TYPE.area);
    expect(doc.attrs.symbolIdx[area]).toBe(1);
    expect(doc.attrs.angle[area]).toBe(450);
    expect(doc.attrs.coordCount[area]).toBe(7);
    const s = doc.coordStart[area];
    expect(Array.from(doc.coords.subarray(s * 2, (s + 7) * 2))).toEqual([-5000, -5000, 5000, -5000, 5000, 5000, -5000, 5000, -1000, -1000, 1000, -1000, 0, 1000]);
    expect(Array.from(doc.flags.subarray(s, s + 7))).toEqual([0, 0, 0, 0, COORD_FLAG.hole, 0, 0]);
    expect(Array.from(doc.bboxes.subarray(area * 4, area * 4 + 4))).toEqual([-5000, -5000, 5000, 5000]);

    const line = bySource.get(0)!;
    expect(Array.from(doc.flags.subarray(doc.coordStart[line], doc.coordStart[line + 1]))).toEqual([0, COORD_FLAG.corner, 0]);
    expect(doc.text(line)).toBeUndefined();

    const t1 = bySource.get(2)!, t2 = bySource.get(3)!;
    expect(doc.text(t1)).toBe("Hellasgården");
    expect(doc.text(t2)).toBe("Hellasgården");
    expect(Array.from(doc.coords.subarray(doc.coordStart[t1] * 2, doc.coordStart[t1] * 2 + 2))).toEqual([8_388_607, -8_388_608]);
  });

  it("writes fixed-width sections at 4-byte aligned offsets and the geometry per the directory", () => {
    const bytes = encodeMapDocument(sample());
    const { header, bodyOffset } = readMapDocumentHeader(bytes);
    expect(bodyOffset % 4).toBe(0);
    const { attrs, bboxes, geometry } = header.objects.sections;
    expect(attrs).toEqual({ offset: 0, length: 4 * ATTR_BYTES });
    expect(bboxes).toEqual({ offset: 4 * ATTR_BYTES, length: 4 * BBOX_BYTES });
    expect(geometry.offset).toBe(4 * (ATTR_BYTES + BBOX_BYTES));
    expect(bodyOffset + geometry.offset + geometry.length).toBe(bytes.byteLength);
    // Three 1-byte deltas per small coordinate: the first object's three points need ≤ 3 × 5 bytes.
    const doc = decodeMapDocument(bytes);
    const geomSizes: number[] = [];
    for (let i = 0; i < 4; i++) geomSizes.push((i + 1 < 4 ? doc.attrs.geomOffset[i + 1] : geometry.length) - doc.attrs.geomOffset[i]);
    expect(Math.max(...geomSizes)).toBeLessThanOrEqual(7 * 9);
  });

  it("orders objects along a Hilbert curve and is deterministic", () => {
    const a = encodeMapDocument(sample());
    const b = encodeMapDocument(sample());
    expect(sameBytes(a, b)).toBe(true);
    // Reversing the input order yields the same bytes (ties broken by sourceIndex).
    const reversed = sample();
    reversed.objects.reverse();
    expect(sameBytes(encodeMapDocument(reversed), a)).toBe(true);

    // Spatially close objects are adjacent in the output.
    const far = { header: baseHeader, objects: [
      obj({ sourceIndex: 0, coords: [0, 0] }),
      obj({ sourceIndex: 1, coords: [100_000, 100_000] }),
      obj({ sourceIndex: 2, coords: [10, 10] }),
      obj({ sourceIndex: 3, coords: [100_010, 100_010] }),
    ] };
    const doc = decodeMapDocument(encodeMapDocument(far));
    const order = Array.from(doc.attrs.sourceIndex);
    const pos = (s: number) => order.indexOf(s);
    expect(Math.abs(pos(0) - pos(2))).toBe(1);
    expect(Math.abs(pos(1) - pos(3))).toBe(1);
  });

  it("hilbertIndex is a bijection on a small grid", () => {
    const seen = new Set<number>();
    for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) seen.add(hilbertIndex(x, y, 3));
    expect(seen.size).toBe(64);
    expect(hilbertIndex(0, 0, 3)).toBe(0);
  });

  it("encodes an empty document", () => {
    const doc = decodeMapDocument(encodeMapDocument({ header: baseHeader, objects: [] }));
    expect(doc.header.objects.count).toBe(0);
    expect(doc.coords.length).toBe(0);
    expect(doc.header.bounds).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
  });

  it("rejects invalid input at encode time", () => {
    const bad = (o: Partial<MapObjectInput> & { coords: number[] }) => () => encodeMapDocument({ header: baseHeader, objects: [obj(o)] });
    expect(bad({ coords: [] })).toThrow(/at least one/);
    expect(bad({ coords: [1, 2, 3] })).toThrow(/at least one/);
    expect(bad({ coords: [1, 2], flags: [0, 0] })).toThrow(/flags length/);
    expect(bad({ coords: [1, 2], symbolIdx: 3 })).toThrow(/symbolIdx/);
    expect(bad({ coords: [1, 2], type: 8 })).toThrow(/type/);
    expect(bad({ coords: [1, 2], angleDeciDeg: 40000 })).toThrow(/angle/);
    expect(() => encodeMapDocument({ header: { ...baseHeader, unitsPerMm: 0 }, objects: [] })).toThrow();
  });

  it("rejects foreign, truncated and future-version files", () => {
    expect(() => readMapDocumentHeader(new TextEncoder().encode("hello"))).toThrow(MapDocumentFormatError);
    expect(() => readMapDocumentHeader(new TextEncoder().encode("not an ocad or oxvm file at all"))).toThrow(/magic/);
    const bytes = encodeMapDocument(sample());
    const future = bytes.slice();
    new DataView(future.buffer).setUint32(4, 99, true);
    expect(() => readMapDocumentHeader(future)).toThrow(/version 99/);
    expect(() => decodeMapDocument(bytes.subarray(0, bytes.byteLength - 1))).toThrow(/truncated/);
    expect(() => decodeMapDocument(bytes.subarray(0, 20))).toThrow(/truncated/);
  });

  it("decodes from an unaligned view without sharing the caller's buffer wrongly", () => {
    const bytes = encodeMapDocument(sample());
    const padded = new Uint8Array(bytes.byteLength + 1);
    padded.set(bytes, 1);
    const doc = decodeMapDocument(padded.subarray(1));
    expect(doc.header.objects.count).toBe(4);
    expect(Array.from(doc.bboxes)).toEqual(Array.from(decodeMapDocument(bytes).bboxes));
  });

  it("hashes the bytes with SHA-256", async () => {
    const hash = await mapDocumentHash(new TextEncoder().encode("abc"));
    expect(hash).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const bytes = encodeMapDocument(sample());
    expect(await mapDocumentHash(bytes)).toBe(await mapDocumentHash(encodeMapDocument(sample())));
  });
});
