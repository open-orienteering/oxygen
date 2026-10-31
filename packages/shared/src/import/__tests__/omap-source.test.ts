/**
 * OMAP normaliser against the synthetic fixture `e2e/test.xmap`
 * (scripts/generate-test-omap.mjs). Each assertion names the rule from
 * docs/map-import.md §4 it pins down.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { encodeMapDocument, decodeMapDocument, inputBounds } from "../../map-document/codec.js";
import { OBJECT_TYPE } from "../../map-document/header.js";
import { COORD_FLAG } from "../../render/pass-stream.js";
import type { AreaSymbol, LineSymbol, TextSymbol } from "../../render/symbol.js";
import { WARNING_DETAILS_MAX } from "../report.js";
import { readOmap, type OmapGeoreferencing } from "../omap-reader.js";
import { OMAP_IMPORTER_VERSION, OMAP_UNITS_PER_MM, omapGeoreferencing, omapResolveCrs, omapToDocumentInput } from "../omap-source.js";

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../e2e/test.xmap");
const file = readOmap(readFileSync(FIXTURE, "utf8"));
const result = omapToDocumentInput(file, { fileName: "test.xmap", fileHash: "ab".repeat(32), fileBytes: 16960 });
const { header, objects } = result.input;
const warning = (code: string) => result.warnings.find((w) => w.code === code);
const bySource = (i: number) => objects.find((o) => o.sourceIndex === i)!;
const symbolIdx = (code: string) => header.symbols.findIndex((s) => s.code === code);

describe("omapToDocumentInput (fixture)", () => {
  it("header: omap source, 0.001 mm units, importer version, map scale", () => {
    expect(header.source).toEqual({ kind: "omap", version: "9", hash: "ab".repeat(32), bytes: 16960 });
    expect(header.unitsPerMm).toBe(OMAP_UNITS_PER_MM);
    expect(header.format).toEqual({ version: 1, importer: OMAP_IMPORTER_VERSION });
    expect(header.mapScale).toBe(10000);
  });

  it("colours: priority reversed into draw order, spot names and knockout kept, opacity warned", () => {
    expect(header.colours.map((c) => c.name)).toEqual(["White", "Yellow", "Green", "Blue", "Brown", "Black", "Purple"]);
    expect(header.colours[5]).toMatchObject({ id: "src:1", sourceNumber: 1, cmyk: [0, 0, 0, 1], spot: { name: "BLACK", knockout: true } });
    expect(header.colours[0].spot).toEqual({ knockout: true });
    expect(warning("COLOUR_OPACITY_IGNORED")).toMatchObject({ count: 1 });
  });

  it("georeferencing: UTM → EPSG, paper origin from the shifted reference point, grivation, scale factor", () => {
    expect(header.georeferencing.crs).toEqual({ authority: "EPSG", code: 32633, name: "WGS 84 / UTM zone 33N" });
    // Rounded to 1e-6 m so no unrounded sin/cos result reaches the document bytes (docs/map-import.md §4.4, §6).
    expect(header.georeferencing.paperOrigin).toEqual({ x: 499518.116475, y: 6600421.260411 });
    expect(header.georeferencing).toMatchObject({ gridRotationDeg: 2.5, gridScaleFactor: 0.9996, declinationDeg: 5.5, realWorldEnabled: true });
  });

  it("stage 5: the analysis projects the fixture and finds no meridian cluster", () => {
    expect(result.analysis.georeference).toMatchObject({ crs: "EPSG:32633", method: "epsg", projectable: true, gridRotationDeg: 2.5 });
    expect(result.analysis.georeference.gridConvergenceDeg!).toBeCloseTo(0, 0);
    expect(result.analysis.north.meridian).toBeNull();
    expect(result.analysis.bounds).toEqual(inputBounds(objects));
  });

  it("print area: Mapper's y-down rectangle becomes a y-up window", () => {
    expect(header.printWindow).toEqual({ scale: 10000, left: 0, right: 100, top: 0, bottom: -80 });
  });

  it("symbols: list order kept, kinds from the parts, hidden + helper hidden, missing synthesised, fonts recorded", () => {
    expect(header.symbols).toHaveLength(23);
    expect(header.symbols[6]).toMatchObject({ code: "301", kind: "area", origin: "source", hidden: false, sourceIndex: 6 });
    expect((header.symbols[6].render as AreaSymbol).border!.main!.widthUm).toBe(180);
    expect(header.symbols[11].kind).toBe("line");
    // 106 earth bank: pointed cap tapered over pointed_cap_length, not shortened (§4.3).
    expect((header.symbols[2].render as LineSymbol).main).toMatchObject({ cap: "pointed", taper: { startUm: 600, endUm: 600 } });
    expect((header.symbols[2].render as LineSymbol).main!.shortenStartUm).toBeUndefined();
    expect(header.symbols[16]).toMatchObject({ code: "999", hidden: true });
    expect(header.symbols[17]).toMatchObject({ code: "998", hidden: true });
    expect(header.symbols[15].sourceFont).toBe("Arial");
    expect(header.symbols[21]).toMatchObject({ code: "#77", origin: "missing", kind: "point", render: null });
    expect(warning("MISSING_SYMBOL")).toMatchObject({ count: 1 });
    expect(warning("HELPER_SYMBOLS_HIDDEN")).toMatchObject({ count: 1 });
    expect(result.counts).toMatchObject({ objects: 24, symbols: 23, colours: 7, texts: 5, missingSymbolObjects: 1, symbolsRendered: 22, symbolsUnrendered: 0 });
  });

  it("objects: y negated, parts concatenated in order, area / line type from the symbol kind", () => {
    const bg = bySource(0);
    expect(bg.type).toBe(OBJECT_TYPE.area);
    expect(Array.from(bg.coords as Int32Array).slice(0, 4)).toEqual([0, -60000, 100000, -60000]);
    expect(bySource(3).type).toBe(OBJECT_TYPE.line);
    expect(bySource(23)).toMatchObject({ symbolIdx: symbolIdx("204"), type: OBJECT_TYPE.point });
    expect(warning("PARTS_MERGED")).toMatchObject({ count: 1 });
  });

  it("flags: curve start → control points, hole point → next ring, close point kept as a repeated coordinate", () => {
    expect(Array.from(bySource(2).flags as Uint8Array)).toEqual([0, COORD_FLAG.bezierFirst, COORD_FLAG.bezierSecond, 0, COORD_FLAG.corner, 0]);
    const lake = bySource(7);
    expect(Array.from(lake.flags as Uint8Array)).toEqual([0, 0, 0, 0, 0, COORD_FLAG.hole, 0, 0, 0, 0]);
    expect(lake.coords.length / 2).toBe(10);
  });

  it("flags: dash points are dash flags on dashed lines without a dash symbol, corners otherwise", () => {
    expect(Array.from(bySource(5).flags as Uint8Array)).toEqual([0, COORD_FLAG.dash, 0]);
    expect(Array.from(bySource(6).flags as Uint8Array)).toEqual([0, COORD_FLAG.corner, COORD_FLAG.corner, 0]);
  });

  it("rotation: radians → 0.1°, pattern rotation on area objects, none on lines", () => {
    expect(bySource(16).angleDeciDeg).toBe(300);
    expect(bySource(8).angleDeciDeg).toBe(172);
    expect(bySource(3).angleDeciDeg).toBeUndefined();
    expect(bySource(15).angleDeciDeg).toBeUndefined();
  });

  it("texts: anchor only, entities decoded, first alignment pair lifted onto the symbol", () => {
    expect(bySource(18)).toMatchObject({ type: OBJECT_TYPE.text, text: "Fixture <map>", angleDeciDeg: 57 });
    expect(bySource(20).coords.length).toBe(2);
    expect((header.symbols[15].render as TextSymbol).align).toBe("centre");
    const t702 = header.symbols[20].render as TextSymbol;
    expect(t702.align).toBe("left");
    expect("verticalAlign" in t702).toBe(false);
    expect(warning("TEXT_ALIGNMENT_PER_OBJECT")).toBeUndefined();
    expect(warning("TEXT_VERTICAL_ALIGNMENT_DROPPED")).toBeUndefined();
    expect(warning("TEXT_BOX_DROPPED")).toBeUndefined();
  });

  it("a box text is formatted text with its four corners from the centre and size, y flipped (§4.2)", () => {
    // Mapper: centre (70000, 70000) y-down, box 20 × 6 mm.
    const box = objects.find((o) => o.text === "boxed text")!;
    expect(box.type).toBe(OBJECT_TYPE.formattedText);
    expect(Array.from(box.coords)).toEqual([60000, -73000, 80000, -73000, 80000, -67000, 60000, -67000]);
    expect(Array.from(box.flags)).toEqual([0, 0, 0, 0]);
    expect(box.angleDeciDeg).toBeUndefined();
  });

  it("an odd-sized box keeps its size exactly; a rotated box is turned about the centre and rounded to native units", () => {
    const f = readOmap(readFileSync(FIXTURE, "utf8"));
    const o = f.parts.flatMap((p) => p.objects).find((x) => x.text === "boxed text")!;
    o.boxSize = { width: 20001, height: 6001 };
    const odd = omapToDocumentInput(f, { fileName: "test.xmap", fileHash: "ab".repeat(32), fileBytes: 16960 }).input.objects.find((x) => x.text === "boxed text")!;
    expect(Array.from(odd.coords)).toEqual([60000, -73000, 80001, -73000, 80001, -66999, 60000, -66999]);
    o.boxSize = { width: 20000, height: 6000 };
    o.rotation = Math.PI / 6;
    const r = omapToDocumentInput(f, { fileName: "test.xmap", fileHash: "ab".repeat(32), fileBytes: 16960 }).input.objects.find((x) => x.text === "boxed text")!;
    expect(r.angleDeciDeg).toBe(300);
    const c = Math.cos(Math.PI / 6), sn = Math.sin(Math.PI / 6);
    const corner = (lx: number, ly: number) => [Math.round(70000 + lx * c - ly * sn), Math.round(-70000 + lx * sn + ly * c)];
    expect(Array.from(r.coords)).toEqual([...corner(-10000, -3000), ...corner(10000, -3000), ...corner(10000, 3000), ...corner(-10000, 3000)]);
    expect(Array.from(r.coords).every(Number.isInteger)).toBe(true);
  });

  it("texts: a further alignment pair gets an appended variant of the symbol (§4.4)", () => {
    // 702's objects: left / baseline, right / middle, left / baseline (the box).
    const byText = (t: string) => objects.find((o) => o.text === t)!;
    const variant = header.symbols[22];
    expect(variant).toMatchObject({ code: "702", name: header.symbols[20].name, kind: "text", origin: "source", hidden: false, sourceIndex: 20, sourceFont: "Sans Serif" });
    expect(variant.render).toEqual({ ...header.symbols[20].render, id: "src:20/right/middle", align: "right", verticalAlign: "middle" });
    expect(byText("right").symbolIdx).toBe(22);
    expect(byText("left").symbolIdx).toBe(20);
    expect(byText("boxed text").symbolIdx).toBe(20);
    // Uniform symbols get none: 701 is centre / baseline throughout.
    expect(header.symbols.filter((s) => s.code === "701")).toHaveLength(1);
  });

  it("texts: a baseline variant leaves verticalAlign out; a symbol without a text render gets no variants", () => {
    const f = readOmap(readFileSync(FIXTURE, "utf8"));
    const texts = f.parts.flatMap((p) => p.objects).filter((o) => o.type === 4);
    // 702: first object right / top, the next ones left / baseline.
    const t702 = texts.filter((o) => o.symbol === 20);
    t702[0].hAlign = 2; t702[0].vAlign = 1;
    for (const o of t702.slice(1)) { o.hAlign = 0; o.vAlign = 0; }
    // Two texts with different alignments on the 101 contour line symbol (no text render).
    texts[0].symbol = 0; texts[0].hAlign = 0;
    texts[1].symbol = 0; texts[1].hAlign = 2;
    const r = omapToDocumentInput(f, { fileName: "test.xmap", fileHash: "ab".repeat(32), fileBytes: 16960 });
    const syms = r.input.header.symbols;
    expect(syms[20].render).toMatchObject({ align: "right", verticalAlign: "top" });
    const variant = syms.find((s) => s.render?.id === "src:20/left/baseline")!;
    expect(variant).toMatchObject({ code: "702", origin: "source", sourceIndex: 20 });
    expect("verticalAlign" in variant.render!).toBe(false);
    expect(syms.filter((s) => s.render?.id.startsWith("src:0/"))).toEqual([]);
  });

  it("drops tags and templates with counts, and reports font substitution", () => {
    expect(warning("OBJECT_TAGS_DROPPED")).toMatchObject({ count: 1 });
    expect(warning("TEMPLATES_DROPPED")).toMatchObject({ count: 1, message: expect.stringContaining("ortho.png") });
    expect(warning("FONT_SUBSTITUTED")).toMatchObject({ count: 1 });
    expect(result.warnings.map((w) => w.code).sort()).toEqual([
      "COLOUR_OPACITY_IGNORED", "FONT_SUBSTITUTED", "HELPER_SYMBOLS_HIDDEN", "MISSING_SYMBOL", "OBJECT_TAGS_DROPPED", "PARTS_MERGED",
      "TEMPLATES_DROPPED",
    ]);
  });

  it("returns one detail per message-carrying emission, report-only, with the stub's symbol index", () => {
    const stub = result.warningDetails.find((d) => d.code === "MISSING_SYMBOL")!;
    expect(stub.message).toBe(warning("MISSING_SYMBOL")!.message);
    expect(header.symbols[stub.symbolIdx!].origin).toBe("missing");
    // The first detail of every code carries the header's message; the document does not depend on the list.
    for (const w of result.warnings) {
      if (w.message) expect(result.warningDetails.find((d) => d.code === w.code)?.message).toBe(w.message);
    }
    expect(result.input).not.toHaveProperty("warningDetails");
    expect(result.warningDetails.length).toBeLessThanOrEqual(WARNING_DETAILS_MAX);
    expect(header.format.importer).toBe("omap-9");
  });

  it("combined symbols render as merged IR (halo ride, railway band)", () => {
    const ride = header.symbols[symbolIdx("508.1")].render as LineSymbol;
    expect(ride.main!.halo).toMatchObject({ widthUm: 135, continuous: true });
    const rail = header.symbols[symbolIdx("509")].render as LineSymbol;
    expect(rail.borders).toMatchObject({ backgroundWidthUm: 350, left: { shiftUm: 175 } });
  });

  it("round-trips through the document codec", () => {
    const bytes = encodeMapDocument(result.input);
    const doc = decodeMapDocument(bytes);
    expect(doc.header.source.kind).toBe("omap");
    expect(doc.header.unitsPerMm).toBe(1000);
    expect(doc.header.symbols.length).toBe(23);
    expect(doc.coordStart[doc.coordStart.length - 1]).toBe(result.counts.coordinates);
  });
});

describe("omapResolveCrs / omapGeoreferencing", () => {
  const g = (projectedCrs?: OmapGeoreferencing["projectedCrs"]): OmapGeoreferencing => ({
    scale: 15000, gridScaleFactor: 1, auxiliaryScaleFactor: 1, declination: 0, grivation: 0, refPoint: { x: 0, y: 0 }, projectedCrs,
  });
  it("maps EPSG, UTM north/south, Gauss-Krüger and PROJ.4 specs; local / unknown stay null", () => {
    expect(omapResolveCrs(g({ id: "EPSG", parameters: ["3006"] })).crs).toEqual({ authority: "EPSG", code: 3006, name: "EPSG:3006" });
    expect(omapResolveCrs(g({ id: "UTM", parameters: ["33 S"] })).crs!.code).toBe(32733);
    expect(omapResolveCrs(g({ id: "Gauss-Krueger, datum: Potsdam", parameters: ["3"] })).crs!.code).toBe(31467);
    expect(omapResolveCrs(g({ id: "PROJ.4", parameters: [], spec: "+init=epsg:3011 +units=m" })).crs!.code).toBe(3011);
    expect(omapResolveCrs(g({ id: "PROJ.4", parameters: [], spec: "+proj=utm +datum=WGS84 +zone=32 +south" })).crs!.code).toBe(32732);
    expect(omapResolveCrs(g({ id: "Local", parameters: [] }))).toEqual({ crs: null });
    expect(omapResolveCrs(g(undefined))).toEqual({ crs: null });
    const u = omapResolveCrs(g({ id: "PROJ.4", parameters: [], spec: "+proj=lcc +lat_1=49" }));
    expect(u.crs).toBeNull();
    expect(u.unresolved).toContain("+proj=lcc");
  });
  it("paper origin is the reference point itself when the map reference is (0, 0); unresolved CRS is warned", () => {
    const r = omapGeoreferencing({ ...g({ id: "EPSG", parameters: ["3006"], refPoint: { x: 600000, y: 6500000 } }), grivation: -3 });
    expect(r.georeferencing.paperOrigin).toEqual({ x: 600000, y: 6500000 });
    expect(r.georeferencing.gridRotationDeg).toBe(-3);
    const local = omapGeoreferencing(g({ id: "Local", parameters: [] }));
    expect(local.georeferencing).toEqual({ crs: null, paperOrigin: null, gridRotationDeg: 0, gridScaleFactor: 1 });
    expect(omapGeoreferencing(g({ id: "PROJ.4", parameters: [], spec: "+proj=lcc" })).unresolvedCrs).toBeDefined();
  });
});
