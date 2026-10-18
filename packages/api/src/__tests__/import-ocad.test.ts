import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mapDocument, render, symbolLibrary } from "@oxygen/shared";
import { importOcadToDocument, sha256Hex } from "../import/ocad.js";

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
    expect(byCode.get("702.0")).toMatchObject({ type: "point", glyph: { parts: [{ kind: "ring", diameterUm: 6000, widthUm: 350 }] } });
    expect(byCode.get("403.0")).toMatchObject({ type: "area" });
    const input = mapDocument.documentRenderInput(doc, { unmatched: "drop" });
    expect(input.stats.rendered).toBeGreaterThan(0);
    expect(input.stats.proxied).toBe(0);
    expect(input.stats.dropped).toBe(0);
    const { stream } = render.symbolise({ objects: input.objects, symbols: input.symbols, fonts: [] });
    expect(stream.passes.length).toBeGreaterThan(0);
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
    expect(result.matching.symbols).toMatchObject({ auto: 3, unmatched: 0 });
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
