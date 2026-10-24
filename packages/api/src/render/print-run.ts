/**
 * Corpus print run (docs/course-print.md §11; SLICES C7, the slice's
 * regression net, 09 §8): one course page of an OCAD map on its OCAD
 * print window, printed by the route's own `renderCoursePages` in `rgb`
 * and `cmyk`, checked by `qpdf`, rasterised by poppler and compared
 * (a) with the page oracle (backend parity, 04 §9 budget 0.5 %, the
 * method of the PDF golden tier §9.2) and (b) with the legacy rsvg page
 * of the same sheet, classified by the §8.4 sanctioned differences and,
 * per symbol, by B9's `runParity` on the same window
 * (`map-rendering.md` §6.4). No database: the sheet is derived from the
 * document header and a synthetic course is placed on the window.
 *
 * Tool code only: nothing in the app imports it.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PDFDocument } from "pdf-lib";
import { defaultMapAppearance, getPaperDimensions, mapDocument, render, windowBoundingBox, type ControlDescription, type MapWindow } from "@oxygen/shared";
import { type ColourMode, type ComposedPage, composePage } from "@oxygen/shared/print";
import { importMapToDocument } from "../import/ocad.js";
import { applyIofColorStack, inkToColor } from "../map-color-stack.js";
import { probeMeridianLines } from "../map-north.js";
import { composeMapPageSvg } from "../course-maps/map-page-svg.js";
import { type ParsedOcad, renderBaseMapLayers } from "../course-maps/map-source.js";
import { documentPaperFrame, pageInputFor, renderCoursePages } from "../course-maps/pdf-page.js";
import type { LayoutControlSource, LayoutCourseSource, LayoutTemplateSource } from "../course-maps/resolve-layout.js";
import { type ResolvedSheet, resolveSheet } from "../course-maps/resolve-sheet.js";
import { RsvgConverter } from "../course-maps/svg-to-pdf.js";
import { BUNDLED_FONT_FILES } from "./fonts.js";
import { goldenFonts } from "./golden.js";
import { PAGE_GOLDEN_SUPERSAMPLE, rasterisePage } from "./page-raster.js";
import { type ParityOptions, type RgbaImage, type SanctionedCode, diffPicture, inkUnion, runParity, unexplainedPixels } from "./parity.js";
import { hasTool, qpdfCheck, rasterisePdf, rasteriserCmykColours } from "./pdf-golden.js";
import { diffImages } from "./reference-raster.js";
import { prepareDocument } from "./window-raster.js";

const run = promisify(execFile);

/**
 * The corpus gate on backend parity (docs/course-print.md §11.3; user decision 2026-10-24): the
 * route's page (embedded fonts) against the page oracle — **geometry**: B9's unexplained pixels at
 * most `PRINT_SHAPE_BUDGET` of the ink; **shading**: at most `PRINT_PARITY_BUDGET` of the pixels
 * beyond `PRINT_SHADING_TOLERANCE` levels. Pixels beyond 16 levels (the golden tier's measure,
 * §9.2) and the text-as-outlines run are reported, not gated: on a dense map Cairo's and resvg's
 * edge anti-aliasing alone put 0.5–1.5 % of the pixels 17–32 levels apart.
 */
export const PRINT_PARITY_BUDGET = 0.005;
export const PRINT_SHADING_TOLERANCE = 32;
export const PRINT_SHAPE_BUDGET = 0.0001;
/** The template's page margin around the map frame, mm (the template default). */
export const PRINT_MARGIN_MM = 3;
/** Description cell size on the synthetic sheet, mm. */
export const DESCRIPTION_CELL_MM = 5;

/**
 * The sanctioned differences from the legacy page (course-print.md §8.4)
 * a corpus page can trigger. A page carries the codes its sheet and mode
 * trigger; the base map's per-symbol codes come from `runParity`.
 */
export const PRINT_SANCTIONED = {
  "cmyk-colour": "DeviceCMYK from the colour stack against the legacy RGB",
  "north-lines-below": "`northLinesBelow` (on by default) not applied",
  "description-weight": "description header, title and lengths in regular weight",
  "description-font": "Liberation Sans in the description block",
  "course-symbol-sizes": "7xx symbols at the library's dimensions × the document factor",
  "start-turned": "the start triangle turned to the first control",
  "library-course-lines": "course lines drawn by the library",
  "start-finish-clearance": "legs cut at the start / finish symbols' own outlines",
  "size-aware-cuts": "automatic cuts from the document with size-aware clearance",
  "rotated-overprint": "control numbers and map text turn with a rotated window",
  "library-symbols": "the base map as the library and the document's stack draw it (per-symbol codes below)",
  "stack-order": "the document's own colour order",
} as const;
export type PrintSanctionedCode = keyof typeof PRINT_SANCTIONED;

export interface PrintRunOptions {
  /** ISO paper instead of the print window's own size (the frame = paper − margins). */
  paper?: { size: "A3" | "A4" | "A5"; orientation?: "portrait" | "landscape" };
  /** Print scale denominator; default the print window's, else the map scale. */
  printScale?: number;
  /** Window centre, paper mm y-up; default the print window's centre, else the bounds'. */
  centre?: { x: number; y: number };
  /** Whole px/mm of the comparison rasters; default 10 (the golden density). */
  pxPerMm?: number;
  /** Compare with the legacy rsvg page (needs `rsvg-convert`); default true. */
  legacy?: boolean;
  /** Per-symbol parity on the window (`runParity`); default true. */
  symbols?: boolean;
  /** The previous run's report (`summary.json`), compared in `previous`. */
  previous?: PrintRunReport | null;
  onPdf?: (name: string, bytes: Uint8Array) => Promise<void> | void;
  onImage?: (name: string, img: RgbaImage) => Promise<void> | void;
  /** Images of the diverging symbols (`runParity`'s rows). */
  onSymbolImages?: ParityOptions["onImages"];
}

export type ToolCheck = "ok" | "skipped" | `failed: ${string}`;

export interface PrintModeResult {
  bytes: number;
  sha256: string;
  /** `renderCoursePages` wall time for the one page, ms. */
  renderMs: number;
  /** PDF page size, mm. */
  pageMm: { width: number; height: number };
  qpdf: ToolCheck;
  /** The page (embedded fonts, the route's bytes) against the oracle in this mode's colours, differing pixels at tolerance 16. */
  parity: { differing: number; total: number; ratio: number };
  /** The same page written with text as glyph outlines against the same oracle. */
  outline: { differing: number; total: number; ratio: number };
  /** Embedded-fonts page vs oracle at channel tolerance 32 (shading beyond edge anti-aliasing). */
  strong: { differing: number; ratio: number };
  /** Embedded-fonts page vs oracle: B9's shape measure (`unexplainedPixels`) ÷ ink. */
  shape: { unexplained: number; ink: number; ratio: number };
  warnings: number;
  sanctioned: PrintSanctionedCode[];
}

export interface PrintLegacyResult {
  pageMm: { width: number; height: number };
  /** rsvg-convert wall time, ms. */
  convertMs: number;
  bytes: number;
  differing: number;
  ink: number;
  unexplained: number;
  /**
   * Pixels differing (16 levels) from the page oracle drawn in the legacy RGB
   * of each source colour (B9's recolouring; the PDF matches the oracle within
   * the parity budget), so the OCAD-RGB-vs-CMYK shift does not swamp it — ÷
   * the ink of legacy ∪ PDF, the shape ratio's denominator.
   */
  inkRatio: number;
  /** Unexplained ÷ ink (shape only, B9's measure). */
  unexplainedRatio: number;
  /** The legacy reader's own meridian tilt (`getBaseMapInfo`'s legacy branch). */
  legacyTiltDeg: number;
}

export interface PrintSymbolRow {
  code: string;
  name: string;
  kind: string;
  unexplainedRatio: number;
  sanctioned: SanctionedCode[];
}

export interface PrintSymbolsResult {
  window: { minX: number; minY: number; maxX: number; maxY: number };
  compared: number;
  diverging: PrintSymbolRow[];
  unsanctioned: number;
}

export interface PrintPrevious {
  sameBytes: Record<ColourMode, boolean>;
  bytesDelta: Record<ColourMode, number>;
  renderMsDelta: Record<ColourMode, number>;
  parityDelta: Record<ColourMode, number>;
  outlineDelta: Record<ColourMode, number>;
  legacyUnexplainedDelta: number | null;
  divergingDelta: number | null;
}

export interface PrintRunReport {
  fileName: string;
  mapScale: number;
  printScale: number;
  /** Where the page came from: the OCAD print window, the object bounds (no print window), or the overrides. */
  source: "print-window" | "bounds" | "override";
  paper: { widthMm: number; heightMm: number; name: string };
  window: { widthMm: number; heightMm: number; rotationDeg: number };
  pxPerMm: number;
  /** Document objects drawn in the window (`objectsNear`). */
  objects: number;
  course: { controls: number; description: boolean };
  importMs: number;
  /** `composePage` time for the page, ms (the synchronous part, course-print.md Pending "off the event loop"). */
  composeMs: number;
  modes: Record<ColourMode, PrintModeResult>;
  legacy: PrintLegacyResult | { skipped: string };
  symbols: PrintSymbolsResult | { skipped: string };
  previous: PrintPrevious | null;
  pass: boolean;
  failures: string[];
}

// ---------------------------------------------------------------- the sheet

export interface PrintSheetSpec {
  template: LayoutTemplateSource;
  /** Window centre, paper mm y-up. */
  centre: { x: number; y: number };
  mapScale: number;
  printScale: number;
  source: PrintRunReport["source"];
  paperName: string;
}

type HeaderLike = Pick<mapDocument.MapDocumentHeader, "printWindow" | "bounds" | "unitsPerMm" | "mapScale">;

/**
 * The sheet a corpus page is printed on: the OCAD print window at its
 * print scale on a custom sheet of frame + margins (what OCAD prints),
 * else A4 at the map scale on the object bounds' centre, then the
 * overrides (`--paper`, `--print-scale`, `--centre`).
 */
export function printSheetFor(header: HeaderLike, opts: Pick<PrintRunOptions, "paper" | "printScale" | "centre"> = {}): PrintSheetSpec {
  const mapScale = header.mapScale;
  const pw = header.printWindow && header.printWindow.right > header.printWindow.left && header.printWindow.top > header.printWindow.bottom ? header.printWindow : null;
  const k = 1 / header.unitsPerMm;
  const b = header.bounds;
  let centre = pw ? { x: (pw.left + pw.right) / 2, y: (pw.bottom + pw.top) / 2 } : { x: ((b.minX + b.maxX) / 2) * k, y: ((b.minY + b.maxY) / 2) * k };
  let printScale = Math.round(pw?.scale ?? mapScale);
  let source: PrintSheetSpec["source"] = pw ? "print-window" : "bounds";
  let paper: { paper: string; orientation: string; width: number | null; height: number | null; name: string };
  if (opts.paper || !pw) {
    const size = opts.paper?.size ?? "A4";
    const wide = (b.maxX - b.minX) > (b.maxY - b.minY);
    const orientation = opts.paper?.orientation ?? (pw ? (pw.right - pw.left > pw.top - pw.bottom ? "landscape" : "portrait") : wide ? "landscape" : "portrait");
    paper = { paper: size, orientation, width: null, height: null, name: `${size} ${orientation}` };
  } else {
    // The print window enlarged to the print scale is the frame, the sheet rounded up to whole mm:
    // a fractional page puts PDF raster and oracle up to half a pixel apart at every edge.
    const f = mapScale / printScale;
    const mm = (v: number) => Math.ceil(v - 1e-6);
    const w = mm((pw.right - pw.left) * f + 2 * PRINT_MARGIN_MM), h = mm((pw.top - pw.bottom) * f + 2 * PRINT_MARGIN_MM);
    paper = { paper: "custom", orientation: w > h ? "landscape" : "portrait", width: w, height: h, name: `custom ${w} × ${h}` };
  }
  if (opts.printScale) printScale = opts.printScale;
  if (opts.centre) centre = opts.centre;
  if (opts.paper || opts.printScale || opts.centre) source = "override";
  const dims = getPaperDimensions(paper.paper as "A4", paper.orientation as "portrait", paper.width !== null ? { width: paper.width, height: paper.height! } : undefined);
  const frame = { x: PRINT_MARGIN_MM, y: PRINT_MARGIN_MM, width: round3(dims.width - 2 * PRINT_MARGIN_MM), height: round3(dims.height - 2 * PRINT_MARGIN_MM) };
  const blockW = 8 * DESCRIPTION_CELL_MM;
  const description = {
    // Top right of the frame when the frame has room for the block and some map beside it.
    visible: frame.width >= 100 && frame.height >= 80,
    x: round3(frame.x + frame.width - blockW - 2),
    y: frame.y + 2,
    cellSizeMm: DESCRIPTION_CELL_MM,
  };
  return {
    template: {
      paper: paper.paper,
      orientation: paper.orientation,
      paperWidthMm: paper.width,
      paperHeightMm: paper.height,
      printScale,
      settings: { printMarginMm: PRINT_MARGIN_MM, mapFrame: frame, description, appearance: defaultMapAppearance },
      objects: [],
    },
    centre,
    mapScale,
    printScale,
    source,
    paperName: paper.name,
  };
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** Site positions as fractions of the window's half extents (start, four controls, finish). */
const SITES: Array<{ fx: number; fy: number; description?: ControlDescription }> = [
  { fx: -0.6, fy: -0.55 },
  { fx: -0.25, fy: 0.5, description: { d: "1.010" } },
  { fx: 0.45, fy: 0.45, description: { d: "2.004" } },
  { fx: 0.55, fy: -0.2, description: { d: "1.010", s: "1,5" } },
  { fx: 0.05, fy: -0.5, description: { d: "2.004" } },
  { fx: -0.3, fy: -0.1 },
];

/**
 * A deterministic course on a window: start, controls 31–34, finish at
 * fixed fractions of the window (paper mm, y-up, axis-aligned — a tilt of
 * a few degrees keeps them inside), with the GeoJSON the legacy layout
 * reads its start, finish and leg ends from. No legs and no cuts in the
 * GeoJSON: both pages derive their straight legs; the vector page cuts
 * them around document features (`size-aware-cuts`).
 */
export function syntheticCourse(centre: { x: number; y: number }, window: { width: number; height: number }, mapScale: number): LayoutCourseSource {
  const at = (s: (typeof SITES)[number]) => ({ x: round3(centre.x + (s.fx * window.width) / 2), y: round3(centre.y + (s.fy * window.height) / 2) });
  const pts = SITES.map(at);
  let lengthMm = 0;
  for (let i = 1; i < pts.length; i++) lengthMm += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  const controls: LayoutControlSource[] = SITES.slice(1, -1).map((s, i) => ({
    id: `c${31 + i}`,
    seq: i + 1,
    codes: String(31 + i),
    xpos: pts[i + 1].x,
    ypos: pts[i + 1].y,
    description: s.description,
  }));
  const point = (symbolType: "start" | "finish", p: { x: number; y: number }) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [p.x, p.y] },
    properties: { symbolType, id: symbolType, code: symbolType === "start" ? "S" : "F" },
  });
  return {
    name: "Corpus",
    lengthM: Math.round((lengthMm * mapScale) / 1000 / 10) * 10,
    climbM: 0,
    orderMode: "ordered",
    classes: [{ name: "H21" }],
    controls,
    geometry: { type: "FeatureCollection", features: [point("start", pts[0]), point("finish", pts[pts.length - 1])] },
  };
}

/** The §8.4 codes a corpus page triggers. */
export function pageSanctionedCodes(p: { mode: ColourMode; description: boolean; rotated: boolean }): PrintSanctionedCode[] {
  const out: PrintSanctionedCode[] = ["course-symbol-sizes", "start-turned", "start-finish-clearance", "size-aware-cuts", "library-symbols", "stack-order", "north-lines-below"];
  if (p.mode === "cmyk") out.push("cmyk-colour");
  if (p.description) out.push("description-weight", "description-font");
  if (p.rotated) out.push("rotated-overprint");
  return out.sort();
}

/** The corpus gate on one mode's backend parity (§11.3): an empty list when it holds. */
export function parityFailures(mode: ColourMode, m: { strongRatio: number; shapeRatio: number }): string[] {
  const out: string[] = [];
  if (m.strongRatio > PRINT_PARITY_BUDGET) out.push(`${mode}: ${(m.strongRatio * 100).toFixed(3)} % of the pixels beyond ${PRINT_SHADING_TOLERANCE} levels > ${PRINT_PARITY_BUDGET * 100} %`);
  if (m.shapeRatio > PRINT_SHAPE_BUDGET) out.push(`${mode}: unexplained ${(m.shapeRatio * 100).toFixed(4)} % of ink > ${PRINT_SHAPE_BUDGET * 100} %`);
  return out;
}

/**
 * The rest of the corpus gate (§11.3): `qpdf` errors, a PDF or legacy page
 * not the sheet's size (geometry is never a sanctioned difference, §8.4),
 * diverging symbols without a sanctioned code. Empty when it holds.
 */
export function checkFailures(c: {
  sheetMm: { widthMm: number; heightMm: number };
  modes: Array<{ mode: ColourMode; qpdf: ToolCheck; pageMm: { width: number; height: number } }>;
  legacyPageMm: { width: number; height: number } | null;
  unsanctioned: number;
}): string[] {
  const out: string[] = [];
  const off = (p: { width: number; height: number }) => Math.abs(p.width - c.sheetMm.widthMm) > 0.01 || Math.abs(p.height - c.sheetMm.heightMm) > 0.01;
  const sheet = `sheet ${c.sheetMm.widthMm} × ${c.sheetMm.heightMm} mm`;
  for (const m of c.modes) {
    if (m.qpdf.startsWith("failed")) out.push(`${m.mode}: qpdf ${m.qpdf}`);
    if (off(m.pageMm)) out.push(`${m.mode}: page ${m.pageMm.width} × ${m.pageMm.height} mm, ${sheet}`);
  }
  if (c.legacyPageMm && off(c.legacyPageMm)) out.push(`legacy page ${c.legacyPageMm.width} × ${c.legacyPageMm.height} mm, ${sheet}`);
  if (c.unsanctioned) out.push(`${c.unsanctioned} symbol(s) diverge without a sanctioned difference`);
  return out;
}

/** The run against the previous one (null without a previous report). */
export function comparePrevious(current: Pick<PrintRunReport, "modes" | "legacy" | "symbols">, previous: PrintRunReport | null | undefined): PrintPrevious | null {
  if (!previous?.modes) return null;
  const modes: ColourMode[] = ["rgb", "cmyk"];
  const per = <T>(f: (m: ColourMode) => T) => Object.fromEntries(modes.map((m) => [m, f(m)])) as Record<ColourMode, T>;
  const legacyOf = (r: Pick<PrintRunReport, "legacy">) => ("unexplainedRatio" in r.legacy ? r.legacy.unexplainedRatio : null);
  const divOf = (r: Pick<PrintRunReport, "symbols">) => ("diverging" in r.symbols ? r.symbols.diverging.length : null);
  const lc = legacyOf(current), lp = legacyOf(previous);
  const dc = divOf(current), dp = divOf(previous);
  return {
    sameBytes: per((m) => current.modes[m].sha256 === previous.modes[m]?.sha256),
    bytesDelta: per((m) => current.modes[m].bytes - (previous.modes[m]?.bytes ?? 0)),
    renderMsDelta: per((m) => Math.round(current.modes[m].renderMs - (previous.modes[m]?.renderMs ?? 0))),
    parityDelta: per((m) => current.modes[m].parity.ratio - (previous.modes[m]?.parity.ratio ?? 0)),
    outlineDelta: per((m) => current.modes[m].outline.ratio - (previous.modes[m]?.outline?.ratio ?? 0)),
    legacyUnexplainedDelta: lc !== null && lp !== null ? lc - lp : null,
    divergingDelta: dc !== null && dp !== null ? dc - dp : null,
  };
}

// ---------------------------------------------------------------- the run

const hex2 = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
const rgbHex = (c: ArrayLike<number>) => `#${hex2(c[0])}${hex2(c[1])}${hex2(c[2])}`;

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function pdfPageMm(bytes: Uint8Array): Promise<{ width: number; height: number }> {
  const doc = await PDFDocument.load(bytes);
  const { width, height } = doc.getPage(0).getSize();
  return { width: round3((width * 25.4) / 72), height: round3((height * 25.4) / 72) };
}

/** Is a command on the PATH? */
export async function hasCommand(cmd: string): Promise<boolean> {
  try {
    await run(cmd, ["--version"]);
    return true;
  } catch (err) {
    return (err as { code?: unknown }).code !== "ENOENT";
  }
}

/**
 * fontconfig limited to the bundled Liberation files, every family falling
 * back to Liberation Sans: the legacy page's text pinned like B9's
 * `legacyFonts` (`parity.ts`), not the machine's font stack.
 */
async function pinnedFontconfig(dir: string): Promise<string> {
  const fontsDir = BUNDLED_FONT_FILES["liberation-sans"].path.replace(/[^/]+$/, "");
  const alias = (from: string, to: string) => `<alias binding="same"><family>${from}</family><prefer><family>${to}</family></prefer></alias>`;
  const conf = [
    '<?xml version="1.0"?>',
    '<!DOCTYPE fontconfig SYSTEM "fonts.dtd">',
    "<fontconfig>",
    `<dir>${fontsDir}</dir>`,
    `<cachedir>${join(dir, "fc-cache")}</cachedir>`,
    alias("Arial Narrow", "Liberation Sans Narrow"),
    ...["Arial", "Helvetica", "DejaVu Sans", "sans-serif", "serif", "monospace"].map((f) => alias(f, "Liberation Sans")),
    "</fontconfig>",
  ].join("\n");
  const file = join(dir, "fonts.conf");
  await writeFile(file, conf);
  return file;
}

/** Prints one corpus map and compares it (docs/course-print.md §11). */
export async function runPrint(file: Buffer, fileName: string, opts: PrintRunOptions = {}): Promise<PrintRunReport> {
  const pxPerMm = Math.max(1, Math.round(opts.pxPerMm ?? 10));
  const failures: string[] = [];

  let t = performance.now();
  const imported = await importMapToDocument(file, fileName, "ocad");
  const importMs = Math.round(performance.now() - t);
  const doc = await prepareDocument(imported.documentHash, () => imported.bytes);
  const tiltDeg = imported.analysis.north.meridian?.medianTiltDeg ?? 0;

  const spec = printSheetFor(doc.header, opts);
  const settings = spec.template.settings as { mapFrame: { width: number; height: number } };
  const ratio = spec.mapScale / spec.printScale;
  const course = syntheticCourse(spec.centre, { width: settings.mapFrame.width / ratio, height: settings.mapFrame.height / ratio }, spec.mapScale);
  const resolved: ResolvedSheet = resolveSheet({
    kind: "course",
    template: spec.template,
    course,
    windowCenter: spec.centre,
    mapScale: spec.mapScale,
    meridianTiltDeg: tiltDeg,
    event: { name: "Corpus print run", date: new Date(Date.UTC(2026, 9, 24)) },
    mapName: fileName,
    courseId: "corpus",
  });
  const { sheet, layout } = resolved;
  const rotationDeg = layout.window.rotationDeg ?? 0;

  const fonts = await goldenFonts();
  const input = pageInputFor(doc, sheet, documentPaperFrame(doc));
  t = performance.now();
  const page: ComposedPage = composePage(input, fonts);
  const composeMs = Math.round(performance.now() - t);

  const W = Math.round(sheet.paper.widthMm * pxPerMm), H = Math.round(sheet.paper.heightMm * pxPerMm);
  const qpdfAvailable = await hasTool("qpdf");
  const modes = {} as Record<ColourMode, PrintModeResult>;
  let rgbRaster: RgbaImage | null = null;
  for (const mode of ["rgb", "cmyk"] as const) {
    t = performance.now();
    const out = await renderCoursePages({ document: doc, sheets: [sheet], mode, deterministic: true, info: { title: `${fileName} corpus print` } });
    const renderMs = Math.round(performance.now() - t);
    await opts.onPdf?.(`page.${mode}.pdf`, out.bytes);
    let qpdf: ToolCheck = "skipped";
    if (qpdfAvailable) {
      try {
        const report = await qpdfCheck(out.bytes);
        qpdf = /No syntax or stream encoding errors/.test(report) ? "ok" : `failed: ${report.trim().split("\n").pop()}`;
      } catch (err) {
        qpdf = `failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
      }
    }
    const pageMm = await pdfPageMm(out.bytes);
    const raster = await rasterisePdf(out.bytes, W, H, PAGE_GOLDEN_SUPERSAMPLE);
    const colour = mode === "cmyk" ? await rasteriserCmykColours(page.colours.map((c) => c.cmyk)) : null;
    const oracle = await rasterisePage(page, { pxPerMm, supersample: PAGE_GOLDEN_SUPERSAMPLE, ...(colour ? { colour: (i: number) => colour[i] ?? "#ff00ff" } : {}) });
    const d = diffImages(oracle, raster, 16);
    const d32 = diffImages(oracle, raster, PRINT_SHADING_TOLERANCE);
    const shapeInk = inkUnion(oracle, raster);
    const shapeUnexplained = unexplainedPixels(oracle, raster);
    failures.push(...parityFailures(mode, { strongRatio: d32.ratio, shapeRatio: shapeInk ? shapeUnexplained / shapeInk : 0 }));
    await opts.onImage?.(`page.${mode}.png`, raster);
    await opts.onImage?.(`oracle.${mode}.png`, oracle);
    await opts.onImage?.(`diff.oracle.${mode}.png`, diffPicture(oracle, raster));
    const outlined = await renderCoursePages({ document: doc, sheets: [sheet], mode, deterministic: true, text: "outline" });
    const outlineRaster = await rasterisePdf(outlined.bytes, W, H, PAGE_GOLDEN_SUPERSAMPLE);
    const dOutline = diffImages(oracle, outlineRaster, 16);
    await opts.onImage?.(`diff.oracle.${mode}.outline.png`, diffPicture(oracle, outlineRaster));
    if (mode === "rgb") rgbRaster = raster;
    modes[mode] = {
      bytes: out.bytes.length,
      sha256: sha256(out.bytes),
      renderMs,
      pageMm,
      qpdf,
      parity: { differing: d.differing, total: d.total, ratio: d.ratio },
      outline: { differing: dOutline.differing, total: dOutline.total, ratio: dOutline.ratio },
      strong: { differing: d32.differing, ratio: d32.ratio },
      shape: { unexplained: shapeUnexplained, ink: shapeInk, ratio: shapeInk ? shapeUnexplained / shapeInk : 0 },
      warnings: out.warnings.length,
      sanctioned: pageSanctionedCodes({ mode, description: !!sheet.description, rotated: rotationDeg !== 0 }),
    };
  }

  // ---- legacy page: the rsvg path of routes.ts `renderPage`, same layout ----
  let legacy: PrintRunReport["legacy"];
  if (opts.legacy === false) legacy = { skipped: "--no-legacy" };
  else if (!(await hasCommand(process.env.RSVG_CONVERT_COMMAND ?? "rsvg-convert"))) legacy = { skipped: "rsvg-convert not installed" };
  else {
    legacy = await legacyPage(file, layout, page, spec.mapScale, rgbRaster!, pxPerMm, opts);
  }

  // ---- per-symbol attribution: B9's tool on the window ----
  let symbols: PrintRunReport["symbols"];
  if (opts.symbols === false) symbols = { skipped: "--no-symbols" };
  else {
    const bb = windowBoundingBox(layout.window);
    const window = { minX: bb.minX, minY: bb.minY, maxX: bb.minX + bb.width, maxY: bb.minY + bb.height };
    const report = await runParity(file, fileName, {
      window,
      pxPerMm,
      canonical: true,
      onImages: opts.onSymbolImages ? (row, images) => (row.verdict === "diverges" ? opts.onSymbolImages!(row, images) : undefined) : undefined,
    });
    const diverging = report.rows
      .filter((r) => r.verdict === "diverges")
      .map((r) => ({ code: r.code, name: r.name, kind: r.kind, unexplainedRatio: r.diff!.unexplainedRatio, sanctioned: r.sanctioned }));
    const unsanctioned = diverging.filter((r) => r.sanctioned.length === 0).length;
    symbols = { window: report.window, compared: report.rows.filter((r) => r.diff).length, diverging, unsanctioned };
  }

  failures.push(
    ...checkFailures({
      sheetMm: sheet.paper,
      modes: (["rgb", "cmyk"] as const).map((m) => ({ mode: m, qpdf: modes[m].qpdf, pageMm: modes[m].pageMm })),
      legacyPageMm: "pageMm" in legacy ? legacy.pageMm : null,
      unsanctioned: "unsanctioned" in symbols ? symbols.unsanctioned : 0,
    }),
  );
  const partial = { modes, legacy, symbols };
  return {
    fileName,
    mapScale: spec.mapScale,
    printScale: spec.printScale,
    source: spec.source,
    paper: { widthMm: sheet.paper.widthMm, heightMm: sheet.paper.heightMm, name: spec.paperName },
    window: { widthMm: round3(layout.window.width), heightMm: round3(layout.window.height), rotationDeg: round3(rotationDeg) },
    pxPerMm,
    objects: input.map.objects.length,
    course: { controls: course.controls.length, description: !!sheet.description },
    importMs,
    composeMs,
    ...partial,
    previous: comparePrevious(partial, opts.previous),
    pass: failures.length === 0,
    failures,
  };
}

async function legacyPage(
  file: Buffer,
  layout: ResolvedSheet["layout"],
  page: ComposedPage,
  mapScale: number,
  vector: RgbaImage,
  pxPerMm: number,
  opts: PrintRunOptions,
): Promise<PrintLegacyResult> {
  // The event-map defaults: profile auto, no overrides, north lines below (map-source.ts `parsedMap`).
  const ocadModule = (await import("ocad2geojson")) as Record<string, unknown>;
  const readOcad = ocadModule.readOcad as (buf: Buffer, o?: Record<string, unknown>) => Promise<ParsedOcad>;
  const parsed = await readOcad(file, { quietWarnings: true });
  const stack = applyIofColorStack(parsed, { profile: "auto", scale: mapScale });
  const legacyTiltDeg = probeMeridianLines(parsed.objects as Parameters<typeof probeMeridianLines>[0])?.medianTiltDeg ?? 0;
  const layers = await renderBaseMapLayers(parsed, { inkTo: inkToColor(stack), northLinesBelow: true }, layout.window as MapWindow);
  const svg = composeMapPageSvg({
    document: layout.document,
    window: layout.window,
    baseMap: layers.full,
    inkMap: layers.ink,
    controls: layout.controls,
    legs: layout.legs,
    descriptionRows: layout.descriptionRows,
    descriptionHeader: layout.descriptionHeader,
    title: layout.textValues.course ?? "",
    labelMode: layout.labelMode,
    textValues: layout.textValues,
    overprintScale: layout.overprintScale,
  });
  const dir = await mkdtemp(join(tmpdir(), "oxygen-print-run-"));
  const saved = process.env.FONTCONFIG_FILE;
  try {
    process.env.FONTCONFIG_FILE = await pinnedFontconfig(dir);
    const t = performance.now();
    const pdf = await new RsvgConverter({ timeoutMs: 600_000 }).convert(svg);
    const convertMs = Math.round(performance.now() - t);
    await opts.onPdf?.("legacy.pdf", pdf);
    const raster = await rasterisePdf(pdf, vector.width, vector.height, PAGE_GOLDEN_SUPERSAMPLE);
    await opts.onImage?.("legacy.png", raster);
    // Colour: the vector page as the oracle draws it in the legacy RGB of each source colour.
    const legacyHex = new Map<number, string>();
    for (const c of parsed.colors as Array<{ number: number; rgbArray?: ArrayLike<number> } | null | undefined>) if (c?.rgbArray) legacyHex.set(c.number, rgbHex(c.rgbArray));
    const recoloured = await rasterisePage(page, {
      pxPerMm,
      supersample: PAGE_GOLDEN_SUPERSAMPLE,
      colour: (i) => {
        const c = page.colours[i];
        return (c?.sourceNumber !== undefined && legacyHex.get(c.sourceNumber)) || (c ? render.cmykToHex(c.cmyk) : "#ff00ff");
      },
    });
    await opts.onImage?.("diff.legacy.png", diffPicture(raster, recoloured));
    const d = diffImages(raster, recoloured, 16);
    // Both ratios over the ink of legacy ∪ PDF: the recoloured oracle draws the PDF's shapes (within (a)),
    // so its ink is the PDF's up to the colours' own lightness.
    const ink = inkUnion(raster, vector);
    const unexplained = unexplainedPixels(raster, vector);
    return {
      pageMm: await pdfPageMm(pdf),
      convertMs,
      bytes: pdf.length,
      differing: d.differing,
      ink,
      unexplained,
      inkRatio: ink ? d.differing / ink : 0,
      unexplainedRatio: ink ? unexplained / ink : 0,
      legacyTiltDeg: round3(legacyTiltDeg),
    };
  } finally {
    if (saved === undefined) delete process.env.FONTCONFIG_FILE;
    else process.env.FONTCONFIG_FILE = saved;
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- summary

/** The Markdown summary the CLI writes next to the images. */
export function printMarkdown(r: PrintRunReport): string {
  const pct = (x: number, d = 3) => `${(x * 100).toFixed(d)} %`;
  const kb = (b: number) => `${(b / 1024).toFixed(0)} kB`;
  const lines = [
    `# Corpus print — ${r.fileName}`,
    "",
    `Page ${r.paper.name} (${r.paper.widthMm} × ${r.paper.heightMm} mm) from the ${r.source === "print-window" ? "OCAD print window" : r.source === "bounds" ? "object bounds (no print window)" : "overrides"}, ` +
      `map 1:${r.mapScale} printed at 1:${r.printScale}, window ${r.window.widthMm} × ${r.window.heightMm} mm rotated ${r.window.rotationDeg}°, ` +
      `${r.objects} document objects in the window, a synthetic course of ${r.course.controls} controls${r.course.description ? " with its description block" : ""}. ` +
      `Rasters ${r.pxPerMm} px/mm (pdftocairo, ${PAGE_GOLDEN_SUPERSAMPLE}× supersampled). docs/course-print.md §11.`,
    "",
    `Import ${r.importMs} ms; composePage ${r.composeMs} ms.`,
    "",
    `**${r.pass ? "PASS" : "FAIL"}**${r.failures.length ? ": " + r.failures.join("; ") : ""}`,
    "",
    "| Mode | Bytes | renderCoursePages | Page mm | qpdf --check | Backend parity, embedded fonts (differing / page) | Text as outlines | > 32 levels | Unexplained / ink | Warnings | Sanctioned vs legacy |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const m of ["rgb", "cmyk"] as const) {
    const x = r.modes[m];
    lines.push(
      `| ${m} | ${kb(x.bytes)} | ${x.renderMs} ms | ${x.pageMm.width} × ${x.pageMm.height} | ${x.qpdf} | ${pct(x.parity.ratio)} (${x.parity.differing} / ${x.parity.total}) | ${pct(x.outline.ratio)} | ${pct(x.strong.ratio)} | ${pct(x.shape.ratio, 4)} (${x.shape.unexplained}) | ${x.warnings} | ${x.sanctioned.join(", ")} |`,
    );
  }
  lines.push("", `Gate (§11.3): unexplained ≤ ${PRINT_SHAPE_BUDGET * 100} % of ink and ≤ ${PRINT_PARITY_BUDGET * 100} % of the pixels beyond ${PRINT_SHADING_TOLERANCE} levels; the 16-level and outline columns are reported. Images: \`page.<mode>.png\` (PDF raster), \`oracle.<mode>.png\` (page oracle), \`diff.oracle.<mode>.png\`, \`diff.oracle.<mode>.outline.png\`.`, "", "## Legacy page (rsvg-convert)", "");
  if ("skipped" in r.legacy) lines.push(`Skipped: ${r.legacy.skipped}.`);
  else {
    const l = r.legacy;
    lines.push(
      `Page ${l.pageMm.width} × ${l.pageMm.height} mm, ${kb(l.bytes)}, converted in ${l.convertMs} ms. Against the \`rgb\` page: ` +
        `unexplained ${pct(l.unexplainedRatio, 2)} of ink (${l.unexplained} / ${l.ink}); differing from the page drawn in the legacy RGB ${pct(l.inkRatio, 2)} of ink. ` +
        `Legacy meridian tilt ${l.legacyTiltDeg}° (the page uses the document's, ${r.window.rotationDeg === 0 ? "0" : -r.window.rotationDeg}°).`,
      "",
      "Images: `legacy.png`, `diff.legacy.png` (against the page in the legacy RGB; red = legacy only, blue = vector only, magenta = both in different colours).",
    );
  }
  lines.push("", "## Base-map symbols on the window (runParity, canonical)", "");
  if ("skipped" in r.symbols) lines.push(`Skipped: ${r.symbols.skipped}.`);
  else {
    const s = r.symbols;
    lines.push(`${s.compared} symbols compared, ${s.diverging.length} diverge, ${s.unsanctioned} without a sanctioned difference.`, "");
    if (s.diverging.length) {
      lines.push("| Code | Name | Kind | Unexplained / ink | Sanctioned |", "|---|---|---|---|---|");
      for (const d of s.diverging) lines.push(`| ${d.code} | ${d.name.replace(/\|/g, "/")} | ${d.kind} | ${pct(d.unexplainedRatio, 2)} | ${d.sanctioned.join(", ") || "**none**"} |`);
    }
  }
  if (r.previous) {
    const p = r.previous;
    const sgn = (v: number, f: (v: number) => string) => `${v >= 0 ? "+" : ""}${f(v)}`;
    lines.push("", "## Against the previous run", "", "| Mode | Same bytes | Bytes | renderCoursePages | Backend parity, fonts | Backend parity, outlines |", "|---|---|---|---|---|---|");
    for (const m of ["rgb", "cmyk"] as const) {
      lines.push(`| ${m} | ${p.sameBytes[m] ? "yes" : "**no**"} | ${sgn(p.bytesDelta[m], String)} | ${sgn(p.renderMsDelta[m], (v) => `${v} ms`)} | ${sgn(p.parityDelta[m] * 100, (v) => `${v.toFixed(3)} pp`)} | ${sgn(p.outlineDelta[m] * 100, (v) => `${v.toFixed(3)} pp`)} |`);
    }
    lines.push(
      "",
      `Legacy unexplained: ${p.legacyUnexplainedDelta === null ? "–" : sgn(p.legacyUnexplainedDelta * 100, (v) => `${v.toFixed(2)} pp`)}; diverging symbols: ${p.divergingDelta === null ? "–" : sgn(p.divergingDelta, String)}.`,
    );
  }
  const used = [...new Set([...r.modes.rgb.sanctioned, ...r.modes.cmyk.sanctioned])].sort();
  lines.push("", "## Sanctioned differences (course-print.md §8.4)", "");
  for (const c of used) lines.push(`- \`${c}\`: ${PRINT_SANCTIONED[c]}`);
  lines.push("");
  return lines.join("\n");
}
