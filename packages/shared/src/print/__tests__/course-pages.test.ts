/**
 * `renderCoursePages` in the shared print module (docs/course-print.md
 * §4.5, §6.3, §8.2; G13): fonts, graphics and the SVG rasteriser are
 * inputs; equal inputs give equal bytes; copies share a page; the host is
 * yielded to between sheets. The API's binding (bundled fonts, resvg,
 * `setImmediate`) and the worker are tested in the API
 * (`print-worker.test.ts`, `integration/course-print.test.ts`).
 */

import { PDFDocument } from "@cantoo/pdf-lib";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { defaultMapAppearance } from "../../course-maps/schema.js";
import { resolveSheet, type SheetInput } from "../../course-maps/resolve-sheet.js";
import { type PrintFonts, documentPaperFrame, pageInputFor, renderCoursePages, svgRasterBox } from "../course-pages.js";
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
  });

  it("rasterises an SVG graphic through the injected rasteriser, once per size", async () => {
    const rasteriseSvg = vi.fn(async () => PNG);
    const sheets = [sheet("A", [logo(8)]), sheet("B", [logo(8)])];
    const out = await renderCoursePages({ document: doc, sheets, fonts, graphics: new Map([[8, { mime: "image/svg+xml", data: SVG }]]), rasteriseSvg, deterministic: true });
    expect(out.warnings).toEqual([]);
    expect(rasteriseSvg).toHaveBeenCalledTimes(1);
    expect(rasteriseSvg).toHaveBeenCalledWith(SVG, ...svgRasterBox(20, 10));
  });

  it("leaves an SVG graphic out with a warning when the host has no rasteriser; the PDF is still written", async () => {
    const out = await renderCoursePages({ document: doc, sheets: [sheet("A", [logo(8)])], fonts, graphics: new Map([[8, { mime: "image/svg+xml", data: SVG }]]), deterministic: true });
    expect(out.pageCount).toBe(1);
    // As when resvg fails on the server: the composer's warning, then the writer's for the image it lacks.
    expect(out.warnings[0]).toBe("A: SVG_RASTER: graphic 8: no SVG rasteriser");
    expect(out.warnings.slice(1).every((w) => w.startsWith("A: ") && /IMAGE_MISSING|graphic 8/.test(w))).toBe(true);
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
