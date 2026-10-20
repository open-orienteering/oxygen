import { describe, it, expect } from "vitest";
import { render } from "../../index.js";
import {
  OBJECT_TYPE,
  decodeMapDocument,
  documentRenderInput,
  encodeMapDocument,
  fromJsonProjection,
  projectBytes,
  toJsonProjection,
  type MapDocumentInput,
} from "../index.js";
import { COORD_FLAG } from "../../render/pass-stream.js";

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);

const header: MapDocumentInput["header"] = {
  format: { version: 1, importer: "test-1" },
  source: { kind: "ocad", version: "2018", hash: "ab", bytes: 1 },
  unitsPerMm: 100,
  mapScale: 10000,
  georeferencing: { crs: null, paperOrigin: null },
  colours: [{ id: "src:0", name: "Black", cmyk: [0, 0, 0, 1] }],
  symbols: [
    { code: "505.0", name: "Path", kind: "line", render: { type: "line", id: "s:505", code: "505", name: "Path", main: { colour: 0, widthUm: 250 } } },
    { code: "401.0", name: "Open", kind: "area", render: null },
    { code: "601.0", name: "North line", kind: "line", hidden: true, render: null },
    { code: "821.0", name: "Text", kind: "text", render: null },
    { code: "999.0", name: "Kind mismatch", kind: "point", render: { type: "area", id: "s:999", code: "999", name: "x", fill: 0 } },
  ],
};

const input: MapDocumentInput = {
  header,
  objects: [
    { symbolIdx: 0, type: OBJECT_TYPE.line, sourceIndex: 0, coords: [0, 0, 300, 400], flags: [0, 0] },
    { symbolIdx: 1, type: OBJECT_TYPE.area, sourceIndex: 1, angleDeciDeg: 900, coords: [0, 0, 100, 0, 100, 100], flags: [0, 0, COORD_FLAG.corner] },
    { symbolIdx: 2, type: OBJECT_TYPE.line, sourceIndex: 2, coords: [5, 5, 6, 6], flags: [0, 0] },
    { symbolIdx: 3, type: OBJECT_TYPE.text, sourceIndex: 3, text: "Hi", coords: [1, 2], flags: [0] },
    { symbolIdx: 3, type: OBJECT_TYPE.text, sourceIndex: 4, coords: [1, 2], flags: [0] }, // text object without text
    { symbolIdx: 4, type: OBJECT_TYPE.point, sourceIndex: 5, coords: [7, 7], flags: [0] },
  ],
};

describe("JSON projection", () => {
  it("projects objects as nested arrays and re-encodes to identical bytes", () => {
    const bytes = encodeMapDocument(input);
    const json = projectBytes(bytes);
    expect("objects" in json.header).toBe(false);
    expect("strings" in json.header).toBe(false);
    expect(json.objects).toHaveLength(6);
    const area = json.objects.find((o) => o.sourceIndex === 1)!;
    expect(area).toEqual({ symbol: 1, type: 3, angle: 900, sourceIndex: 1, coords: [[0, 0], [100, 0], [100, 100, COORD_FLAG.corner]] });
    const text = json.objects.find((o) => o.sourceIndex === 3)!;
    expect(text.text).toBe("Hi");
    expect(text.angle).toBeUndefined();

    const again = fromJsonProjection(json);
    expect(sameBytes(again, bytes)).toBe(true);
    // The projection survives a JSON string round trip too.
    expect(sameBytes(fromJsonProjection(JSON.parse(JSON.stringify(toJsonProjection(decodeMapDocument(bytes))))), bytes)).toBe(true);
  });
});

describe("documentRenderInput", () => {
  const doc = decodeMapDocument(encodeMapDocument(input));

  it("converts to µm, resolves render symbols and proxies the rest", () => {
    const r = documentRenderInput(doc, { proxyColours: { line: 0, area: 0, point: 0, text: 0 } });
    // symbols: 5 document entries (placeholders for null) + 4 proxies
    expect(r.symbols).toHaveLength(9);
    expect(r.symbols[0].code).toBe("505");
    expect(r.stats).toEqual({ total: 6, rendered: 1, proxied: 3, hidden: 1, dropped: 1, coordinates: 1 + 2 + 3 + 1, canonicalSymbols: 0, canonicalMissing: 0 });

    const bySym = (code: string) => r.objects.filter((o) => r.symbols[o.symbolIdx].code === code);
    const path = bySym("505")[0];
    expect(Array.from(path.path.coords)).toEqual([0, 0, 3000, 4000]);
    expect(path.path.closed).toBe(false);
    const area = bySym("proxy-area")[0];
    expect(area.path.closed).toBe(true);
    expect(area.angleDeg).toBe(90);
    expect(Array.from(area.path.flags)).toEqual([0, 0, COORD_FLAG.corner]);
    expect(bySym("proxy-text")[0].text).toBe("Hi");
    // Kind mismatch between object (point) and render (area) falls back to the point proxy.
    expect(bySym("proxy-point")).toHaveLength(1);
    // Hidden symbol objects are skipped by default …
    expect(bySym("proxy-line")).toHaveLength(0);
    // … and drawn on request.
    expect(documentRenderInput(doc, { includeHidden: true }).stats.hidden).toBe(0);
  });

  it("drops unmatched objects when asked", () => {
    const r = documentRenderInput(doc, { unmatched: "drop" });
    expect(r.objects).toHaveLength(1);
    expect(r.stats.dropped).toBe(4);
  });

  it("feeds the symboliser", () => {
    const r = documentRenderInput(doc);
    const { stream } = render.symbolise({ objects: r.objects, symbols: r.symbols, fonts: [] });
    expect(stream.passes.length).toBeGreaterThan(0);
  });
});
