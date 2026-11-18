/**
 * §3.9 opacity and blend in the PDF (slice J, J1): ExtGStates per distinct
 * pair, a page transparency group only where used, glyph and text passes
 * through an isolated transparency-group form, nothing for an opaque stream.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, type PDFObject, PDFRawStream, PDFRef, decodePDFRawStream } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";
import { renderFixtures } from "../../render/__fixtures__/streams/index.js";
import type { FontRef, GlyphMesh, PassStream } from "../../render/pass-stream.js";
import { passStreamFromJson } from "../../render/stream-json.js";
import { liberation } from "../../render/__tests__/fonts.js";
import type { ColourMode } from "../colour.js";
import { type OperatorResources, layerMatrix, mapLayerOperators, passStreamOperators } from "../operators.js";
import { PdfWriter } from "../writer.js";

const stack = [0, 1, 2, 3, 4, 5, 6, 7].map(() => ({ cmyk: [0, 0, 0, 1] as [number, number, number, number] }));
const fontsDir = fileURLToPath(new URL("../../../fonts/", import.meta.url));
const faces = [{ family: "liberation-sans" as const, data: new Uint8Array(readFileSync(fontsDir + "LiberationSans-Regular.ttf")) }];
const fixture = (name: keyof typeof renderFixtures) => passStreamFromJson(renderFixtures[name]);

function fakeResources() {
  const alphas: string[] = [];
  const groups: { bbox: number[]; content: string }[] = [];
  const glyphs: GlyphMesh[] = [];
  const res: OperatorResources = {
    font: (_f: FontRef) => "F1",
    glyph: (mesh) => {
      if (!glyphs.includes(mesh)) glyphs.push(mesh);
      return `G${glyphs.indexOf(mesh) + 1}`;
    },
    alpha: (opacity, blend, mode) => {
      const k = `${opacity ?? 1}/${blend ?? "normal"}/${mode}`;
      if (!alphas.includes(k)) alphas.push(k);
      return `GS${alphas.indexOf(k)}`;
    },
    group: (bbox, draw) => {
      const content = draw(res);
      if (!content) return undefined;
      groups.push({ bbox, content });
      return `TG${groups.length - 1}`;
    },
  };
  return { res, alphas, groups };
}

const ops = (s: PassStream, res: OperatorResources, mode: ColourMode = "cmyk") => passStreamOperators(s, { colours: stack, mode, resources: res });

describe("§3.9 operators", () => {
  it("a fill, stroke and hatch with alpha draw inside q /GSn gs … Q; the colour is written again after", () => {
    const { res, alphas } = fakeResources();
    const o = ops(fixture("alpha-passes"), res).split("\n");
    // The black fill at 50 %: q, gs, colour, path f*, Q.
    // (The stack is all black, so the fill colour set before is inherited inside q … Q.)
    const at = o.findIndex((l, i) => / gs$/.test(l) && / f\* Q$/.test(o[i + 1] ?? ""));
    expect(at).toBeGreaterThan(0);
    expect(o[at - 1]).toBe("q");
    expect(o[at + 2]).toBe("Q");
    // A stroke colour set inside an alpha pass's q … Q is written again by the next one (the tracker is restored with the state).
    const strokes = o.map((l, i) => (l === "0 0 0 1 K" ? i : -1)).filter((i) => i >= 0);
    expect(strokes.length).toBeGreaterThan(1);
    expect(alphas).toContain("0.5/normal/cmyk");
    expect(alphas).toContain("0.25/normal/cmyk");
    // Every q has its Q.
    expect(o.filter((l) => l === "q" || l.startsWith("q ")).length).toBe(o.filter((l) => l === "Q" || l.endsWith(" Q")).length);
  });

  it("a glyph pass with alpha draws one transparency-group form under the ExtGState", () => {
    const { res, groups } = fakeResources();
    const o = ops(fixture("alpha-passes"), res);
    expect(o).toMatch(/q \/GS0 gs \/TG0 Do Q/);
    expect(groups).toHaveLength(2);
    // The form's content is self-contained: its own colour, then the instances.
    expect(groups[0].content.split("\n")[0]).toMatch(/ k$/);
    expect(groups[0].content).toContain("/G1 Do");
    // The clipped one keeps its clip inside the form.
    expect(groups[1].content).toContain("W* n");
    for (const g of groups) expect(g.bbox[2]).toBeGreaterThan(g.bbox[0]);
  });

  it("a text pass and its halo with alpha draw through their own forms, halo with 1 Tr inside", () => {
    const { res, groups } = fakeResources();
    const o = ops(fixture("alpha-text"), res);
    expect(o.match(/\/TG\d Do/g)).toHaveLength(2);
    expect(groups.some((g) => g.content.includes("1 Tr"))).toBe(true);
    expect(groups.every((g) => g.content.includes("BT") && g.content.includes("ET"))).toBe(true);
  });

  it("Multiply alone is ca 1 with /BM; with opacity both", () => {
    const { res, alphas } = fakeResources();
    ops(fixture("blend-multiply"), res, "rgb");
    expect(alphas).toEqual(["1/multiply/rgb", "0.5/multiply/rgb"]);
  });

  it("a culled alpha pass writes nothing and asks for nothing", () => {
    const { res, alphas, groups } = fakeResources();
    // Fills, strokes and glyphs are culled (hatches never are, map-rendering §5.3).
    const o = passStreamOperators(fixture("blend-multiply"), { colours: stack, mode: "cmyk", resources: res, cull: { minX: 100000, minY: 100000, maxX: 110000, maxY: 110000 } });
    expect(o).not.toContain("gs");
    expect(alphas).toEqual([]);
    expect(groups).toEqual([]);
  });

  it("an alpha pass under a filter mask stays inside the mask's clip", () => {
    const { res } = fakeResources();
    const j = renderFixtures["alpha-passes"];
    const masks = [{ regions: [{ coords: [0, 0, 5000, 0, 5000, 5000, 0, 5000], closed: true }] }];
    const maskIdx = j.passes.map((_, i) => (i === 2 ? 0 : -1));
    const o = ops(passStreamFromJson({ ...j, masks, maskIdx }), res).split("\n");
    // The mask's frame clip opens with q and is closed by the next Q at its depth; the fill's gs lies inside.
    const clip = o.findIndex((l) => l.endsWith("W* n") && l.startsWith("-"));
    expect(clip).toBeGreaterThan(0);
    let depth = 0, end = -1;
    for (let i = clip + 1; i < o.length && end < 0; i++) {
      if (o[i] === "q" || o[i].startsWith("q ")) depth++;
      if (o[i] === "Q" || o[i].endsWith(" Q")) { if (depth === 0) end = i; else depth--; }
    }
    const gs = o.findIndex((l, i) => i > clip && / gs$/.test(l));
    expect(gs).toBeGreaterThan(clip);
    expect(gs).toBeLessThan(end);
  });

  it("an opaque stream asks for no alpha resource and writes no gs", () => {
    for (const name of ["fill-with-holes", "dashed-bezier-stroke", "glyph-instances", "hatch-area", "colour-order", "text-with-halo"] as const) {
      const { res, alphas, groups } = fakeResources();
      expect(ops(fixture(name), res)).not.toContain(" gs");
      expect(alphas).toEqual([]);
      expect(groups).toEqual([]);
    }
  });

  it("without an alpha resource (an older writer) alpha passes draw opaque, as before", () => {
    const { res } = fakeResources();
    const { alpha: _a, group: _g, ...plain } = res;
    const o = ops(fixture("alpha-passes"), plain);
    expect(o).not.toContain("gs");
    expect(o).toContain("/G1 Do");
  });
});

function resolve<T extends PDFObject>(doc: PDFDocument, o: PDFObject | undefined, type: { prototype: T }): T {
  const r = o instanceof PDFRef ? doc.context.lookup(o) : o;
  expect(r).toBeInstanceOf(type);
  return r as T;
}
const get = (d: PDFDict, key: string) => d.get(PDFName.of(key));
const nameOf = (d: PDFDict, key: string) => (get(d, key) as PDFName | undefined)?.decodeText();
const num = (d: PDFDict, key: string) => (get(d, key) as PDFNumber).asNumber();

async function pdf(pages: PassStream[], mode: ColourMode): Promise<{ bytes: Uint8Array; doc: PDFDocument }> {
  const w = await PdfWriter.create({ faces, deterministic: true });
  for (const s of pages) {
    const page = w.addPage({ widthPt: 200, heightPt: 200 });
    page.addContent(mapLayerOperators(s, { colours: stack, mode, resources: page.resources, matrix: layerMatrix({ scaleRatio: 1, atPt: [10, 10] }) }));
  }
  const bytes = await w.save();
  return { bytes, doc: await PDFDocument.load(bytes, { updateMetadata: false }) };
}

describe("§3.9 PdfWriter", () => {
  it("one ExtGState per distinct pair across pages; the page group only on pages that use one", async () => {
    const { doc } = await pdf([fixture("alpha-passes"), fixture("fill-with-holes"), fixture("blend-multiply")], "cmyk");
    const ext = (i: number) => {
      const r = doc.getPage(i).node.Resources()!;
      const e = get(r, "ExtGState");
      return e ? resolve(doc, e, PDFDict) : undefined;
    };
    const e0 = ext(0)!;
    expect(e0.keys().map((k) => k.decodeText()).sort()).toEqual(["GS0", "GS1"]);
    const gs0 = resolve(doc, e0.get(PDFName.of("GS0")), PDFDict);
    expect(nameOf(gs0, "Type")).toBe("ExtGState");
    expect(num(gs0, "ca")).toBe(0.5);
    expect(num(gs0, "CA")).toBe(0.5);
    expect(get(gs0, "BM")).toBeUndefined();
    expect(ext(1)?.keys() ?? []).toEqual([]);
    const e2 = ext(2)!;
    const names = e2.keys().map((k) => k.decodeText()).sort();
    expect(names).toEqual(["GS2", "GS3"]);
    expect(nameOf(resolve(doc, e2.get(PDFName.of("GS2")), PDFDict), "BM")).toBe("Multiply");
    const group = (i: number) => doc.getPage(i).node.get(PDFName.of("Group"));
    const g0 = resolve(doc, group(0), PDFDict);
    expect(nameOf(g0, "S")).toBe("Transparency");
    expect(nameOf(g0, "CS")).toBe("DeviceCMYK");
    expect(group(1)).toBeUndefined();
  });

  it("the page group is DeviceRGB in rgb mode", async () => {
    const { doc } = await pdf([fixture("blend-multiply")], "rgb");
    expect(nameOf(resolve(doc, doc.getPage(0).node.get(PDFName.of("Group")), PDFDict), "CS")).toBe("DeviceRGB");
  });

  it("a glyph pass's form is an isolated transparency group with its own resources", async () => {
    const { doc } = await pdf([fixture("alpha-passes")], "cmyk");
    const xo = resolve(doc, get(doc.getPage(0).node.Resources()!, "XObject"), PDFDict);
    const tg = xo.keys().map((k) => k.decodeText()).filter((k) => k.startsWith("TG"));
    expect(tg).toHaveLength(2);
    const form = resolve(doc, xo.get(PDFName.of(tg[0])), PDFRawStream);
    expect(nameOf(form.dict, "Subtype")).toBe("Form");
    const g = resolve(doc, get(form.dict, "Group"), PDFDict);
    expect(nameOf(g, "S")).toBe("Transparency");
    expect(get(g, "I")?.toString()).toBe("true");
    const formXo = resolve(doc, get(resolve(doc, get(form.dict, "Resources"), PDFDict), "XObject"), PDFDict);
    expect(formXo.keys().map((k) => k.decodeText())).toEqual(["G0"]);
    expect(resolve(doc, get(form.dict, "BBox"), PDFArray).size()).toBe(4);
    const content = new TextDecoder("latin1").decode(decodePDFRawStream(form).decode());
    expect(content).toContain("/G0 Do");
  });

  it("text with alpha keeps the font in the form's resources", async () => {
    const { doc } = await pdf([fixture("alpha-text")], "cmyk");
    const xo = resolve(doc, get(doc.getPage(0).node.Resources()!, "XObject"), PDFDict);
    const tg = xo.keys().map((k) => k.decodeText()).filter((k) => k.startsWith("TG"));
    expect(tg).toHaveLength(2);
    for (const k of tg) {
      const form = resolve(doc, xo.get(PDFName.of(k)), PDFRawStream);
      const fonts = resolve(doc, get(resolve(doc, get(form.dict, "Resources"), PDFDict), "Font"), PDFDict);
      expect(fonts.keys()).toHaveLength(1);
    }
  });

  it("a copied page keeps its transparency group", async () => {
    const w = await PdfWriter.create({ faces, deterministic: true });
    const page = w.addPage({ widthPt: 200, heightPt: 200 });
    page.addContent(mapLayerOperators(fixture("blend-multiply"), { colours: stack, mode: "cmyk", resources: page.resources, matrix: layerMatrix({ scaleRatio: 1, atPt: [10, 10] }) }));
    w.copyPage(page, 1);
    const doc = await PDFDocument.load(await w.save(), { updateMetadata: false });
    expect(doc.getPage(1).node.get(PDFName.of("Group"))).toBeDefined();
  });

  it("is deterministic", async () => {
    const a = await pdf([fixture("alpha-passes"), fixture("alpha-text")], "cmyk");
    const b = await pdf([fixture("alpha-passes"), fixture("alpha-text")], "cmyk");
    expect(Array.from(a.bytes).join(",")).toBe(Array.from(b.bytes).join(","));
  });
});

void liberation;
