import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mapDocument, render } from "@oxygen/shared";
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
    expect(doc.header.colours.length).toBe(a.counts.colours);
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

  it("honours the renderFor hook (pilot symbols by code)", async () => {
    const byCode = new Map(render.pilotSymbols.map((s) => [s.code, s]));
    const { bytes } = await importOcadToDocument(fixture, "test.ocd", {
      renderFor: (s) => byCode.get(String(Math.floor(s.symNum / 1000))) ?? null,
    });
    const doc = mapDocument.decodeMapDocument(bytes);
    const rendered = doc.header.symbols.filter((s) => s.render);
    expect(rendered.length).toBeGreaterThan(0);
    const dropMode = mapDocument.documentRenderInput(doc, { unmatched: "drop" });
    expect(dropMode.stats.rendered).toBeGreaterThan(0);
    expect(dropMode.stats.proxied).toBe(0);
  });
});
