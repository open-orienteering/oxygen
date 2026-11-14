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
import { type PrintPatch, prepareDocument } from "../prepared-document.js";
import { mapPatchSchema } from "../../map-document/index.js";
import { bundledFontsForTest, printDocumentBytes } from "./print-document.js";

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
  return { version: PRINT_JOB_VERSION, document: { hash: HASH, rotationCorrectionDeg: 0, patch: null }, sheets, graphics, mode: "cmyk", info: { title: "Test maps" }, filename: "test_maps.pdf" };
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
    const j = { ...job([sheet("A")]), document: { hash, rotationCorrectionDeg: 0, patch: null } };
    await renderPrintJob(j, host({ document }));
    await renderPrintJob(j, host({ document }));
    expect(document).toHaveBeenCalledTimes(1);
    expect(document).toHaveBeenCalledWith(hash);
    // Version 1 carried no patch: a host that composed it would drop the event's corrections (G14).
    expect(PRINT_JOB_VERSION).toBe(2);
    await expect(renderPrintJob({ ...j, version: 1 } as unknown as PrintJob, host())).rejects.toThrow("Unsupported print job version 1");
  });
});

describe("renderPrintJob with the event's patch (§8.5; docs/map-patches.md §2, G14)", () => {
  const PATCHED = "cd".repeat(32);
  const patch = (ops: Record<string, unknown>, version = "42"): PrintPatch => ({ version, patch: mapPatchSchema.parse({ documentHash: PATCHED, ops }) });
  const hideBoulder = patch({ "hide:1": { op: "hide", sourceIndex: 1 } });
  const patchedJob = (p: PrintPatch | null): PrintJob => ({ ...job([sheet("A")]), document: { hash: PATCHED, rotationCorrectionDeg: 0, patch: p } });

  it("composes the effective document: renderCoursePages' bytes over the patched document, not the unpatched ones", async () => {
    const out = await renderPrintJob(patchedJob(hideBoulder), host());
    const direct = await renderCoursePages({
      document: await prepareDocument(PATCHED, printDocumentBytes, hideBoulder),
      sheets: [sheet("A")],
      fonts,
      mode: "cmyk",
      info: { title: "Test maps" },
      deterministic: true,
    });
    expect(out.bytes).toEqual(direct.bytes);
    expect((await renderPrintJob(patchedJob(null), host())).bytes).not.toEqual(out.bytes);
  });

  it("survives a JSON round trip, and a disabled patch gives the unpatched bytes", async () => {
    const j = patchedJob(hideBoulder);
    const a = await renderPrintJob(j, host());
    const b = await renderPrintJob(JSON.parse(JSON.stringify(j)) as PrintJob, host());
    expect(b.bytes).toEqual(a.bytes);
    const off = { ...hideBoulder, patch: { ...hideBoulder.patch, enabled: false } };
    expect((await renderPrintJob(patchedJob(off), host())).bytes).toEqual((await renderPrintJob(patchedJob(null), host())).bytes);
  });

  it("reports an op it could not apply as a warning and still writes the PDF (map-patches §2.3)", async () => {
    const out = await renderPrintJob(patchedJob(patch({ "hide:99": { op: "hide", sourceIndex: 99 } }, "43")), host());
    expect(out.pageCount).toBe(1);
    expect(out.warnings).toEqual(["PATCH_ISSUE: hide:99: target-missing"]);
  });
});
