import { describe, it, expect } from "vitest";
import { WARNING_DETAILS_MAX } from "../report.js";
import { OCAD_UNITS_PER_MM, ocadColourStack, ocadGeoreferencing, ocadToDocumentInput, type OcadFileLike } from "../ocad-source.js";
import { decodeMapDocument, encodeMapDocument, documentRenderInput } from "../../map-document/index.js";
import { COORD_FLAG } from "../../render/pass-stream.js";

const c = (x: number, y: number, xFlags = 0, yFlags = 0) => ({ 0: x, 1: y, xFlags, yFlags });

function source(): OcadFileLike {
  const colors: (OcadFileLike["colors"][number])[] = [];
  colors[0] = { number: 0, name: "Svart", cmyk: [0, 0, 0, 100], renderOrder: 1 };
  colors[3] = { number: 3, name: "Brun", cmyk: [0, 56, 100, 18], renderOrder: 2 };
  colors[7] = { number: 7, name: "Violett", cmyk: [35, 85, 0, 0], renderOrder: 0, overprint: true };
  return {
    header: { version: 2018, subVersion: 8, subSubVersion: 3 },
    colors,
    symbols: [
      { symNum: 101000, number: "101.0", type: 2, status: 0, description: "Höjdkurva", lineColor: 3, lineWidth: 14, lineStyle: 1 },
      { symNum: 401000, number: "401.0", type: 3, status: 0, description: "Öppen mark", fillOn: true, fillColor: 0 },
      { symNum: 601000, number: "601.0", type: 2, status: 2, description: "Meridian", lineColor: 0, lineWidth: 10 },
      { symNum: 821000, number: "821.0", type: 4, status: 16, description: "Text", fontName: "Arial Narrow", fontColor: 7, fontSize: 80 },
      // Duplicate number, and one that converts to nothing (no colour known for 99).
      { symNum: 101000, number: "101.0", type: 2, status: 0, description: "Duplicate", lineColor: 99, lineWidth: 14 },
      // A rectangle symbol as the reader parses it since v2.2.2-oxygen.1 (Club-full 850.1).
      { symNum: 850001, number: "850.1", type: 7, status: 0, description: "Rektangel", lineColor: 0, lineWidth: 16, radius: 229, gridFlags: 0 },
    ],
    objects: [
      { sym: 101000, otp: 2, ang: 0, coordinates: [c(0, 0), c(100, 50, 1), c(200, 50, 2), c(300, 0, 0, 1)] },
      { sym: 401000, otp: 3, ang: 450, coordinates: [c(0, 0), c(1000, 0), c(1000, 1000), c(0, 1000), c(200, 200, 0, 2), c(800, 200), c(500, 800)] },
      { sym: 601000, otp: 2, coordinates: [c(0, 0), c(0, 5000)] },
      { sym: 821000, otp: 4, ang: 0, text: "Hellasgården", coordinates: [c(10, 10), c(10, 0), c(100, 0), c(100, 20), c(10, 20)] },
      { sym: -2, otp: 2, col: 3, lineWidth: 25, coordinates: [c(0, 0), c(10, 10)] },
      { sym: -2, otp: 2, col: 3, lineWidth: 25, coordinates: [c(5, 5), c(15, 15)] },
      { sym: -2, otp: 3, col: 99, coordinates: [c(0, 0), c(1, 0), c(1, 1)] },
      { sym: 850001, otp: 7, coordinates: [c(0, 0), c(1, 0), c(1, 1), c(0, 1)] },
      { sym: 850001, otp: 7, coordinates: [c(2, 2), c(3, 2), c(3, 3), c(2, 3)] },
      { sym: 777000, otp: 2, coordinates: [c(0, 0), c(5, 5)] },
      { sym: 101000, otp: 2, coordinates: [] },
    ],
    parameterStrings: {
      "8": [{ _first: "bg.jpg" }, { _first: "bg2.jpg" }],
      "1026": [{ _pairs: [{ code: "a", value: "15000.00" }, { code: "L", value: "-197.6" }, { code: "B", value: "49.5" }, { code: "R", value: "-97.9" }, { code: "T", value: "91.9" }] }],
      "1039": [{ _pairs: [{ code: "m", value: "15000.000000" }, { code: "g", value: "50" }, { code: "r", value: "1" }, { code: "d", value: "6.5" }, { code: "i", value: "13002" }, { code: "x", value: "687000" }, { code: "y", value: "6574000" }, { code: "a", value: "4.98" }, { code: "b", value: "0.00" }] }],
      "26": [{ _first: "Tävling", _pairs: [{ code: "L", value: "0" }, { code: "B", value: "0" }, { code: "R", value: "100" }, { code: "T", value: "200" }] }],
    },
    // The reader's own list: a dropped symbol type in its older wording, an unknown type, and two plain reader warnings.
    warnings: ["Ignoring line text symbol 999000.", new Error("Unknown symbol type 9"), "Unexpected end of object index", new Error("Invalid symbol element")],
    getCrs: () => ({ code: 3006, catalog: "EPSG", name: "SWEREF99 TM", gridId: 13002 }),
  };
}

const opts = { fileName: "test.ocd", fileHash: "ff".repeat(32), fileBytes: 4242 };

describe("ocadColourStack", () => {
  it("orders by OCAD render order, bottom first, and scales CMYK to 0..1", () => {
    const stack = ocadColourStack(source().colors);
    expect(stack.map((s) => s.name)).toEqual(["Brun", "Svart", "Violett"]);
    expect(stack[0]).toEqual({ id: "src:3", name: "Brun", cmyk: [0, 0.56, 1, 0.18], sourceNumber: 3 });
    expect(stack[2].overprint).toBe(true);
  });
});

describe("ocadGeoreferencing", () => {
  it("reads ScalePar and the reader's CRS", () => {
    const g = ocadGeoreferencing(source());
    expect(g.mapScale).toBe(15000);
    expect(g.georeferencing).toEqual({
      crs: { authority: "EPSG", code: 3006, name: "SWEREF99 TM" },
      paperOrigin: { x: 687000, y: 6574000 },
      gridRotationDeg: 4.98,
      gridScaleFactor: 1,
      realWorldEnabled: true,
      sourceGridId: 13002,
    });
    // ScalePar `d` is the real-world grid distance in metres, not a declination (docs/map-import.md §3.5).
    expect(g.georeferencing).not.toHaveProperty("declinationDeg");
    expect(g.unresolvedCrs).toBeUndefined();
  });

  const scalePar = (extra: { code: string; value: string }[]) => {
    const s = source();
    s.parameterStrings["1039"] = [{ _pairs: [{ code: "m", value: "10000" }, { code: "r", value: "1" }, { code: "x", value: "600000" }, { code: "y", value: "6600000" }, { code: "a", value: "0" }, ...extra] }];
    s.getCrs = () => ({ code: 0, catalog: undefined, name: undefined, gridId: Number(extra.find((p) => p.code === "i")?.value ?? 0) });
    return s;
  };

  it("falls back to the OCAD 2018 `e` EPSG code when the grid id does not resolve", () => {
    const g = ocadGeoreferencing(scalePar([{ code: "i", value: "99999" }, { code: "e", value: "3006" }]));
    expect(g.georeferencing.crs).toEqual({ authority: "EPSG", code: 3006, name: "EPSG:3006" });
    expect(g.georeferencing.paperOrigin).toEqual({ x: 600000, y: 6600000 });
    expect(g.unresolvedCrs).toBeUndefined();
  });

  it("keeps crs and paperOrigin null together: a resolved grid without x/y is unresolved", () => {
    const s = source();
    s.parameterStrings["1039"] = [{ _pairs: [{ code: "m", value: "10000" }, { code: "r", value: "1" }, { code: "i", value: "13002" }] }];
    const g = ocadGeoreferencing(s);
    expect(g.georeferencing.crs).toBeNull();
    expect(g.georeferencing.paperOrigin).toBeNull();
    expect(g.unresolvedCrs).toBe("EPSG:3006 without ScalePar x/y");
  });

  it("prefers the grid table over `e`", () => {
    const s = scalePar([{ code: "i", value: "13002" }, { code: "e", value: "3010" }]);
    s.getCrs = () => ({ code: 3006, catalog: "EPSG", name: "SWEREF99 TM", gridId: 13002 });
    expect(ocadGeoreferencing(s).georeferencing.crs).toEqual({ authority: "EPSG", code: 3006, name: "SWEREF99 TM" });
  });

  it("names an unresolvable real-world grid in unresolvedCrs; a map without a grid is simply not georeferenced", () => {
    const g = ocadGeoreferencing(scalePar([{ code: "i", value: "1000" }]));
    expect(g.georeferencing.crs).toBeNull();
    expect(g.georeferencing.paperOrigin).toBeNull();
    expect(g.unresolvedCrs).toBe("grid 1000");
    expect(ocadGeoreferencing(scalePar([{ code: "i", value: "0" }])).unresolvedCrs).toBeUndefined();
    // An `e` that is no positive integer does not resolve either.
    for (const e of ["0", "abc"]) {
      const bad = ocadGeoreferencing(scalePar([{ code: "i", value: "0" }, { code: "e", value: e }]));
      expect(bad.georeferencing.crs).toBeNull();
      expect(bad.unresolvedCrs).toBe(`EPSG ${e}`);
    }
    expect(ocadGeoreferencing(scalePar([])).unresolvedCrs).toBeUndefined();
  });

  it("is null-safe without georeferencing", () => {
    const s = source();
    s.parameterStrings = {};
    s.getCrs = () => undefined;
    const g = ocadGeoreferencing(s);
    expect(g.mapScale).toBe(15000);
    expect(g.georeferencing.crs).toBeNull();
    expect(g.georeferencing.paperOrigin).toBeNull();
  });
});

describe("ocadToDocumentInput", () => {
  const result = ocadToDocumentInput(source(), opts);
  const { input } = result;
  const r0 = result;

  it("keeps every object with verbatim coordinates and OCAD flag bits", () => {
    expect(result.counts).toEqual({
      objects: 10, coordinates: 4 + 7 + 2 + 5 + 2 + 2 + 3 + 4 + 4 + 2, symbols: 6 + 2 + 1, colours: 3, texts: 1, graphicObjects: 3, missingSymbolObjects: 1,
      symbolsRendered: 5, symbolsUnrendered: 1,
    });
    const contour = input.objects[0];
    expect(Array.from(contour.coords)).toEqual([0, 0, 100, 50, 200, 50, 300, 0]);
    expect(Array.from(contour.flags)).toEqual([0, COORD_FLAG.bezierFirst, COORD_FLAG.bezierSecond, COORD_FLAG.corner]);
    expect(contour.angleDeciDeg).toBeUndefined();
    const area = input.objects[1];
    expect(area.angleDeciDeg).toBe(450);
    expect(area.flags[4]).toBe(COORD_FLAG.hole);
    expect(input.objects[3].text).toBe("Hellasgården");
    expect(input.objects[3].sourceIndex).toBe(3);
    expect(input.objects.map((o) => o.sourceIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]); // the empty object (index 10) is gone
  });

  it("builds the symbol table in source order with hidden defaults, fonts and provenance", () => {
    const syms = input.header.symbols;
    expect(syms.slice(0, 5).map((s) => [s.code, s.kind, s.hidden, s.origin])).toEqual([
      ["101.0", "line", false, "source"],
      ["401.0", "area", false, "source"],
      ["601.0", "line", true, "source"],
      ["821.0", "text", false, "source"],
      ["101.0", "line", false, "source"],
    ]);
    expect(syms[3].sourceFont).toBe("Arial Narrow");
    expect(syms[3].sourceIndex).toBe(3);
    // Definitions converted to the IR against the document's colour stack (Brun 0, Svart 1, Violett 2).
    expect(syms[0].render).toMatchObject({ type: "line", id: "src:101000", main: { colour: 0, widthUm: 140, cap: "round", join: "round" } });
    expect(syms[1].render).toMatchObject({ type: "area", fill: 1 });
    expect(syms[3].render).toMatchObject({ type: "text", fontFamily: "liberation-sans-narrow", fontSizeUm: 2822, colour: 2 });
    expect(syms[4].render).toBeNull();
    // Objects of the duplicated number resolve to the first definition.
    expect(input.objects[0].symbolIdx).toBe(0);
  });

  it("reads circle diameters by the file's version: outer up to OCAD 8, centre-line from OCAD 9 (B9)", () => {
    const ring = (version: number) => {
      const src = { ...source(), header: { version } };
      src.symbols = [{ symNum: 703000, number: "703.0", type: 1, status: 0, description: "Kontroll", elements: [{ type: 3, color: 7, diameter: 500, lineWidth: 35, coords: [c(0, 0)] }] }];
      src.objects = [{ sym: 703000, otp: 1, coordinates: [c(0, 0)] }];
      const r = ocadToDocumentInput(src, opts).input.header.symbols[0].render;
      return r && r.type === "point" ? r.glyph.parts[0].diameterUm : undefined;
    };
    expect(ring(8)).toBe(5000);
    expect(ring(2018)).toBe(5350);
  });

  it("synthesises one symbol per graphic (type, colour, width) with a render definition", () => {
    const syms = input.header.symbols;
    const graphic = syms.filter((s) => s.origin === "graphic");
    expect(graphic).toHaveLength(2);
    const line = graphic.find((s) => s.kind === "line")!;
    expect(line.render).toMatchObject({ type: "line", main: { colour: 0, widthUm: 250 } }); // colour 3 "Brun" is stack index 0
    expect(input.objects[4].symbolIdx).toBe(input.objects[5].symbolIdx);
    // Unknown colour number → no render (proxy later), still one object entry.
    const area = graphic.find((s) => s.kind === "area")!;
    expect(area.render).toBeNull();
  });

  it("stubs symbols that objects reference but the table lacks", () => {
    const missing = input.header.symbols.filter((s) => s.origin === "missing");
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ code: "777.0", kind: "line", render: null });
    expect(input.objects[9].symbolIdx).toBe(input.header.symbols.indexOf(missing[0]));
  });

  it("resolves rectangle objects to the parsed rectangle symbol, drawn as an outline line", () => {
    const rect = input.header.symbols[5];
    expect(rect).toMatchObject({ code: "850.1", kind: "rectangle", origin: "source", render: { type: "line", main: { colour: 1, widthUm: 160, cap: "flat", join: "miter" } } });
    expect(input.objects[7].symbolIdx).toBe(5);
    expect(input.objects[8].symbolIdx).toBe(5);
    expect(result.warnings.find((w) => w.code === "SYMBOL_FEATURE_DROPPED")).toEqual({ code: "SYMBOL_FEATURE_DROPPED", count: 1, message: "850.1: rectangle corner radius 2.29 mm" });
  });

  it("records what was dropped as stable warning codes", () => {
    const codes = Object.fromEntries(result.warnings.map((w) => [w.code, w.count]));
    expect(codes).toEqual({
      SYMBOL_COLOUR_UNKNOWN: 1, SYMBOL_EMPTY: 1, SYMBOL_FEATURE_DROPPED: 1, DUPLICATE_SYMBOL_NUMBER: 1, EMPTY_GEOMETRY_DROPPED: 1, MISSING_SYMBOL: 1, TEMPLATES_DROPPED: 2,
      SYMBOL_TYPE_UNSUPPORTED: 2, READER_WARNING: 2,
    });
    expect(input.header.warnings).toEqual(result.warnings);
  });

  it("reports the symbol types the reader drops as SYMBOL_TYPE_UNSUPPORTED, not reader warnings", () => {
    const unsupported = result.warnings.find((w) => w.code === "SYMBOL_TYPE_UNSUPPORTED");
    expect(unsupported).toEqual({ code: "SYMBOL_TYPE_UNSUPPORTED", count: 2, message: "999.0: line text symbol dropped by the reader" });
    expect(result.warnings.find((w) => w.code === "READER_WARNING")).toEqual({ code: "READER_WARNING", count: 2, message: "texts in the import report (readerWarnings)" });
    expect(input.header.warnings).toEqual(result.warnings);
  });

  it("returns the reader's own warning texts, in reader order, for the import report", () => {
    expect(result.readerWarnings).toEqual(["Unexpected end of object index", "Invalid symbol element"]);
    const many = source();
    many.warnings = Array.from({ length: 60 }, (_, i) => `warning ${i}`);
    const r = ocadToDocumentInput(many, opts);
    expect(r.readerWarnings).toHaveLength(50);
    expect(r.readerWarnings[49]).toBe("warning 49");
    expect(r.warnings.find((w) => w.code === "READER_WARNING")?.count).toBe(60);
    expect(ocadToDocumentInput({ ...source(), warnings: [] }, opts).readerWarnings).toEqual([]);
  });

  describe("warning detail (docs/map-import.md §3.6)", () => {
    // Club-full shape: two radius rectangles (one aggregated header warning) and an area whose border points at itself.
    const withStale = () => {
      const s = source();
      s.symbols.push(
        { symNum: 301002, number: "301.2", type: 3, status: 0, description: "Stale", fillOn: true, fillColor: 0, borderOn: true, borderSym: 301002 },
        { symNum: 851001, number: "851.1", type: 7, status: 0, description: "Rektangel 2", lineColor: 0, lineWidth: 16, radius: 100, gridFlags: 0 },
      );
      return s;
    };

    it("lists one entry per emission with the symbol index, while the header keeps the first message per code", () => {
      const r = ocadToDocumentInput(withStale(), opts);
      const dropped = r.warnings.find((w) => w.code === "SYMBOL_FEATURE_DROPPED");
      expect(dropped).toEqual({ code: "SYMBOL_FEATURE_DROPPED", count: 2, message: "850.1: rectangle corner radius 2.29 mm" });
      const details = r.warningDetails.filter((d) => d.code === "SYMBOL_FEATURE_DROPPED");
      expect(details).toEqual([
        { code: "SYMBOL_FEATURE_DROPPED", message: "850.1: rectangle corner radius 2.29 mm", symbolIdx: 5 },
        { code: "SYMBOL_FEATURE_DROPPED", message: "851.1: rectangle corner radius 1 mm", symbolIdx: 7 },
      ]);
      expect(r.warningDetails.filter((d) => d.code === "SYMBOL_REFERENCE_INVALID")).toEqual([
        { code: "SYMBOL_REFERENCE_INVALID", message: "301.2: border symbol 301002 is the symbol itself", symbolIdx: 6 },
      ]);
      expect(r.warnings.find((w) => w.code === "SYMBOL_REFERENCE_INVALID")).toEqual({ code: "SYMBOL_REFERENCE_INVALID", count: 1, message: "301.2: border symbol 301002 is the symbol itself" });
      expect(r.input.header.warnings).toEqual(r.warnings);
    });

    it("gives the missing-symbol stub's index, and the first detail of each code carries the header's message", () => {
      const r = ocadToDocumentInput(source(), opts);
      const stub = r.warningDetails.find((d) => d.code === "MISSING_SYMBOL");
      expect(stub).toMatchObject({ message: "objects reference symbol 777.0, which is not in the symbol table" });
      expect(r.input.header.symbols[stub!.symbolIdx!].origin).toBe("missing");
      for (const w of r.warnings) {
        if (w.message) expect(r.warningDetails.find((d) => d.code === w.code)?.message).toBe(w.message);
      }
    });

    it("stays out of the document input and header", () => {
      expect(r0.input).not.toHaveProperty("warningDetails");
      expect(JSON.stringify(r0.input.header)).not.toContain("symbolIdx");
    });

    it("keeps at most WARNING_DETAILS_MAX entries but counts every emission", () => {
      const s = source();
      for (let i = 0; i < WARNING_DETAILS_MAX + 1; i++) {
        s.symbols.push({ symNum: 900000 + i, number: `900.${i}`, type: 3, status: 0, description: "Stale", fillOn: true, fillColor: 0, borderOn: true, borderSym: 900000 + i });
      }
      const r = ocadToDocumentInput(s, opts);
      expect(r.warningDetails).toHaveLength(WARNING_DETAILS_MAX);
      expect(r.warnings.find((w) => w.code === "SYMBOL_REFERENCE_INVALID")?.count).toBe(WARNING_DETAILS_MAX + 1);
    });
  });

  it("fills the header: provenance, units, scale, print window, export rectangles", () => {
    const h = input.header;
    expect(h.format).toEqual({ version: 1, importer: "ocad-10" });
    expect(h.source).toEqual({ kind: "ocad", version: "2018.8.3", hash: "ff".repeat(32), bytes: 4242 });
    expect(h.unitsPerMm).toBe(OCAD_UNITS_PER_MM);
    expect(h.mapScale).toBe(15000);
    expect(h.printWindow).toEqual({ scale: 15000, left: -197.6, bottom: 49.5, right: -97.9, top: 91.9 });
    expect(h.exportRectangles).toEqual([{ name: "Tävling", left: 0, bottom: 0, right: 100, top: 200 }]);
  });

  it("warns CRS_UNRESOLVED for a real-world grid it cannot map", () => {
    const s = source();
    s.getCrs = () => ({ code: 0, gridId: 13002 });
    expect(ocadToDocumentInput(s, opts).warnings.find((w) => w.code === "CRS_UNRESOLVED")).toEqual({ code: "CRS_UNRESOLVED", count: 1, message: "coordinate reference system not mapped to EPSG: grid 13002" });
    expect(result.warnings.some((w) => w.code === "CRS_UNRESOLVED")).toBe(false);
  });

  it("runs stage 5 and returns the analysis with the input", () => {
    expect(result.analysis.bounds).toEqual({ minX: 0, minY: 0, maxX: 1000, maxY: 5000 });
    expect(result.analysis.georeference).toMatchObject({ crs: "EPSG:3006", method: "epsg", projectable: true, gridRotationDeg: 4.98 });
    // One 601 line is not a meridian cluster.
    expect(result.analysis.north.meridian).toBeNull();
    expect(result.analysis.north.paperNorthBearingDeg!).toBeCloseTo(4.98 + 2.82, 1);
  });

  it("encodes, decodes and renders end to end", () => {
    const doc = decodeMapDocument(encodeMapDocument(input));
    expect(doc.header.objects.count).toBe(10);
    expect(doc.header.bounds).toEqual({ minX: 0, minY: 0, maxX: 1000, maxY: 5000 });
    const r = documentRenderInput(doc);
    // 10 objects − 1 hidden (601) = 9 drawn; contour, area, text, the two graphic lines and the two rectangles
    // render natively, the unknown-colour graphic area and the missing-symbol line via proxies.
    expect(r.stats.hidden).toBe(1);
    expect(r.stats.rendered).toBe(7);
    expect(r.stats.proxied).toBe(2);
  });

  it("honours a renderFor hook for source symbols", () => {
    const r = ocadToDocumentInput(source(), {
      ...opts,
      renderFor: (s) => (s.number === "101.0" ? { type: "line", id: "s:101", code: "101", name: "Contour", main: { colour: 0, widthUm: 140, cap: "round", join: "round" } } : null),
    });
    expect(r.input.header.symbols[0].render?.type).toBe("line");
    expect(r.input.header.symbols[1].render).toBeNull();
  });
});
