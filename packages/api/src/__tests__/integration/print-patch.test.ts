/**
 * The event's patch in print (G14; docs/map-patches.md §2, course-print.md
 * §8.2, §8.5): `maps.pdf`, the print worker and the print job compose the
 * effective document.
 *
 * - A hidden object is absent from the PDF: the route's pages differ from
 *   the unpatched ones only inside the object's box on the page.
 * - An added object is present: the change is inside its box.
 * - `enabled = false` gives the unpatched PDF byte for byte, and the
 *   unpatched job.
 * - A patch change between two prints on the same worker shows in the
 *   second (the worker's cache is keyed by hash + patch version).
 * - The job, composed over HTTP, still writes `maps.pdf`'s bytes.
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { course, defaultMapAppearance, mapDocument } from "@oxygen/shared";
import {
  type ComposedPage,
  type PrintJob,
  composePage,
  inverseMapLayerTransform,
  mapPointToPage,
  pageInputFor,
  printFontsFromFaces,
  renderPrintJob,
} from "@oxygen/shared/print";
import { registerCourseMapRoutes } from "../../course-maps/routes.js";
import { loadPinnedPrintDocument, renderCoursePages } from "../../course-maps/pdf-page.js";
import { renderCoursePagesInWorker } from "../../course-maps/print-worker-host.js";
import { registerMapDocumentRoutes } from "../../map-store/routes.js";
import { applyEventMap } from "../../event-map.js";
import { clearEventDocumentCaches, decodedDocument } from "../../map-store/event-document.js";
import { applyPatchChange, setPatchEnabled } from "../../map-store/patches.js";
import { bundledPdfFaces } from "../../render/fonts.js";
import { hasTool, rasterisePdf } from "../../render/pdf-golden.js";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";

const fixture = resolve(__dirname, "../../../../../e2e/test.ocd");
const suffix = randomBytes(4).toString("hex");
/** Raster resolution of the pixel checks: A4 at 840 × 1188. */
const PX_PER_MM = 4;
/** Half the side of an object's box on the page, mm: a point symbol and its anti-aliasing fit well inside. */
const BOX_MM = 8;
const ADD_ID = "00000000-0000-4000-8000-0000000000a1";

let ctx: TestEventContext;
let server: FastifyInstance;
let hash: string;
let doc: mapDocument.MapDocument;
let sheetSeq: number;
let page: ComposedPage;
let pdftocairo: boolean;
/** The point object hidden by the tests, and where it lands on the page (mm, y-up). */
let target: { sourceIndex: number; symbolIdx: number; pageMm: [number, number] };
/** Where the added point goes: native document units, and on the page (mm, y-up). */
let added: { native: [number, number]; pageMm: [number, number] };

function makeServer(): FastifyInstance {
  const s = Fastify({ logger: false });
  registerCourseMapRoutes(s, { renderCoursePages: (o) => renderCoursePagesInWorker({ ...o, deterministic: true }) });
  registerMapDocumentRoutes(s);
  return s;
}

const get = (url: string, headers: Record<string, string> = {}) => server.inject({ method: "GET", url, headers });
const query = () => `?maps=${sheetSeq}`;
async function pdf(): Promise<Buffer> {
  const res = await get(`/api/maps/${ctx.nameId}/maps.pdf${query()}`);
  expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
  return res.rawPayload;
}
async function job(): Promise<PrintJob> {
  const res = await get(`/api/maps/${ctx.nameId}/print-job${query()}`);
  expect(res.statusCode).toBe(200);
  return res.json() as PrintJob;
}

/** Paper µm of a document point (native units). */
const paperUm = (x: number, y: number): [number, number] => [(x / doc.header.unitsPerMm) * 1000, (y / doc.header.unitsPerMm) * 1000];
const toPageMm = (x: number, y: number): [number, number] => {
  const [px, py] = mapPointToPage(page.mapLayer.transform, ...paperUm(x, y));
  return [px / 1000, py / 1000];
};

/** Pixels (page mm, y-up) where two rasters of the first page differ. */
async function diffPixels(a: Uint8Array, b: Uint8Array): Promise<[number, number][]> {
  const w = Math.round(page.paper.widthMm * PX_PER_MM), h = Math.round(page.paper.heightMm * PX_PER_MM);
  const [ra, rb] = await Promise.all([rasterisePdf(a, w, h), rasterisePdf(b, w, h)]);
  const out: [number, number][] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 4;
      if (Math.abs(ra.pixels[k] - rb.pixels[k]) + Math.abs(ra.pixels[k + 1] - rb.pixels[k + 1]) + Math.abs(ra.pixels[k + 2] - rb.pixels[k + 2]) > 6)
        out.push([(x + 0.5) / PX_PER_MM, page.paper.heightMm - (y + 0.5) / PX_PER_MM]);
    }
  return out;
}
const inBox = ([x, y]: [number, number], [cx, cy]: [number, number]) => Math.abs(x - cx) <= BOX_MM && Math.abs(y - cy) <= BOX_MM;

beforeAll(async () => {
  ctx = await createTestEvent("print_patch");
  const bytes = Buffer.concat([readFileSync(fixture), Buffer.from(`print-patch-${suffix}`)]);
  hash = (await applyEventMap(ctx.db, ctx.eventId, "test.ocd", bytes)).documentHash;
  clearEventDocumentCaches();
  doc = (await decodedDocument(ctx.db, hash))!;

  const db = ctx.db;
  const mk = (codes: string, xpos: number, ypos: number, extra: Record<string, unknown> = {}) => db.control.create({ data: { eventId: ctx.eventId, codes, xpos, ypos, ...extra } });
  const c31 = await mk("31", -80, 0);
  const c32 = await mk("32", -60, 15);
  await mk("", -95, -10, { status: "start" });
  const template = await db.mapTemplate.create({
    data: {
      eventId: ctx.eventId,
      name: "A4",
      printScale: 7500,
      settings: { printMarginMm: 3, mapFrame: { x: 8, y: 8, width: 194, height: 281 }, description: { visible: false, x: 0, y: 0, cellSizeMm: 6 }, appearance: defaultMapAppearance },
    },
  });
  const blue = await db.course.create({
    data: { eventId: ctx.eventId, name: "Blå", courseControls: { create: [{ position: 1, controlId: c31.id }, { position: 2, controlId: c32.id }] } },
  });
  sheetSeq = (await db.courseMap.create({ data: { eventId: ctx.eventId, name: "Blå A4", kind: "course", courseId: blue.id, templateId: template.id, windowCenter: { x: -70, y: 5 } } })).seq;

  server = makeServer();
  await server.ready();
  pdftocairo = await hasTool("pdftocairo");

  // The page's map transform, from the job's own sheet.
  const fonts = printFontsFromFaces(await bundledPdfFaces());
  const { document } = await loadPinnedPrintDocument(db, ctx.eventId);
  page = composePage(pageInputFor(document, (await job()).sheets[0], null), fonts.metrics);

  // The hidden object: the first visible point symbol that is no cut feature, well inside the frame.
  const f = page.frameUm;
  const inset = 20;
  const inFrame = ([x, y]: [number, number]) =>
    x > f.x / 1000 + inset && x < (f.x + f.width) / 1000 - inset && y > f.y / 1000 + inset && y < (f.y + f.height) / 1000 - inset;
  const pts: number[] = [];
  for (let i = 0; i < doc.header.objects.count; i++) {
    if (doc.attrs.type[i] !== mapDocument.OBJECT_TYPE.point) continue;
    const sym = doc.header.symbols[doc.attrs.symbolIdx[i]];
    if (sym.hidden || course.CUT_CODES.has(Math.floor(Number.parseFloat(sym.code)))) continue;
    const k = doc.coordStart[i] * 2;
    const at = toPageMm(doc.coords[k], doc.coords[k + 1]);
    if (inFrame(at)) pts.push(i);
  }
  // Lone points: nothing else of the list within two boxes, so the change is the object's own.
  const pageOf = (i: number) => toPageMm(doc.coords[doc.coordStart[i] * 2], doc.coords[doc.coordStart[i] * 2 + 1]);
  const apart = (i: number, j: number) => Math.hypot(pageOf(j)[0] - pageOf(i)[0], pageOf(j)[1] - pageOf(i)[1]) > 2 * BOX_MM;
  const lone = pts.find((i) => pts.every((j) => j === i || apart(i, j)));
  expect(lone, "a visible point object inside the frame").toBeDefined();
  target = { sourceIndex: doc.attrs.sourceIndex[lone!], symbolIdx: doc.attrs.symbolIdx[lone!], pageMm: pageOf(lone!) };

  // The added point: the same symbol 30 mm (page) right of and below the frame's centre.
  const cx = f.x / 1000 + f.width / 2000 + 30, cy = f.y / 1000 + f.height / 2000 - 30;
  const [mx, my] = mapPointToPage(inverseMapLayerTransform(page.mapLayer.transform), cx * 1000, cy * 1000);
  const native: [number, number] = [Math.round((mx / 1000) * doc.header.unitsPerMm), Math.round((my / 1000) * doc.header.unitsPerMm)];
  added = { native, pageMm: toPageMm(...native) };
}, 120_000);

afterAll(async () => {
  await server?.close();
  await ctx?.cleanup();
  await disconnect();
});

describe("maps.pdf composes the effective document (G14)", () => {
  let plain: Buffer;
  let plainJob: PrintJob;
  let hidden: Buffer;

  it("without a patch the job carries none", async () => {
    plain = await pdf();
    plainJob = await job();
    expect(plainJob.document.patch).toBeNull();
  });

  it("a hidden object is absent from the PDF", async () => {
    const res = await applyPatchChange(ctx.db, ctx.eventId, hash, { put: [{ op: "hide", sourceIndex: target.sourceIndex }] });
    hidden = await pdf();
    expect(hidden.equals(plain)).toBe(false);

    // The job names the patch at its version; the route printed exactly the patched document.
    const patched = await job();
    expect(patched.document.patch?.version).toBe(res.version);
    expect(Object.keys(patched.document.patch!.patch.ops)).toEqual([`hide:${target.sourceIndex}`]);
    const local = await loadPinnedPrintDocument(ctx.db, ctx.eventId);
    expect(local.document.input.stats.patchHidden).toBe(1);
    const inProcess = await renderCoursePages({ document: local.document, sheets: patched.sheets, rotationCorrectionDeg: patched.document.rotationCorrectionDeg, mode: "cmyk", info: patched.info, deterministic: true });
    expect(Buffer.from(inProcess.bytes).equals(hidden)).toBe(true);

    if (pdftocairo) {
      const diff = await diffPixels(plain, hidden);
      expect(diff.length).toBeGreaterThan(0);
      expect(diff.filter((p) => !inBox(p, target.pageMm))).toEqual([]);
    }
  }, 120_000);

  it("an added object is present, and the change shows in the next print on the same worker", async () => {
    await applyPatchChange(ctx.db, ctx.eventId, hash, {
      put: [{ op: "add", id: ADD_ID, type: mapDocument.OBJECT_TYPE.point, symbol: { doc: target.symbolIdx }, coords: [added.native] }],
    });
    const both = await pdf();
    expect(both.equals(hidden)).toBe(false);
    if (pdftocairo) {
      const diff = await diffPixels(hidden, both);
      expect(diff.length).toBeGreaterThan(0);
      expect(diff.filter((p) => !inBox(p, added.pageMm))).toEqual([]);
    }
  }, 120_000);

  it("enabled = false prints the unpatched PDF byte for byte, and the job carries no patch; enabled again prints the corrections", async () => {
    const withBoth = await pdf();
    await setPatchEnabled(ctx.db, ctx.eventId, false);
    const off = await pdf();
    expect(off.equals(plain)).toBe(true);
    expect(await job()).toEqual(plainJob);

    await setPatchEnabled(ctx.db, ctx.eventId, true);
    expect((await pdf()).equals(withBoth)).toBe(true);
  }, 120_000);

  it("the job with a patch, composed over HTTP, writes maps.pdf's bytes", async () => {
    const j = await job();
    expect(j.document.patch).not.toBeNull();
    const out = await renderPrintJob(j, {
      fonts: printFontsFromFaces(await bundledPdfFaces()),
      deterministic: true,
      document: async (h) => {
        const res = await get(`/api/map-documents/${h}?event=${ctx.nameId}`, { "accept-encoding": "identity" });
        expect(res.statusCode).toBe(200);
        return new Uint8Array(res.rawPayload);
      },
      graphic: async () => {
        throw new Error("no graphics on this sheet");
      },
    });
    expect(Buffer.from(out.bytes).equals(await pdf())).toBe(true);
  }, 120_000);
});
