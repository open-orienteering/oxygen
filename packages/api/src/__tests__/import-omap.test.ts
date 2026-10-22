import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mapDocument, render, symbolLibrary } from "@oxygen/shared";
import { importMapToDocument, importOcadToDocument, importOmapToDocument, importerVersionFor, sha256Hex } from "../import/ocad.js";
import { buildImportReport } from "../map-store/documents.js";
import { IMPORTABLE_KINDS, sniffMapKind } from "../map-store/uploads.js";

const fixture = readFileSync(fileURLToPath(new URL("../../../../e2e/test.xmap", import.meta.url)));
const ocdFixture = readFileSync(fileURLToPath(new URL("../../../../e2e/test.ocd", import.meta.url)));

describe("importOmapToDocument", () => {
  it("produces a decodable, deterministic document from the synthetic Mapper fixture", async () => {
    const a = await importOmapToDocument(fixture, "test.xmap");
    const b = await importMapToDocument(fixture, "test.xmap", "omap");
    expect(a.documentHash).toBe(b.documentHash);
    expect(a.documentHash).toBe(sha256Hex(a.bytes));
    expect(a.fileHash).toBe(sha256Hex(fixture));
    expect(a.kind).toBe("omap");
    expect(a.counts).toMatchObject({ objects: 24, texts: 5, missingSymbolObjects: 1, symbolsUnrendered: 0 });

    const doc = mapDocument.decodeMapDocument(a.bytes);
    expect(doc.header.source).toMatchObject({ kind: "omap", version: "9", hash: a.fileHash, bytes: fixture.byteLength });
    expect(doc.header.format.importer).toBe(importerVersionFor("omap"));
    expect(doc.header.unitsPerMm).toBe(1000);
    expect(doc.header.mapScale).toBe(10000);
    expect(doc.header.georeferencing.crs).toEqual({ authority: "EPSG", code: 32633, name: "WGS 84 / UTM zone 33N" });
    expect(doc.header.objects.count).toBe(a.counts.objects);
    for (let i = 0; i < doc.header.objects.count; i++) {
      for (let k = doc.coordStart[i]; k < doc.coordStart[i + 1]; k++) {
        expect(doc.coords[k * 2]).toBeGreaterThanOrEqual(doc.bboxes[i * 4]);
        expect(doc.coords[k * 2]).toBeLessThanOrEqual(doc.bboxes[i * 4 + 2]);
        expect(doc.coords[k * 2 + 1]).toBeGreaterThanOrEqual(doc.bboxes[i * 4 + 1]);
        expect(doc.coords[k * 2 + 1]).toBeLessThanOrEqual(doc.bboxes[i * 4 + 3]);
      }
    }
    // Mapper's y grows downward; the document's grows upward, so the drawing sits below the x axis.
    expect(doc.header.bounds.maxY).toBeLessThanOrEqual(0);
    expect(doc.header.bounds.minY).toBeLessThan(-70_000);
  });

  it("renders every source symbol and symbolises the document without proxies", async () => {
    const { bytes, warnings } = await importOmapToDocument(fixture, "test.xmap");
    const doc = mapDocument.decodeMapDocument(bytes);
    const source = doc.header.symbols.filter((s) => s.origin === "source");
    expect(source.length).toBe(21);
    expect(source.filter((s) => s.render === null)).toEqual([]);
    expect(doc.header.symbols.filter((s) => s.origin === "missing").map((s) => s.code)).toEqual(["#77"]);
    expect(warnings.map((w) => w.code)).not.toContain("SYMBOL_COLOUR_UNKNOWN");
    const input = mapDocument.documentRenderInput(doc, { unmatched: "drop" });
    expect(input.stats.rendered).toBeGreaterThan(0);
    expect(input.stats.proxied).toBe(0);
    // Only the object with the dangling symbol is dropped.
    expect(input.stats.dropped).toBe(1);
    const { stream } = render.symbolise({ objects: input.objects, symbols: input.symbols, fonts: [] });
    expect(stream.passes.length).toBeGreaterThan(0);
  });

  it("runs stages 6–7 and reports them, with the library version in the dedup key", async () => {
    const result = await importOmapToDocument(fixture, "test.xmap");
    expect(result.libraryVersion).toBe(`ISOM2017-2@${symbolLibrary.SYMBOL_LIBRARY_VERSION}`);
    expect(result.matching.library.id).toBe("ISOM2017-2");
    // Mapper widths are µm already, so the line-width factor detection sees ×1.
    expect(result.matching.factor.factor).toBe(1);
    expect(result.matching.symbols.auto).toBeGreaterThanOrEqual(4);
    // Mapper builds 509 as black dashes over a white band; the library (B10) is white dashes over a black band, as OCAD
    // builds it, so Mapper's railway hard-fails on main colour and stays unmatched, drawn from its own definition
    // (docs/map-symbols.md §7).
    const { header: h } = mapDocument.readMapDocumentHeader(result.bytes);
    expect(h.symbols.find((s) => s.code === "509")?.match).toMatchObject({ state: "unmatched", reasons: expect.arrayContaining(["main colour black ≠ white"]) });
    expect(result.timings.read).toBeGreaterThanOrEqual(0);
    const { header } = mapDocument.readMapDocumentHeader(result.bytes);
    const report = buildImportReport(result, header, "test.xmap");
    expect(report.source).toMatchObject({ kind: "omap", version: "9", fileName: "test.xmap" });
    expect(report.importer).toBe("omap-4");
    expect(report.warnings.map((w) => w.code)).toContain("TEMPLATES_DROPPED");
    // Per-emission detail (docs/map-import.md §3.6): the missing-symbol stub and the dropped templates are listed with their messages.
    expect(report.warningDetails).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "MISSING_SYMBOL", symbolIdx: expect.any(Number) }),
      expect.objectContaining({ code: "TEMPLATES_DROPPED", message: expect.stringContaining("ortho.png") }),
    ]));
    // Stage 5 (docs/map-import.md §3.8): UTM 33N projects; the fixture draws no meridian cluster.
    expect(report.georeference).toMatchObject({ crs: "EPSG:32633", method: "epsg", projectable: true, gridRotationDeg: 2.5 });
    expect(report.north).toMatchObject({ meridian: null, declaredGrivationDeg: 2.5, meridianStalenessDeg: null });
    expect(report.north!.declinationDeg).not.toBeNull();
  });

  it("keeps the two source kinds apart: different importer versions, OCAD path unchanged", async () => {
    expect(importerVersionFor("ocad")).toBe("ocad-10");
    expect(importerVersionFor("omap")).toBe("omap-4");
    const ocd = await importOcadToDocument(ocdFixture, "test.ocd");
    expect(ocd.kind).toBe("ocad");
    expect(mapDocument.readMapDocumentHeader(ocd.bytes).header.format.importer).toBe("ocad-10");
    await expect(importMapToDocument(ocdFixture, "test.ocd", "omap")).rejects.toThrow();
  });

  it("is sniffed as omap at upload (with or without a BOM) and is importable", () => {
    expect(sniffMapKind(fixture.subarray(0, 512))).toBe("omap");
    expect(sniffMapKind(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fixture.subarray(0, 512)]))).toBe("omap");
    expect(IMPORTABLE_KINDS.has("omap")).toBe(true);
    expect(IMPORTABLE_KINDS.has("ocad")).toBe(true);
  });
});
