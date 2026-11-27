/**
 * `renderCoursePages` in the shared print module (docs/course-print.md
 * §4.5, §6.3, §8.2; G13): fonts, graphics and the SVG rasteriser are
 * inputs; equal inputs give equal bytes; copies share a page; the host is
 * yielded to between sheets. The API's binding (bundled fonts, resvg,
 * `setImmediate`) and the worker are tested in the API
 * (`print-worker.test.ts`, `integration/course-print.test.ts`).
 */

import { PDFArray, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from "@cantoo/pdf-lib";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { defaultMapAppearance } from "../../course-maps/schema.js";
import { resolveSheet, type SheetInput } from "../../course-maps/resolve-sheet.js";
import { PrintGraphicMissingError, type PrintFonts, documentPaperFrame, pageInputFor, renderCoursePages, svgRasterBox } from "../course-pages.js";
import { type PreparedDocument, prepareDocument } from "../prepared-document.js";
import { bundledFontsForTest, printDocumentBytes } from "./print-document.js";

/** A 1 × 1 PNG. */
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');

let doc: PreparedDocument;
let fonts: PrintFonts;

function sheet(label: string, objects: SheetInput["objects"] = []): SheetInput {
  const start = { id: "S1", codes: "", name: "Start 1", status: "start", kind: "start", xpos: -30, ypos: -20 };
  const finish = { id: "F1", codes: "", name: "Mål 1", status: "finish", kind: "finish", xpos: 30, ypos: 20 };
  const controls = [{ id: "c31", codes: "31", xpos: -10, ypos: 5 }, { id: "c32", codes: "32", xpos: 15, ypos: -5 }];
  const { sheet: out } = resolveSheet({
    kind: "course",
    template: {
      paper: "A5",
      orientation: "landscape",
      paperWidthMm: null,
      paperHeightMm: null,
      printScale: 10000,
      settings: { printMarginMm: 3, mapFrame: { x: 8, y: 8, width: 194, height: 132 }, description: { visible: true, x: 150, y: 12, cellSizeMm: 5 }, appearance: defaultMapAppearance },
      objects: [],
    },
    course: { name: label, lengthM: 1200, climbM: 10, start, finish, classes: [{ name: "H21" }], controls },
    mapScale: 10000,
    meridianTiltDeg: 0,
    event: { name: "Test", date: new Date("2026-10-24T00:00:00Z") },
    mapName: label,
  });
  return { ...out, objects: [...out.objects, ...objects] };
}

/** The image XObjects a PDF holds. */
async function imageCount(bytes: Uint8Array): Promise<number> {
  const pdf = await PDFDocument.load(bytes);
  return pdf.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of("Subtype")) === PDFName.of("Image")).length;
}

/** Page 1's content stream, decoded. */
async function pageContent(bytes: Uint8Array): Promise<string> {
  const pdf = await PDFDocument.load(bytes);
  const c = pdf.getPage(0).node.Contents();
  const streams = c instanceof PDFArray ? c.asArray().map((r) => pdf.context.lookup(r) as PDFRawStream) : [c as unknown as PDFRawStream];
  return streams.map((s) => new TextDecoder().decode(decodePDFRawStream(s).decode())).join("\n");
}

const logo = (graphicId: number) => ({ id: `logo${graphicId}`, anchor: "page" as const, kind: "image" as const, graphicId, x: 10, y: 10, width: 20, height: 10 });

beforeAll(async () => {
  doc = await prepareDocument("course-pages", printDocumentBytes);
  fonts = bundledFontsForTest();
});

describe("renderCoursePages (shared)", () => {
  it("equal inputs give equal deterministic bytes", async () => {
    const sheets = [sheet("A"), sheet("B")];
    const a = await renderCoursePages({ document: doc, sheets, fonts, deterministic: true });
    const b = await renderCoursePages({ document: doc, sheets, fonts, deterministic: true });
    expect(a.pageCount).toBe(2);
    expect(a.warnings).toEqual([]);
    expect(a.bytes).toEqual(b.bytes);
    expect((await PDFDocument.load(a.bytes)).getPageCount()).toBe(2);
  });

  it("counts copies into the pages, reports and yields once per composed sheet", async () => {
    const onPage = vi.fn();
    const yieldToHost = vi.fn(async () => {});
    const out = await renderCoursePages({ document: doc, sheets: [{ ...sheet("A"), copies: 3 }, { ...sheet("B"), copies: 0 }, sheet("C")], fonts, deterministic: true, onPage, yieldToHost });
    expect(out.pageCount).toBe(4);
    expect(onPage.mock.calls.map(([p]) => `${p.index}:${p.label}`)).toEqual(["0:A", "2:C"]);
    expect(yieldToHost).toHaveBeenCalledTimes(2);
    expect((await PDFDocument.load(out.bytes)).getPageCount()).toBe(4);
  });

  it("embeds a PNG graphic as given", async () => {
    const out = await renderCoursePages({ document: doc, sheets: [sheet("A", [logo(7)])], fonts, graphics: new Map([[7, { mime: "image/png", data: PNG }]]), deterministic: true });
    expect(out.warnings).toEqual([]);
    // The image and, for this RGBA PNG, its soft mask.
    expect(await imageCount(out.bytes)).toBeGreaterThan(0);
  });

  it("rasterises an SVG graphic through the injected rasteriser, once per size", async () => {
    const rasteriseSvg = vi.fn(async () => PNG);
    const sheets = [sheet("A", [logo(8)]), sheet("B", [logo(8)])];
    const out = await renderCoursePages({ document: doc, sheets, fonts, graphics: new Map([[8, { mime: "image/svg+xml", data: SVG }]]), rasteriseSvg, deterministic: true });
    expect(out.warnings).toEqual([]);
    expect(rasteriseSvg).toHaveBeenCalledTimes(1);
    // The graphic id goes along (G15): a host without the SVG asks its server for that graphic's PNG at the box.
    expect(rasteriseSvg).toHaveBeenCalledWith(SVG, ...svgRasterBox(20, 10), 8);
  });

  it("rasterises a cropped SVG over the union window of its crops on the page, at the box the largest placement needs there (§6.3)", async () => {
    const rasteriseSvg = vi.fn(async () => PNG);
    const left = { ...logo(8), id: "l", crop: { x: 0, y: 0, width: 0.25, height: 0.5 } };
    const right = { ...logo(8), id: "r", x: 40, crop: { x: 0.5, y: 0.5, width: 0.25, height: 0.5 } };
    const out = await renderCoursePages({ document: doc, sheets: [sheet("A", [left, right])], fonts, graphics: new Map([[8, { mime: "image/svg+xml", data: SVG }]]), rasteriseSvg, deterministic: true });
    expect(out.warnings).toEqual([]);
    expect(rasteriseSvg).toHaveBeenCalledTimes(1);
    // Union window [0, 0, 0.75, 1]: each crop is 1/3 of it wide and 1/2 high, so the window is 3 × 2 placed sizes.
    expect(rasteriseSvg).toHaveBeenCalledWith(SVG, ...svgRasterBox(20, 10, { width: 1 / 3, height: 0.5 }), 8, { x: 0, y: 0, width: 0.75, height: 1 });
    // A crop of the window: 3× and 2× its width and height, offset by its place in the window.
    const ops = await pageContent(out.bytes);
    expect(ops).toMatch(/0 0 1 1 re W n 3 0 0 2 -2 0 cm \/Im0 Do Q/);
    expect(ops).toMatch(/0 0 1 1 re W n 3 0 0 2 0 -1 cm \/Im0 Do Q/);
  });

  it("leaves an SVG graphic out with a warning when the host has no rasteriser; the PDF is still written", async () => {
    const out = await renderCoursePages({ document: doc, sheets: [sheet("A", [logo(8)])], fonts, graphics: new Map([[8, { mime: "image/svg+xml", data: SVG }]]), deterministic: true });
    expect(out.pageCount).toBe(1);
    // As when resvg fails on the server: the composer's warning, then the writer's for the image it lacks.
    expect(out.warnings[0]).toBe("A: SVG_RASTER: graphic 8: no SVG rasteriser");
    expect(out.warnings).toHaveLength(2);
    expect(out.warnings[1]).toMatch(/^A: .*IMAGE_MISSING/);
    expect(await imageCount(out.bytes)).toBe(0);
  });
});

describe("a graphic that stands in for a control (CRS-010)", () => {
  /** A map-layer image attached to control c31, with `props` on top of the graphic id. */
  const withObjects = (objects: unknown[]): SheetInput => {
    const base = sheet("A");
    return { ...base, course: { ...base.course, objects } as SheetInput["course"] };
  };
  const hatch = (props: Record<string, unknown>, attach: unknown = { controlId: "c31", at: { x: -10, y: 5 } }) => ({
    id: "h", kind: "image", geometry: [{ x: -15, y: 0 }, { x: -5, y: 10 }], props: { graphicId: 9, ...props }, ...(attach ? { attach } : {}),
  });
  const run = (sheets: SheetInput[], graphics?: Map<number, { mime: "image/png" | "image/svg+xml"; data: Uint8Array }>) =>
    renderCoursePages({ document: doc, sheets, fonts, graphics, deterministic: true });

  it("fails the print when a hiding image has no bytes, naming the control", async () => {
    const err = await run([withObjects([hatch({ hideControlCircle: true })])]).catch((e) => e);
    expect(err).toBeInstanceOf(PrintGraphicMissingError);
    expect(err.message).toMatch(/^A: graphic 9 could not be loaded and it replaces the circle or number of control 31;/);
    await expect(run([withObjects([hatch({ hideControlNumber: true })])])).rejects.toBeInstanceOf(PrintGraphicMissingError);
  });

  it("fails for an SVG without a rasteriser, with the reason", async () => {
    const err = await run([withObjects([hatch({ hideControlCircle: true })])], new Map([[9, { mime: "image/svg+xml", data: SVG }]])).catch((e) => e);
    expect(err).toBeInstanceOf(PrintGraphicMissingError);
    expect(err.message).toContain("no SVG rasteriser");
  });

  it("still warns for the same image without hide flags, a page logo, and a free image with the flags", async () => {
    for (const objects of [[hatch({})], [hatch({ hideControlCircle: true }, null)]]) {
      const out = await run([withObjects(objects)]);
      expect(out.warnings.some((w) => w.includes("IMAGE_MISSING"))).toBe(true);
    }
    const out = await run([sheet("A", [logo(5)])]);
    expect(out.warnings.some((w) => w.includes("IMAGE_MISSING"))).toBe(true);
  });

  it("prints when the hiding image's bytes are there", async () => {
    const out = await run([withObjects([hatch({ hideControlCircle: true })])], new Map([[9, { mime: "image/png", data: PNG }]]));
    expect(out.pageCount).toBe(1);
  });
});

describe("svgRasterBox (§6.3)", () => {
  it("is 600 dpi of the placed size, at most 4096 px a side, the crop enlarging the source", () => {
    expect(svgRasterBox(25.4, 12.7)).toEqual([600, 300]);
    expect(svgRasterBox(254, 25.4)).toEqual([4096, 410]);
    expect(svgRasterBox(25.4, 12.7, { width: 0.5, height: 1 })).toEqual([1200, 300]);
  });
});

describe("pageInputFor", () => {
  it("adds the window's document objects, the document context and no /GEO without a CRS", () => {
    const geo = documentPaperFrame(doc);
    expect(geo).toBeNull();
    const input = pageInputFor(doc, sheet("A"), geo);
    expect(input.map.objects.length).toBeLessThan(doc.input.objects.length);
    expect(input.map.context.libraryId).toBe("ISOM2017-2");
    expect(input.map.cutFeatures).toBe(doc.cutFeatures);
    expect(input.geo).toBeNull();
  });
});
