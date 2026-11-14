/**
 * `renderPrintJob` (docs/course-print.md §8.5, G15): a job composed
 * through the host gives the bytes `renderCoursePages` gives for the same
 * inputs — the guarantee slice G answer 3 rests on — and a job parsed
 * from JSON composes alike.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";
import { defaultMapAppearance } from "../../course-maps/schema.js";
import { resolveSheet, type SheetInput } from "../../course-maps/resolve-sheet.js";
import { type PrintFonts, renderCoursePages, svgRasterBox } from "../course-pages.js";
import { PRINT_JOB_VERSION, type PrintJob, type PrintJobHost, renderPrintJob } from "../print-job.js";
import { prepareDocument } from "../prepared-document.js";
import { bundledFontsForTest, printDocumentBytes } from "./print-document.js";
import { FIXTURE_PNG, fixtureGraphics, fixturePrintJob } from "./print-job-fixture.js";

/** A 1 × 1 PNG. */
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
const HASH = "print-job-fixture";

let fonts: PrintFonts;

function sheet(label: string, objects: SheetInput["objects"] = []): SheetInput {
  const start = { id: "S1", codes: "", name: "Start 1", status: "start", kind: "start", xpos: -30, ypos: -20 };
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
    course: { name: label, lengthM: 1200, climbM: 10, start, finish: null, classes: [{ name: "H21" }], controls },
    mapScale: 10000,
    meridianTiltDeg: 0,
    event: { name: "Test", date: new Date("2026-10-24T00:00:00Z") },
    mapName: label,
  });
  return { ...out, objects: [...out.objects, ...objects] };
}

const logo = (graphicId: number, x = 10) => ({ id: `logo${graphicId}`, anchor: "page" as const, kind: "image" as const, graphicId, x, y: 10, width: 20, height: 10 });

function job(sheets: PrintJob["sheets"], graphics: PrintJob["graphics"] = []): PrintJob {
  return { version: PRINT_JOB_VERSION, document: { hash: HASH, rotationCorrectionDeg: 0 }, sheets, graphics, mode: "cmyk", info: { title: "Test maps" }, filename: "test_maps.pdf" };
}

function host(over: Partial<PrintJobHost> = {}): PrintJobHost {
  return {
    document: () => printDocumentBytes(),
    fonts,
    graphic: vi.fn(async () => PNG),
    deterministic: true,
    ...over,
  };
}

beforeAll(() => {
  fonts = bundledFontsForTest();
});

describe("renderPrintJob (§8.5)", () => {
  it("gives renderCoursePages' bytes for the same inputs, the PNG fetched as stored and the SVG asked by id at the composer's box", async () => {
    const sheets = [{ ...sheet("A", [logo(7), logo(8, 40)]), copies: 2 }, sheet("B", [logo(8, 40)])];
    const graphic = vi.fn(async (_id: number, _box?: [number, number]) => PNG);
    const out = await renderPrintJob(job(sheets, [{ id: 7, mime: "image/png" }, { id: 8, mime: "image/svg+xml" }]), host({ graphic }));
    expect(out.warnings).toEqual([]);
    expect(out.pageCount).toBe(3);
    // PNG once without a box; the SVG once per box (cached across pages), by id.
    expect(graphic.mock.calls).toEqual([[7], [8, svgRasterBox(20, 10)]]);

    const document = await prepareDocument(HASH, printDocumentBytes);
    const direct = await renderCoursePages({
      document,
      sheets,
      fonts,
      graphics: new Map([[7, { mime: "image/png", data: PNG }], [8, { mime: "image/svg+xml", data: SVG }]]),
      rasteriseSvg: async () => PNG,
      mode: "cmyk",
      info: { title: "Test maps" },
      deterministic: true,
    });
    expect(out.bytes).toEqual(direct.bytes);
  });

  it("a job parsed from JSON composes to the same bytes", async () => {
    const j = job([sheet("A", [logo(7)]), sheet("B")], [{ id: 7, mime: "image/png" }]);
    const a = await renderPrintJob(j, host());
    const b = await renderPrintJob(JSON.parse(JSON.stringify(j)) as PrintJob, host());
    expect(b.bytes).toEqual(a.bytes);
  });

  it("a graphic the host cannot fetch is left out with the server's warnings; the PDF is still written", async () => {
    const graphic = vi.fn(async () => {
      throw new Error("offline");
    });
    const out = await renderPrintJob(job([sheet("A", [logo(7), logo(8, 40)])], [{ id: 7, mime: "image/png" }, { id: 8, mime: "image/svg+xml" }]), host({ graphic }));
    expect(out.pageCount).toBe(1);
    expect(out.warnings[0]).toBe("A: SVG_RASTER: graphic 8: offline");
    expect(out.warnings.filter((w) => /IMAGE_MISSING: graphic 7/.test(w))).toHaveLength(1);
    expect(out.warnings.filter((w) => /IMAGE_MISSING: graphic 8/.test(w))).toHaveLength(1);
  });

  it("reads the document once per hash and refuses another job version", async () => {
    const document = vi.fn(() => printDocumentBytes());
    const hash = `${HASH}-once`;
    const j = { ...job([sheet("A")]), document: { hash, rotationCorrectionDeg: 0 } };
    await renderPrintJob(j, host({ document }));
    await renderPrintJob(j, host({ document }));
    expect(document).toHaveBeenCalledTimes(1);
    expect(document).toHaveBeenCalledWith(hash);
    await expect(renderPrintJob({ ...j, version: 2 } as unknown as PrintJob, host())).rejects.toThrow("Unsupported print job version 2");
  });
});

describe("the fixture job (§8.6, G16)", () => {
  it("holds every sheet kind maps.pdf composes: course with copies, a map exchange's two parts, all controls, setter", () => {
    const j = fixturePrintJob();
    expect(j.sheets.map((s) => [s.label, s.course.viewOptions?.allControls ?? false, s.copies ?? 1])).toEqual([
      ["Blue", false, 3],
      ["Blue", false, 1],
      ["All controls", true, 1],
      ["Setter 1", true, 1],
    ]);
    expect(j.sheets[3].course.sites.map((s) => s.id)).toEqual(["C", "D", "E"]);
    // The two parts of the exchange: one course drawn as its sections, each window centred on its part.
    const section = (i: number) => (j.sheets[i].course.viewOptions as { section?: number } | undefined)?.section;
    expect([section(0), section(1)]).toEqual([0, 1]);
    expect(j.sheets[1].window).not.toEqual(j.sheets[0].window);
    // The all-controls sheet orders Å1 before Z1 (`compareLabels`; Swedish would not).
    const codes = j.sheets[2].course.sites.map((s) => s.code);
    expect(codes.indexOf("Å1")).toBeLessThan(codes.indexOf("Z1"));
    expect(j.graphics).toEqual([{ id: 7, mime: "image/png" }, { id: 8, mime: "image/svg+xml" }, { id: 9, mime: "image/svg+xml" }]);
    expect(JSON.parse(JSON.stringify(j))).toEqual(j);
  });

  it("composes to renderCoursePages' bytes; the SVG page object and the map-layer SVG asked at their boxes", async () => {
    const j = fixturePrintJob();
    const asked: unknown[][] = [];
    const graphic = async (id: number, box?: [number, number]) => {
      asked.push(box ? [id, box] : [id]);
      return FIXTURE_PNG;
    };
    const out = await renderPrintJob(j, host({ document: () => printDocumentBytes(), graphic }));
    expect(out.warnings).toEqual([]);
    expect(out.pageCount).toBe(6);
    expect(asked[0]).toEqual([7]);
    expect(asked.filter((a) => a[0] === 8)).toEqual([[8, svgRasterBox(20, 10)]]);
    expect(asked.filter((a) => a[0] === 9).length).toBeGreaterThanOrEqual(1);

    const document = await prepareDocument(j.document.hash, printDocumentBytes);
    const direct = await renderCoursePages({
      document,
      sheets: j.sheets,
      fonts,
      graphics: new Map([...fixtureGraphics].map(([id, g]) => [id, { mime: g.mime, data: g.data }])),
      rasteriseSvg: async () => FIXTURE_PNG,
      mode: "cmyk",
      info: j.info,
      deterministic: true,
    });
    expect(out.bytes).toEqual(direct.bytes);
  });
});
