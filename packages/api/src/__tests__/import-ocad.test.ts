import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mapDocument, render, symbolLibrary } from "@oxygen/shared";
import { importOcadToDocument, sha256Hex } from "../import/ocad.js";
import { buildImportReport } from "../map-store/documents.js";
import { mapFileMetadataFor } from "../map-store/map-file-metadata.js";
import { parseOcadMapMetadata } from "../event-map.js";
import { goldenFonts } from "../render/golden.js";
// @ts-expect-error — plain .mjs fixture writer without types
import { buildSymbolTypesOcad } from "../../../../scripts/lib/ocad-fixture.mjs";
import { computeDeclination, computeMeridianStalenessDeg, detectMapNorth, probeMeridianLines, type OcadNorthSource } from "../map-north.js";

const fixture = readFileSync(fileURLToPath(new URL("../../../../e2e/test.ocd", import.meta.url)));

describe("importOcadToDocument", () => {
  it("produces a decodable, deterministic document from the synthetic OCAD fixture", async () => {
    const a = await importOcadToDocument(fixture, "test.ocd");
    const b = await importOcadToDocument(fixture, "test.ocd");
    expect(a.documentHash).toBe(b.documentHash);
    expect(a.documentHash).toBe(sha256Hex(a.bytes));
    expect(a.fileHash).toBe(sha256Hex(fixture));
    expect(a.counts.objects).toBeGreaterThan(0);
    expect(a.counts.coordinates).toBeGreaterThan(a.counts.objects);

    const doc = mapDocument.decodeMapDocument(a.bytes);
    expect(doc.header.source).toMatchObject({ kind: "ocad", hash: a.fileHash, bytes: fixture.byteLength });
    expect(doc.header.unitsPerMm).toBe(100);
    expect(doc.header.objects.count).toBe(a.counts.objects);
    expect(doc.header.symbols.length).toBe(a.counts.symbols);
    expect(doc.header.colours.length).toBe(a.counts.colours + a.colourStack.inserted.length);
    // Every object's bbox encloses its coordinates.
    for (let i = 0; i < doc.header.objects.count; i++) {
      for (let k = doc.coordStart[i]; k < doc.coordStart[i + 1]; k++) {
        expect(doc.coords[k * 2]).toBeGreaterThanOrEqual(doc.bboxes[i * 4]);
        expect(doc.coords[k * 2]).toBeLessThanOrEqual(doc.bboxes[i * 4 + 2]);
        expect(doc.coords[k * 2 + 1]).toBeGreaterThanOrEqual(doc.bboxes[i * 4 + 1]);
        expect(doc.coords[k * 2 + 1]).toBeLessThanOrEqual(doc.bboxes[i * 4 + 3]);
      }
    }
  });

  it("converts every symbol definition of the fixture to the render IR and symbolises without proxies", async () => {
    const { bytes, counts, warnings } = await importOcadToDocument(fixture, "test.ocd");
    const doc = mapDocument.decodeMapDocument(bytes);
    const source = doc.header.symbols.filter((s) => s.origin === "source");
    expect(source.length).toBeGreaterThanOrEqual(8);
    expect(source.filter((s) => s.render === null).map((s) => s.code)).toEqual([]);
    expect(counts.symbolsUnrendered).toBe(0);
    expect(counts.symbolsRendered).toBe(source.length);
    expect(warnings.map((w) => w.code)).not.toContain("SYMBOL_COLOUR_UNKNOWN");
    const byCode = new Map(source.map((s) => [s.code, s.render!]));
    expect(byCode.get("505.0")).toMatchObject({ type: "line", main: { widthUm: 250 } });
    // ø 6.0 mm on the line's centre (OCAD 9+) is the IR's 6.35 mm outer diameter (B9).
    expect(byCode.get("702.0")).toMatchObject({ type: "point", glyph: { parts: [{ kind: "ring", diameterUm: 6350, widthUm: 350 }] } });
    expect(byCode.get("403.0")).toMatchObject({ type: "area" });
    // OCAD line framing → text halo in the framing colour, frWidth (0.1 mm) as the half-width (docs/map-import.md §3.3).
    const white = doc.header.colours.findIndex((c) => c.name === "White");
    expect(byCode.get("603.0")).toMatchObject({ type: "text", fontSizeUm: 1517, halo: { colour: white, widthUm: 100 } });
    // A rectangle symbol is its outline.
    expect(byCode.get("850.1")).toMatchObject({ type: "line", main: { widthUm: 250, cap: "flat", join: "miter" } });
    expect(source.find((s) => s.code === "850.1")!.kind).toBe("rectangle");
    expect(warnings.map((w) => w.code)).not.toContain("SYMBOL_FEATURE_DROPPED");
    expect(warnings.map((w) => w.code)).not.toContain("MISSING_SYMBOL");
    const input = mapDocument.documentRenderInput(doc, { unmatched: "drop" });
    expect(input.stats.rendered).toBeGreaterThan(0);
    expect(input.stats.proxied).toBe(0);
    expect(input.stats.dropped).toBe(0);
    const { stream } = render.symbolise({ objects: input.objects, symbols: input.symbols, fonts: [] });
    expect(stream.passes.length).toBeGreaterThan(0);
  });

  it("lays out formatted text in its box, frames it, and lays line text along its path (reader → document → stage, B8)", async () => {
    const { bytes, warnings } = await importOcadToDocument(buildSymbolTypesOcad(), "symbol-types.ocd");
    expect(warnings.map((w) => w.code)).not.toContain("SYMBOL_FEATURE_DROPPED");
    const doc = mapDocument.decodeMapDocument(bytes);
    const boxSym = doc.header.symbols.find((s) => s.code === "902.3")!;
    const white = doc.header.colours.findIndex((c) => c.name === "White");
    expect(boxSym.render).toMatchObject({ type: "text", align: "justify", paragraphSpacingUm: 500, tabStops: [{ xUm: 7500 }], frame: { colour: white, leftUm: 200, bottomUm: 300, rightUm: 200, topUm: 100 } });
    const input = mapDocument.documentRenderInput(doc, { unmatched: "drop", canonical: false });
    const objOf = (text: string) => input.objects.findIndex((o) => o.text === text);
    const boxObj = objOf("Wrapped inside its box\n7\tTab"), lineObj = objOf("Along the path");
    expect(input.objects[boxObj].textLayout).toBe("box");
    expect(input.objects[lineObj].textLayout).toBe("path");
    const { stream, warnings: stageWarnings } = render.symbolise({ ...input, fonts: await goldenFonts() });
    expect(stageWarnings).toEqual([]);
    const passesOf = (o: number) => stream.passes.filter((_, i) => stream.objectIdx[i] === o);
    // Box text: more than the two source lines (it wraps), every glyph inside the 20 mm-wide box, a frame fill behind it.
    const box = passesOf(boxObj);
    const boxText = box.find((p) => p.kind === "text" && p.colour !== white)!;
    if (boxText.kind !== "text") throw new Error("no text pass");
    const lines = new Set(Array.from(boxText.positions).filter((_, i) => i % 2 === 1).map((v) => Math.round(v)));
    expect(lines.size).toBeGreaterThan(2);
    for (let i = 0; i < boxText.glyphs.length; i++) expect(boxText.positions[2 * i]).toBeGreaterThanOrEqual(-10000);
    expect(box.filter((p) => p.kind === "fill" && p.colour === white)).toHaveLength(1);
    // Line text: every glyph has an angle; the path rises then falls.
    const along = passesOf(lineObj).filter((p) => p.kind === "text");
    for (const p of along) if (p.kind === "text") expect(p.angles).toHaveLength(p.glyphs.length);
    const main = along[along.length - 1];
    if (main.kind !== "text") throw new Error("no text pass");
    expect(main.angles![0]).toBeGreaterThan(0);
    expect(main.angles![main.glyphs.length - 1]).toBeLessThan(0);
  });

  it("matches the fixture's symbols against ISOM 2017-2 and aligns its colour stack (stages 6–7)", async () => {
    const result = await importOcadToDocument(fixture, "test.ocd");
    expect(result.libraryVersion).toBe(`ISOM2017-2@${symbolLibrary.SYMBOL_LIBRARY_VERSION}`);
    expect(result.timings.match).toBeGreaterThanOrEqual(0);
    const doc = mapDocument.decodeMapDocument(result.bytes);
    expect(doc.header.library).toEqual({ id: "ISOM2017-2", version: symbolLibrary.SYMBOL_LIBRARY_VERSION });
    // The fixture is a 1:7500 map drawn with 1:15000 dimensions and has no solid
    // line family to measure, so the factor comes from the exact-code fit (×1), not the scale (×2).
    expect(doc.header.documentFactor).toBe(1);
    expect(result.matching.factor).toMatchObject({ method: "codes", scaleFactor: 2, symbolScale: 0.5 });
    const byCode = new Map(doc.header.symbols.filter((s) => s.origin === "source").map((s) => [s.code, s]));
    // Spec-sized symbols with spec codes match automatically …
    expect(byCode.get("706.0")!.match).toMatchObject({ canonicalId: "ISOM2017-2:706", state: "auto", method: "code+geometry" });
    expect(byCode.get("521.0")!.match).toMatchObject({ canonicalId: "ISOM2017-2:521", state: "auto", method: "code+geometry" });
    expect(byCode.get("601.0")!.match).toMatchObject({ canonicalId: "ISOM2017-2:601.b", state: "auto" });
    // … the old-numbered ø 6.0 control ring (702) is only suggested as 703 by its name,
    // the solid "Path" is not 505 (dashed) and the full-yellow "Rough open land" is really 401.
    expect(byCode.get("702.0")!.match).toMatchObject({ canonicalId: "ISOM2017-2:703", state: "suggested", method: "description" });
    expect(byCode.get("505.0")!.match).toMatchObject({ state: "suggested", method: "geometry" });
    expect(byCode.get("403.0")!.match).toMatchObject({ canonicalId: "ISOM2017-2:401", state: "suggested", method: "geometry" });
    // The framed spot height is 603's text variant (the fingerprint ignores the halo); the frame only gets a geometry suggestion.
    expect(byCode.get("603.0")!.match).toMatchObject({ canonicalId: "ISOM2017-2:603.b", state: "auto", method: "code+geometry" });
    expect(byCode.get("850.1")!.match).toMatchObject({ state: "suggested", method: "geometry" });
    expect(result.matching.symbols).toMatchObject({ auto: 4, unmatched: 0 });
    // The source has a single purple: it becomes lower purple and upper purple is inserted; palette ids are recorded.
    const purples = doc.header.colours.filter((c) => c.purpleRole);
    expect(purples.map((c) => c.purpleRole).sort()).toEqual(["lower", "upper"]);
    expect(result.colourStack.inserted).toEqual(["purple-lower"]);
    expect(doc.header.colours.find((c) => c.name === "Black")!.paletteIds).toContain("black100");
    // Auto matches are drawn canonically by the bridge.
    const input = mapDocument.documentRenderInput(doc);
    expect(input.stats.canonicalSymbols).toBe(result.matching.symbols.auto);
    expect(input.stats.canonicalMissing).toBe(0);
    // The fixture stacks its blue line colour below yellow, so the inserted lower purple cannot satisfy both neighbours.
    expect(result.warnings.map((w) => w.code)).toContain("COLOUR_ORDER_CONFLICT");
  });

  it("honours the renderFor hook (renders stated against the source colour table)", async () => {
    const { bytes } = await importOcadToDocument(fixture, "test.ocd", {
      renderFor: (s) => ({ type: "line", id: `hook:${s.symNum}`, code: String(s.symNum), name: "hook", main: { colour: 0, widthUm: 500 } }),
    });
    const doc = mapDocument.decodeMapDocument(bytes);
    const source = doc.header.symbols.filter((s) => s.origin === "source");
    expect(source.length).toBeGreaterThan(0);
    expect(source.every((s) => s.render?.type === "line")).toBe(true);
    const dropMode = mapDocument.documentRenderInput(doc, { unmatched: "drop" });
    expect(dropMode.stats.rendered).toBeGreaterThan(0);
    expect(dropMode.stats.proxied).toBe(0);
  });

  it("rejects hook renders that reference colours outside the source table", async () => {
    const byCode = new Map(render.pilotSymbols.map((s) => [s.code, s]));
    await expect(
      importOcadToDocument(fixture, "test.ocd", { renderFor: (s) => byCode.get(String(Math.floor(s.symNum / 1000))) ?? null }),
    ).rejects.toThrow(/colour index \d+ outside/);
  });
});

describe("stage 5 on the OCAD fixture (docs/map-import.md §3.5, §3.8)", () => {
  it("resolves grid 13002 to SWEREF99 TM and carries only source-declared values in the header", async () => {
    const r = await importOcadToDocument(fixture, "test.ocd");
    const g = mapDocument.decodeMapDocument(r.bytes).header.georeferencing;
    expect(g.crs).toEqual({ authority: "EPSG", code: 3006, name: "SWEREF99 TM" });
    expect(g.paperOrigin).toEqual({ x: 500000, y: 6500000 });
    expect(g).not.toHaveProperty("declinationDeg");
    expect(g.sourceGridId).toBe(13002);
    expect(r.warnings.some((w) => w.code === "CRS_UNRESOLVED")).toBe(false);
  });

  it("finds the same meridian cluster as the legacy probe over the reader's objects", async () => {
    const r = await importOcadToDocument(fixture, "test.ocd");
    const legacy = probeMeridianLines((await readFixture()).objects ?? [])!;
    expect(r.analysis.north.meridian).toMatchObject({ code: "601.0", count: legacy.count, medianTiltDeg: legacy.medianTiltDeg });
    expect(r.analysis.north.meridian!.count).toBe(12);
    expect(r.analysis.georeference).toMatchObject({ crs: "EPSG:3006", method: "epsg", projectable: true, gridRotationDeg: 0 });
  });

  it("keeps the reader's warning texts in the import report only when there are any (docs/map-import.md §3.6)", async () => {
    const r = await importOcadToDocument(fixture, "test.ocd");
    const header = mapDocument.readMapDocumentHeader(r.bytes).header;
    expect(r.readerWarnings).toEqual([]);
    expect(buildImportReport(r, header, "test.ocd")).not.toHaveProperty("readerWarnings");
    const report = buildImportReport({ ...r, readerWarnings: ["Unexpected end of object index"] }, header, "test.ocd");
    expect(report.readerWarnings).toEqual(["Unexpected end of object index"]);
  });

  it("keeps the per-emission warning detail in the import report only, and only when there is any (docs/map-import.md §3.6)", async () => {
    const r = await importOcadToDocument(fixture, "test.ocd");
    const header = mapDocument.readMapDocumentHeader(r.bytes).header;
    expect(r.warningDetails).toEqual([]);
    expect(buildImportReport(r, header, "test.ocd")).not.toHaveProperty("warningDetails");
    const detail = { code: "SYMBOL_REFERENCE_INVALID", message: "301.2: border symbol 301002 is the symbol itself", symbolIdx: 3 };
    const report = buildImportReport({ ...r, warningDetails: [detail] }, header, "test.ocd");
    expect(report.warningDetails).toEqual([detail]);
    // The header, and so the document identity, never carries it.
    expect(JSON.stringify(header)).not.toContain("symbolIdx");
  });

  it("reports georeference and north, with the WMM fields evaluated at the report date", async () => {
    const r = await importOcadToDocument(fixture, "test.ocd");
    const asOf = new Date("2026-10-19T00:00:00Z");
    const report = buildImportReport(r, mapDocument.readMapDocumentHeader(r.bytes).header, "test.ocd", asOf);
    expect(report.georeference).toEqual(r.analysis.georeference);
    const n = report.north!;
    expect(n.asOf).toBe(asOf.toISOString());
    expect(n.meridian).toEqual(r.analysis.north.meridian);
    const decl = computeDeclination(n.centerLat!, n.centerLng!, asOf)!;
    expect(n.declinationDeg).toBe(decl);
    expect(n.meridianStalenessDeg).toBe(computeMeridianStalenessDeg({
      declinationDeg: decl, trueNorthFromGridDeg: n.trueNorthFromGridDeg!, declaredGrivationDeg: 0, meridianTiltDeg: n.meridian!.medianTiltDeg,
    }));
    // Legacy north detection over the reader agrees on the time-independent part.
    const legacy = detectMapNorth(await readFixture(), asOf);
    expect(n.trueNorthFromGridDeg).toBeCloseTo(legacy.trueNorthFromGridDeg!, 9);
    expect(n.centerLat).toBeCloseTo(legacy.centerLat!, 9);
    expect(n.meridianStalenessDeg).toBe(legacy.meridianStalenessDeg);
  });

  it("gives the raster path and the pin the same quick-access columns", async () => {
    const r = await importOcadToDocument(fixture, "test.ocd");
    const { header } = mapDocument.readMapDocumentHeader(r.bytes);
    for (const correction of [0, 11]) {
      const pinned = mapFileMetadataFor(header, r.analysis.north.meridian?.medianTiltDeg, correction);
      expect(pinned).not.toBeNull();
      expect(await parseOcadMapMetadata(fixture, correction)).toEqual(pinned);
      expect(pinned!.scale).toBe(7500);
      expect(pinned!.calibration).toHaveLength(4);
    }
    // The correction turns the display north by the same amount.
    const a = mapFileMetadataFor(header, 0, 0)!, b = mapFileMetadataFor(header, 0, 11)!;
    expect(b.northOffset! - a.northOffset!).toBeCloseTo(11, 1);
  });

  it("leaves the columns to the caller when the document has no projectable CRS", () => {
    const frame = { unitsPerMm: 100, mapScale: 7500, georeferencing: { crs: null, paperOrigin: null }, bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 } };
    expect(mapFileMetadataFor(frame, null, 0)).toBeNull();
  });
});

async function readFixture() {
  const m = (await import("ocad2geojson")) as unknown as { readOcad: (b: Buffer, o: object) => Promise<OcadNorthSource> };
  return m.readOcad(fixture, { quietWarnings: true });
}
