/**
 * `writePage` and the writer's document-level parts (docs/course-print.md
 * §4.3, §7): operator order (sheet, frame clip, `T_map`, page layer),
 * colour mode, resources shared by many pages, images, page labels,
 * outlines and the `/Measure /GEO` viewport.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, decodePDFRawStream, type PDFObject } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";
import type { PaperFrame } from "../../geo/projection.js";
import { liberation } from "../../render/__tests__/fonts.js";
import { pageScene } from "../__fixtures__/pages.js";
import { composePage, writePage } from "../compose.js";
import type { ColourMode } from "../colour.js";
import type { PageInput } from "../page.js";
import { PdfWriter } from "../writer.js";

const fontsDir = fileURLToPath(new URL("../../../fonts/", import.meta.url));
const faces = [
  { family: "liberation-sans" as const, data: new Uint8Array(readFileSync(fontsDir + "LiberationSans-Regular.ttf")) },
  { family: "liberation-sans-narrow" as const, data: new Uint8Array(readFileSync(fontsDir + "LiberationSansNarrow-Regular.ttf")) },
];
const fonts = () => [liberation().sans, liberation().narrow];
/** A 1 × 1 PNG. */
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const geo: PaperFrame = { unitsPerMm: 1000, mapScale: 10000, georeferencing: { crs: { authority: "EPSG", code: 3006, name: "SWEREF99 TM" }, paperOrigin: { x: 500000, y: 6500000 } } };

async function build(inputs: PageInput[], mode: ColourMode = "cmyk"): Promise<Uint8Array> {
  const w = await PdfWriter.create({ faces, deterministic: true, info: { title: "Test · maps" } });
  for (const input of inputs) await writePage(w, composePage(input, fonts()), { mode, images: new Map([[7, PNG]]) });
  return w.save();
}

const lookup = <T extends PDFObject>(doc: PDFDocument, o: PDFObject | undefined): T => (o instanceof PDFRef ? doc.context.lookup(o) : o) as T;

function content(doc: PDFDocument, pageIdx: number): string {
  const page = doc.getPage(pageIdx).node;
  const c = page.Contents();
  const streams = c instanceof PDFArray ? c.asArray().map((r) => lookup<PDFRawStream>(doc, r)) : [c as unknown as PDFRawStream];
  return streams.map((s) => new TextDecoder().decode(decodePDFRawStream(s).decode())).join("\n");
}

const withLogo = (input: PageInput): PageInput => ({ ...input, objects: [...input.objects, { id: "logo", anchor: "page", kind: "image", graphicId: 7, x: 10, y: 10, width: 20, height: 10 }] });

describe("writePage", () => {
  it("sheet, frame clip, T_map, map passes, then the page layer under µm → pt", async () => {
    const doc = await PDFDocument.load(await build([pageScene("page-sprint-a4")]));
    const ops = content(doc, 0);
    const sheet = ops.indexOf("0 0 0 0 k 0 0 595.276 841.89 re f");
    const clip = ops.indexOf("28.346 28.346 538.583 785.197 re W n");
    expect(sheet).toBe(0);
    expect(clip).toBeGreaterThan(sheet);
    const mapCm = ops.indexOf(" cm", clip);
    // T_map: 4/3 × µm → pt in the layer unit (10/3 µm, 4.4 µm printed), no rotation, the frame
    // centre (105, 148.5) mm less the origin's move onto the 10 µm grid (≤ 5 µm × 4/3).
    const tMap = ops.slice(clip, mapCm + 3).split("\n").at(-1)!.split(" ");
    expect(tMap.slice(0, 4)).toEqual(["0.012598425", "0", "0", "0.012598425"]);
    expect(Math.abs(Number(tMap[4]) - 297.637795276)).toBeLessThan(5 * (4 / 3) * (72 / 25400));
    expect(Math.abs(Number(tMap[5]) - 420.94488189)).toBeLessThan(5 * (4 / 3) * (72 / 25400));
    // Page layer: page µm in 5 µm units → pt.
    const pageCm = ops.lastIndexOf("0.014173228 0 0 0.014173228 0 0 cm");
    expect(pageCm).toBeGreaterThan(mapCm);
    // The frame clip is restored before the page layer starts.
    expect(ops.slice(mapCm, pageCm)).toMatch(/Q\nQ\nq\n$/);
    expect(ops).toMatch(/\/F\d+ [\d.]+ Tf/);
    expect(ops).toMatch(/\/G\d+ Do/);
  });

  it("cmyk writes no rg, rgb no k", async () => {
    const cmyk = content(await PDFDocument.load(await build([pageScene("page-ring")], "cmyk")), 0);
    const rgb = content(await PDFDocument.load(await build([pageScene("page-ring")], "rgb")), 0);
    expect(cmyk).not.toMatch(/ (rg|RG)\b/);
    expect(cmyk).toMatch(/ k\b/);
    expect(rgb).not.toMatch(/ (k|K)\b/);
    expect(rgb).toMatch(/ rg\b/);
  });

  it("rotated window: T_map carries −20° (counter-clockwise on the y-up page)", async () => {
    const ops = content(await PDFDocument.load(await build([pageScene("page-rotated")])), 0);
    // 1:1 → 5 µm units.
    const a = (-20 * Math.PI) / 180, s = (5 * 72) / 25400;
    const f = (v: number) => String(Number(v.toFixed(9)));
    expect(ops).toContain(`${f(Math.cos(a) * s)} ${f(Math.sin(a) * s)} ${f(-Math.sin(a) * s)}`);
  });

  it("two pages share one font object, glyph forms and one image XObject", async () => {
    const doc = await PDFDocument.load(await build([withLogo(pageScene("page-sprint-a4")), withLogo(pageScene("page-sprint-a4"))]));
    expect(doc.getPageCount()).toBe(2);
    const res = [0, 1].map((i) => doc.getPage(i).node.Resources()!);
    const fontRefs = res.map((r) => (r.lookup(PDFName.of("Font"), PDFDict).values() as PDFRef[]).map(String).sort());
    expect(fontRefs[0]).toEqual(fontRefs[1]);
    const xo = res.map((r) => r.lookup(PDFName.of("XObject"), PDFDict));
    const refs = xo.map((d) => d.entries().map(([k, v]) => `${k}=${v}`).sort());
    expect(refs[0]).toEqual(refs[1]);
    const im = xo[0].get(PDFName.of("Im0"));
    expect(lookup<PDFRawStream>(doc, im).dict.get(PDFName.of("Subtype"))).toEqual(PDFName.of("Image"));
    // Page µm under the page layer's cm: (10, 10) mm from the top-left, 20 × 10 mm → lower-left (10, 277) mm.
    expect(content(doc, 0)).toContain("q 20000 0 0 10000 10000 277000 cm /Im0 Do Q");
  });

  it("page labels and one outline item per page", async () => {
    const doc = await PDFDocument.load(await build([pageScene("page-ring"), pageScene("page-rotated")]));
    const labels = doc.catalog.lookup(PDFName.of("PageLabels"), PDFDict);
    const nums = labels.lookup(PDFName.of("Nums"), PDFArray).asArray();
    expect(nums.length).toBe(4);
    const outlines = doc.catalog.lookup(PDFName.of("Outlines"), PDFDict);
    expect(outlines.lookup(PDFName.of("Count"), PDFNumber).asNumber()).toBe(2);
    const first = outlines.lookup(PDFName.of("First"), PDFDict);
    expect(first.lookup(PDFName.of("Title"))!.toString()).toContain("FEFF"); // UTF-16 hex string
    expect(first.get(PDFName.of("Next"))).toBeInstanceOf(PDFRef);
  });

  it("a georeferenced frame gets a /Measure /GEO viewport; none without georeferencing", async () => {
    const doc = await PDFDocument.load(await build([{ ...pageScene("page-rotated"), geo }, pageScene("page-ring")]));
    const vp = doc.getPage(0).node.lookup(PDFName.of("VP"), PDFArray);
    const v = vp.lookup(0, PDFDict);
    expect(v.lookup(PDFName.of("BBox"), PDFArray).asArray().map((n) => (n as PDFNumber).asNumber())).toEqual([22.677, 22.677, 317.48, 232.441]);
    const m = v.lookup(PDFName.of("Measure"), PDFDict);
    expect(m.get(PDFName.of("Subtype"))).toEqual(PDFName.of("GEO"));
    const gpts = m.lookup(PDFName.of("GPTS"), PDFArray).asArray().map((n) => (n as PDFNumber).asNumber());
    expect(gpts).toHaveLength(8);
    // SWEREF99 TM easting 500 000 is the central meridian 15° E; northing 6 500 000 ≈ 58.6° N.
    for (let i = 0; i < 8; i += 2) {
      expect(gpts[i]).toBeCloseTo(58.6, 0);
      expect(gpts[i + 1]).toBeCloseTo(15, 1);
    }
    // Rotated: the frame's lower-left and lower-right corners differ in latitude.
    expect(Math.abs(gpts[0] - gpts[6])).toBeGreaterThan(1e-5);
    expect(doc.getPage(1).node.get(PDFName.of("VP"))).toBeUndefined();
  });

  it("deterministic: equal pages give equal bytes", async () => {
    const a = await build([withLogo(pageScene("page-sprint-a4")), pageScene("page-rotated")]);
    const b = await build([withLogo(pageScene("page-sprint-a4")), pageScene("page-rotated")]);
    expect(Array.from(a).join(",")).toBe(Array.from(b).join(","));
  });

  it("an image object without bytes is skipped with a warning", async () => {
    const w = await PdfWriter.create({ faces, deterministic: true });
    const page = composePage({ ...pageScene("page-ring"), objects: [{ id: "x", anchor: "page", kind: "image", graphicId: 99, x: 0, y: 0, width: 5, height: 5 }] }, fonts());
    const { warnings } = await writePage(w, page, { mode: "cmyk" });
    expect(warnings).toEqual(["IMAGE_MISSING: graphic 99 has no image data; not drawn"]);
  });
});
