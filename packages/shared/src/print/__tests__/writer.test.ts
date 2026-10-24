/**
 * Tier 2 (research 05 §7): the written file's structure — pages and
 * boxes, the font dictionary chain, the embedded subset, form XObjects,
 * deterministic bytes.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  type PDFObject,
  PDFRawStream,
  PDFRef,
  decodePDFRawStream,
} from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";
import { libraryScene } from "../../render/__fixtures__/library/index.js";
import { renderFixtures } from "../../render/__fixtures__/streams/index.js";
import { passStreamFromJson } from "../../render/stream-json.js";
import { parseTrueType } from "../../render/truetype.js";
import { parseRenderSymbol } from "../../render/symbol.js";
import { makePath } from "../../render/pass-stream.js";
import { symbolise } from "../../render/symbolise.js";
import { type ColourMode } from "../colour.js";
import { layerMatrix, mapLayerOperators } from "../operators.js";
import { PdfWriter, type PdfWriterOptions } from "../writer.js";

const fontsDir = fileURLToPath(new URL("../../../fonts/", import.meta.url));
const face = (file: string) => new Uint8Array(readFileSync(fontsDir + file));
const faces = [
  { family: "liberation-sans" as const, data: face("LiberationSans-Regular.ttf") },
  { family: "liberation-sans-narrow" as const, data: face("LiberationSansNarrow-Regular.ttf") },
];
const boldData = face("LiberationSans-Bold.ttf");
const sans = parseTrueType(faces[0].data.slice().buffer, "liberation-sans");
const boldSans = parseTrueType(boldData.slice().buffer, "liberation-sans");
const narrow = parseTrueType(faces[1].data.slice().buffer, "liberation-sans-narrow");

const A4: [number, number] = [595.276, 841.89];

/** Two A4 pages: the text scene and the pattern scene, each as a map layer at 1:1. */
async function build(opts: Partial<PdfWriterOptions> = {}, mode: ColourMode = "cmyk"): Promise<Uint8Array> {
  const w = await PdfWriter.create({ faces, deterministic: true, info: { title: "Test · Course 1", author: "OK Test" }, ...opts });
  for (const name of ["lib-text", "lib-pattern"] as const) {
    const scene = libraryScene(name);
    const { stream } = symbolise({ objects: scene.objects, symbols: scene.symbols, fonts: [sans, narrow] });
    const page = w.addPage({ widthPt: A4[0], heightPt: A4[1] });
    page.addContent(
      mapLayerOperators(stream, { colours: scene.colours, mode, resources: page.resources, matrix: layerMatrix({ scaleRatio: 1, atPt: [50, 400] }) }),
    );
  }
  return w.save();
}

/** Byte equality as one comparable value (no node:crypto in the shared package's types). */
const bytesKey = (b: Uint8Array) => Array.from(b).join(",");

function resolve<T extends PDFObject>(doc: PDFDocument, o: PDFObject | undefined, type: { prototype: T }): T {
  const r = o instanceof PDFRef ? doc.context.lookup(o) : o;
  expect(r).toBeInstanceOf(type);
  return r as T;
}
const get = (d: PDFDict, key: string) => d.get(PDFName.of(key));
const nameOf = (d: PDFDict, key: string) => (get(d, key) as PDFName | undefined)?.decodeText();
const text = (s: PDFRawStream) => new TextDecoder("latin1").decode(decodePDFRawStream(s).decode());
/** A page's content, all its streams concatenated. */
function pageContent(doc: PDFDocument, i: number): string {
  const c = doc.getPage(i).node.Contents();
  const arr = c instanceof PDFArray ? c.asArray() : [c];
  return arr.map((o) => (o ? text(resolve(doc, o, PDFRawStream)) : "")).join("\n");
}

describe("PdfWriter", async () => {
  const bytes = await build();
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });

  it("writes PDF 1.7 with one page per addPage, MediaBox and TrimBox = the paper", () => {
    expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe("%PDF-1.7");
    expect(doc.getPageCount()).toBe(2);
    const p = doc.getPage(0);
    expect(p.getMediaBox()).toEqual({ x: 0, y: 0, width: A4[0], height: A4[1] });
    expect(p.getTrimBox()).toEqual({ x: 0, y: 0, width: A4[0], height: A4[1] });
  });

  it("writes Info with fixed dates when deterministic", () => {
    expect(doc.getTitle()).toBe("Test · Course 1");
    expect(doc.getAuthor()).toBe("OK Test");
    expect(doc.getCreator()).toBe("Oxygen");
    expect(doc.getCreationDate()?.toISOString()).toBe("2000-01-01T00:00:00.000Z");
    expect(doc.getModificationDate()?.toISOString()).toBe("2000-01-01T00:00:00.000Z");
  });

  it("embeds each used face once as a subset CIDFontType2 with Identity-H and ToUnicode", () => {
    const fonts = resolve(doc, get(doc.getPage(0).node.Resources()!, "Font"), PDFDict);
    const keys = fonts.keys().map((k) => k.decodeText());
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      const type0 = resolve(doc, fonts.get(PDFName.of(k)), PDFDict);
      expect(nameOf(type0, "Subtype")).toBe("Type0");
      expect(nameOf(type0, "Encoding")).toBe("Identity-H");
      expect(nameOf(type0, "BaseFont")).toMatch(/^[A-Z]{6}\+LiberationSans(Narrow)?$/);
      expect(text(resolve(doc, get(type0, "ToUnicode"), PDFRawStream))).toContain("beginbfchar");
      const cid = resolve(doc, resolve(doc, get(type0, "DescendantFonts"), PDFArray).get(0), PDFDict);
      expect(nameOf(cid, "Subtype")).toBe("CIDFontType2");
      expect(nameOf(cid, "CIDToGIDMap")).toBe("Identity");
      expect(resolve(doc, get(cid, "W"), PDFArray).size()).toBeGreaterThan(0);
      const desc = resolve(doc, get(cid, "FontDescriptor"), PDFDict);
      expect(nameOf(desc, "FontName")).toBe(nameOf(type0, "BaseFont"));
      const file = resolve(doc, get(desc, "FontFile2"), PDFRawStream);
      const program = decodePDFRawStream(file).decode();
      expect((get(file.dict, "Length1") as PDFNumber).asNumber()).toBe(program.length);
      expect(program.length).toBeLessThan(faces[0].data.length / 4);
    }
  });

  it("embeds a bold face as its own font object next to the regular one", async () => {
    const mk = (id: string, weight: number) => parseRenderSymbol({ type: "text", id, code: id, name: id, fontFamily: "liberation-sans", fontSizeUm: 4000, weight, colour: 0 });
    const { stream } = symbolise({
      objects: [{ symbolIdx: 0, path: makePath([0, 0]), text: "Regular" }, { symbolIdx: 1, path: makePath([0, 5000]), text: "Bold" }],
      symbols: [mk("r", 400), mk("b", 700)],
      fonts: [sans, boldSans],
    });
    expect(stream.fontTable.map((f) => f.bold)).toEqual([false, true]);
    const w = await PdfWriter.create({ faces: [...faces, { family: "liberation-sans", data: boldData }], deterministic: true });
    const page = w.addPage({ widthPt: 200, heightPt: 200 });
    page.addContent(mapLayerOperators(stream, { colours: libraryScene("lib-text").colours, mode: "cmyk", resources: page.resources, matrix: layerMatrix({ scaleRatio: 1, atPt: [10, 100] }) }));
    const d = await PDFDocument.load(await w.save(), { updateMetadata: false });
    const fonts = resolve(d, get(d.getPage(0).node.Resources()!, "Font"), PDFDict);
    const names = fonts.keys().map((k) => nameOf(resolve(d, fonts.get(k), PDFDict), "BaseFont")).sort();
    expect(names).toHaveLength(2);
    expect(names.some((n) => /^[A-Z]{6}\+LiberationSans$/.test(n ?? ""))).toBe(true);
    expect(names.some((n) => /^[A-Z]{6}\+LiberationSans-Bold$/.test(n ?? ""))).toBe(true);
  });

  it("subsets to the glyphs the content draws, by their own ids", () => {
    const fonts = resolve(doc, get(doc.getPage(0).node.Resources()!, "Font"), PDFDict);
    const content = pageContent(doc, 0);
    const drawn = new Set([...content.matchAll(/<([0-9A-F]{4})> Tj/g)].map((m) => parseInt(m[1], 16)));
    expect(drawn.size).toBeGreaterThan(3);
    const toUnicode = fonts
      .keys()
      .map((k) => text(resolve(doc, get(resolve(doc, fonts.get(k), PDFDict), "ToUnicode"), PDFRawStream)))
      .join("\n");
    for (const g of drawn) {
      if (sans.glyphId(0x20) === g) continue; // space has a mapping too, but no outline
      expect(toUnicode).toContain(`<${g.toString(16).toUpperCase().padStart(4, "0")}>`);
    }
  });

  it("shares one form XObject per glyph part across pages", () => {
    const xo = get(doc.getPage(1).node.Resources()!, "XObject");
    const dict = resolve(doc, xo, PDFDict);
    const form = resolve(doc, dict.get(dict.keys()[0]), PDFRawStream);
    expect(nameOf(form.dict, "Subtype")).toBe("Form");
    expect(resolve(doc, get(form.dict, "BBox"), PDFArray).size()).toBe(4);
    const content = pageContent(doc, 1);
    expect(content).toMatch(/ \/G\d+ Do\b/);
    expect(content).toContain("W* n");
  });

  it("gives a glyph form the /Matrix it is drawn through, one form per part and matrix", async () => {
    const w = await PdfWriter.create({ deterministic: true });
    const page = w.addPage({ widthPt: 100, heightPt: 100 });
    const mesh = passStreamFromJson(renderFixtures["glyph-instances"]).glyphTable[0];
    const plain = page.resources.glyph(mesh);
    const unit = page.resources.glyph(mesh, [0.1, 0, 0, 0.1, 0, 0]);
    expect(page.resources.glyph(mesh, [0.1, 0, 0, 0.1, 0, 0])).toBe(unit);
    expect(page.resources.glyph(mesh, [1, 0, 0, 1, 0, 0])).toBe(plain);
    expect(unit).not.toBe(plain);
    page.addContent(`q /${plain} Do Q q /${unit} Do Q`);
    const d = await PDFDocument.load(await w.save(), { updateMetadata: false });
    const xo = resolve(d, get(d.getPage(0).node.Resources()!, "XObject"), PDFDict);
    const matrix = (name: string) => resolve(d, xo.get(PDFName.of(name)), PDFRawStream).dict.get(PDFName.of("Matrix"));
    expect(matrix(plain)).toBeUndefined();
    expect(resolve(d, matrix(unit), PDFArray).asArray().map(String)).toEqual(["0.1", "0", "0", "0.1", "0", "0"]);
  });

  it("is byte-identical across runs when deterministic", async () => {
    expect(bytesKey(await build())).toBe(bytesKey(bytes));
    expect(bytesKey(await build({}, "rgb"))).toBe(bytesKey(await build({}, "rgb")));
  });

  it("gets real dates and a random /ID when not deterministic", async () => {
    const a = await build({ deterministic: false, now: new Date("2026-10-23T12:00:00Z") });
    const b = await build({ deterministic: false, now: new Date("2026-10-23T12:00:00Z") });
    expect(bytesKey(a)).not.toBe(bytesKey(b));
    const d = await PDFDocument.load(a, { updateMetadata: false });
    expect(d.getCreationDate()?.toISOString()).toBe("2026-10-23T12:00:00.000Z");
  });

  it("falls back to outlines with a warning when a face cannot be subset", async () => {
    const broken = faces[0].data.slice();
    // Rename `loca`: the reader still parses (outlines are optional to it), the subsetter cannot work.
    const dv = new DataView(broken.buffer);
    for (let i = 0; i < dv.getUint16(4); i++) {
      const o = 12 + i * 16;
      if (String.fromCharCode(...broken.subarray(o, o + 4)) === "loca") broken[o] = "x".charCodeAt(0);
    }
    const w = await PdfWriter.create({ faces: [{ family: "liberation-sans", data: broken }], deterministic: true });
    expect(w.warnings).toEqual([expect.stringMatching(/^PDF_FONT_OUTLINES: liberation-sans cannot be subset/)]);
    expect(w.addPage({ widthPt: 100, heightPt: 100 }).resources.font({ fontId: 0, family: "liberation-sans", bold: false, italic: false }, [1])).toBeUndefined();
  });

  it("draws text as outlines without fonts in outline mode (the 05 §5.6 fallback)", async () => {
    const d = await PDFDocument.load(await build({ text: "outline" }), { updateMetadata: false });
    const fonts = get(d.getPage(0).node.Resources()!, "Font");
    expect(fonts ? resolve(d, fonts, PDFDict).keys() : []).toEqual([]);
    const content = pageContent(d, 0);
    expect(content).not.toContain("BT");
    expect(content).toMatch(/ f\* Q/);
  });
});
