/**
 * Corpus parity (docs/map-rendering.md §6.4): one paper window of an OCAD
 * map rendered through both pipelines, one symbol at a time — the legacy
 * `ocad2geojson` SVG rasterised by resvg exactly as the tiles do
 * (`map-tiles.ts`, `map-window.ts`), and the document path (importer →
 * bridge → `symbolise` → reference raster). Every other symbol is hidden
 * on both sides, so a difference belongs to the symbol's row.
 *
 * Both sides go through resvg at the same pixel grid, so anti-aliasing is
 * the same where the geometry is; the new side is coloured with the
 * legacy RGB of each source colour so the diff measures geometry, not the
 * CMYK conversion (that table is reported once, apart). Tool code only:
 * nothing in the app imports it.
 */

import { mapDocument, render } from "@oxygen/shared";
import { importMapToDocument } from "../import/ocad.js";
import { parseViewBox, windowPixelSize, windowViewBox, withViewBox, type OcadRect } from "../map-window.js";
import { glyphOutlineFrom, loadBundledFont } from "./fonts.js";
import { diffImages, rasterisePassStream, type ImageDiff } from "./reference-raster.js";

/** Paper window, mm, y-up (the document's paper frame; OCAD coordinates / 100). */
export interface ParityWindowMm {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface ParityOptions {
  /** Window to compare; default the legacy reader's map bounds. Snapped outwards to whole mm. */
  window?: ParityWindowMm;
  /** Whole px/mm; default 10 (the golden density, §6.2). */
  pxPerMm?: number;
  /** Only these source codes (e.g. "510.0"). */
  codes?: readonly string[];
  /** Objects whose bounds come within this distance of the window are drawn (glyph and halo extents); default 10 mm. */
  marginMm?: number;
  /** Per-channel tolerance of a differing pixel; default 16 (`diffImages`, §6.2). */
  channelTolerance?: number;
  /**
   * Draw matched symbols from their canonical entries, as users see the map (default true). `false`
   * draws every symbol from its own source definition: renderer and importer against the legacy,
   * with the library out of the comparison.
   */
  canonical?: boolean;
  /** Keep the RGBA images on the rows; default false. */
  keepImages?: boolean;
  /** Called with each compared row's images as soon as they exist (the CLI writes them; a whole map's do not fit in memory). */
  onImages?: (row: ParityRow, images: ParityImages) => Promise<void> | void;
}

/**
 * A row's verdict: `close` when at most `CLOSE_INK_RATIO` of the inked pixels
 * (either side) differ in shape (`unexplainedPixels`), `diverges` otherwise;
 * `empty` when neither side draws anything in the window.
 */
export type ParityVerdict = "close" | "diverges" | "empty";

/**
 * Unexplained ÷ inked pixels at or under which a symbol counts as matching (`unexplainedPixels`):
 * sub-pixel placement of 1 px features (0.1 mm at 10 px/mm) flips whole pixels at the channel
 * tolerance without any difference in shape.
 */
export const CLOSE_INK_RATIO = 0.1;

/**
 * Differences the new pipeline makes on purpose (03 §4.1 lists what the
 * legacy renderer gets wrong; 03 §6.9 and map-rendering §4 pin the
 * replacement). A row carries the codes its IR and its objects trigger.
 */
export const SANCTIONED = {
  "dash-fitting": "OCAD dashes fitted per section between corner / dash points (legacy: one uniform stroke-dasharray)",
  "dash-points": "dash points (flag 8) centre a dash and split sections (legacy ignores them)",
  "secondary-symbols": "OCAD secondary symbols once per section (legacy draws none)",
  "corner-angle": "corner glyphs on the bisector of the two tangents (legacy: the incoming segment)",
  "border-flags": "double-line noLeft / noRight vertices interrupt a border (legacy ignores them)",
  "gap-flags": "vertex gap flags interrupt the line (legacy ignores them)",
  "pointed-caps": "pointed line ends taper (legacy: flat)",
  "pattern-origin": "hatches and structure patterns anchored at the paper origin, patterns with the symbol's clip mode (legacy: SVG viewport origin, always clipped)",
  "text-fonts": "text set in the bundled Liberation fonts as outlines (legacy: SVG <text> in system fonts)",
  "rectangle-symbols": "OCAD rectangle symbols (type 7) are drawn (legacy draws none)",
  "line-end-symbols": "OCAD start / end symbols only where useSymbolFlags enables them (map-import §3.3; legacy draws any present)",
  "corner-ends": "corner / dash-point glyphs on flagged line ends (§4.5; legacy never draws them on an end)",
  "glyph-spacing": "spaced line symbols laid out per corner section by the §4.5 rule (legacy rounds its own way per section)",
  "curve-glyphs": "symbols along curved lines placed and turned on the curve (legacy walks the Bézier control polygon: more spots, off the line, polygon angles)",
} as const;
export type SanctionedCode = keyof typeof SANCTIONED;

export type ParityState = "source" | "canonical" | "proxy" | "hidden" | "missing";

export interface ParityImages {
  old: RgbaImage;
  new: RgbaImage;
  diff: RgbaImage;
}

export interface RgbaImage {
  width: number;
  height: number;
  pixels: Uint8Array;
}

export interface ParityRow {
  code: string;
  name: string;
  kind: string;
  /** Source objects of the symbol near the window. */
  objects: number;
  state: ParityState;
  canonicalId?: string;
  /**
   * Compared rows only (not hidden / proxy / missing): `differing` at the channel tolerance, `ink` the
   * pixels inked on either side, `unexplained` the shape difference beyond one pixel (`unexplainedPixels`).
   */
  diff?: ImageDiff & { ink: number; inkRatio: number; unexplained: number; unexplainedRatio: number };
  verdict?: ParityVerdict;
  sanctioned: SanctionedCode[];
  images?: ParityImages;
}

export interface ParityReport {
  fileName: string;
  /** Whether matched symbols were drawn from their canonical entries. */
  canonical: boolean;
  window: ParityWindowMm;
  pxPerMm: number;
  size: { width: number; height: number };
  /** Compared rows ranked most divergent first, then the rest by code. */
  rows: ParityRow[];
  /** Source colours whose shared screen conversion differs from the legacy RGB by more than the tolerance. */
  colourDifferences: { number: number; name: string; legacy: string; shared: string }[];
}

interface LegacyObject {
  sym: number;
  coordinates: Array<number[] & { xFlags?: number; yFlags?: number }>;
}
interface LegacyColour {
  number: number;
  name?: string;
  cmyk: number[];
  rgbArray: ArrayLike<number>;
}
interface LegacyFile {
  objects: LegacyObject[];
  symbols: {
    symNum: number; number?: string; description?: string; status?: number;
    useSymbolFlags?: number; startSymElements?: unknown[]; endSymElements?: unknown[];
  }[];
  colors: (LegacyColour | undefined)[];
  getBounds(): number[];
}
type OcadToSvg = (file: unknown, opts: Record<string, unknown>) => { outerHTML: string };

const hex = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
const rgbHex = (c: ArrayLike<number>) => `#${hex(c[0])}${hex(c[1])}${hex(c[2])}`;

/** Runs the comparison over every symbol with objects near the window. */
export async function runParity(file: Buffer, fileName: string, opts: ParityOptions = {}): Promise<ParityReport> {
  const pxPerMm = Math.max(1, Math.round(opts.pxPerMm ?? 10));
  const tolerance = opts.channelTolerance ?? 16;
  const marginOcad = (opts.marginMm ?? 10) * 100;

  // ---- legacy side: the tiles' reader and generator ----
  const ocadMod = (await import("ocad2geojson")) as Record<string, unknown>;
  const readOcad = ocadMod.readOcad as (buf: Buffer, o?: Record<string, unknown>) => Promise<LegacyFile>;
  const ocadToSvg = ocadMod.ocadToSvg as OcadToSvg;
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
  const legacy = await readOcad(file, { quietWarnings: true });
  const ocadBounds = legacy.getBounds();

  const w = snapWindow(opts.window ?? { minX: ocadBounds[0] / 100, minY: ocadBounds[1] / 100, maxX: ocadBounds[2] / 100, maxY: ocadBounds[3] / 100 });
  const rect: OcadRect = { minX: w.minX * 100, minY: w.minY * 100, maxX: w.maxX * 100, maxY: w.maxY * 100 };
  const size = windowPixelSize(rect, pxPerMm / 100);
  const boundsUm: render.Bounds = { minX: w.minX * 1000, minY: w.minY * 1000, maxX: w.maxX * 1000, maxY: w.maxY * 1000 };
  const near = (x0: number, y0: number, x1: number, y1: number, m: number, r: OcadRect) =>
    x1 >= r.minX - m && x0 <= r.maxX + m && y1 >= r.minY - m && y0 <= r.maxY + m;

  const legacyBySym = new Map<number, LegacyObject[]>();
  for (const o of legacy.objects) {
    if (!o.coordinates?.length) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of o.coordinates) {
      if (c[0] < x0) x0 = c[0];
      if (c[0] > x1) x1 = c[0];
      if (c[1] < y0) y0 = c[1];
      if (c[1] > y1) y1 = c[1];
    }
    if (!near(x0, y0, x1, y1, marginOcad, rect)) continue;
    let arr = legacyBySym.get(o.sym);
    if (!arr) legacyBySym.set(o.sym, (arr = []));
    arr.push(o);
  }

  // ---- new side: the document as stored, canonical layer on ----
  const imported = await importMapToDocument(file, fileName, "ocad");
  const doc = mapDocument.decodeMapDocument(imported.bytes);
  const canonical = opts.canonical ?? true;
  const input = mapDocument.documentRenderInput(doc, { canonical });
  const nDoc = doc.header.symbols.length;
  const newBySym = new Map<number, render.RenderObject[]>();
  const marginUm = marginOcad * 10;
  for (const o of input.objects) {
    if (o.symbolIdx >= nDoc) continue; // proxy-drawn: reported from the header below
    const c = o.path.coords;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < c.length; k += 2) {
      if (c[k] < x0) x0 = c[k];
      if (c[k] > x1) x1 = c[k];
      if (c[k + 1] < y0) y0 = c[k + 1];
      if (c[k + 1] > y1) y1 = c[k + 1];
    }
    if (!near(x0, y0, x1, y1, marginUm, boundsUm)) continue;
    let arr = newBySym.get(o.symbolIdx);
    if (!arr) newBySym.set(o.symbolIdx, (arr = []));
    arr.push(o);
  }

  // Colours: the new side takes the legacy RGB of its source colour.
  const legacyHex = new Map<number, string>();
  for (const c of legacy.colors) if (c) legacyHex.set(c.number, rgbHex(c.rgbArray));
  const colourHex = doc.header.colours.map((c) => (c.sourceNumber !== undefined && legacyHex.get(c.sourceNumber)) || render.cmykToHex(c.cmyk));
  const colour = (i: number) => colourHex[i] ?? "#ff00ff";
  const colourDifferences: ParityReport["colourDifferences"] = [];
  for (const c of legacy.colors) {
    if (!c) continue;
    const shared = render.cmykToHex([c.cmyk[0] / 100, c.cmyk[1] / 100, c.cmyk[2] / 100, c.cmyk[3] / 100]);
    const a = rgbHex(c.rgbArray);
    if (channelDistance(a, shared) > tolerance) colourDifferences.push({ number: c.number, name: c.name ?? "", legacy: a, shared });
  }

  const fonts = await Promise.all([loadBundledFont("liberation-sans"), loadBundledFont("liberation-sans-narrow")]);
  const glyphOutline = glyphOutlineFrom(fonts);
  const symNumOf = (s: mapDocument.DocumentSymbol) => (s.sourceIndex !== undefined ? legacy.symbols[s.sourceIndex]?.symNum : undefined);

  const rows: ParityRow[] = [];
  const seenSymNums = new Set<number>();
  for (let si = 0; si < nDoc; si++) {
    const s = doc.header.symbols[si];
    if (opts.codes && !opts.codes.includes(s.code)) continue;
    const symNum = symNumOf(s);
    if (symNum !== undefined) seenSymNums.add(symNum);
    const oldObjects = symNum !== undefined ? legacyBySym.get(symNum) ?? [] : [];
    const newObjects = newBySym.get(si) ?? [];
    const objects = Math.max(oldObjects.length, newObjects.length);
    if (objects === 0 && !(s.origin === "source" && !s.render && countNear(doc, si, boundsUm, marginUm) > 0)) continue;
    const applied = canonical && mapDocument.isAppliedMatch(s.match);
    const row: ParityRow = {
      code: s.code,
      name: s.name,
      kind: s.kind,
      objects: objects || countNear(doc, si, boundsUm, marginUm),
      state: s.hidden ? "hidden" : s.origin === "missing" ? "missing" : applied ? "canonical" : s.render ? "source" : "proxy",
      sanctioned: [],
    };
    if (applied && s.match?.canonicalId) row.canonicalId = s.match.canonicalId;
    if (row.state === "hidden" || row.state === "proxy" || row.state === "missing" || s.origin === "graphic") {
      rows.push(row);
      continue;
    }
    const sym = input.symbols[si];
    const tags = new Set<SanctionedCode>(sanctionedFor(sym, newObjects));
    if (s.kind === "rectangle") tags.add("rectangle-symbols");
    const ls = symNum !== undefined ? legacy.symbols[s.sourceIndex!] : undefined;
    const use = ls?.useSymbolFlags ?? 0;
    if (ls && (((ls.startSymElements?.length ?? 0) > 0 && !(use & 2)) || ((ls.endSymElements?.length ?? 0) > 0 && !(use & 1)))) tags.add("line-end-symbols");
    row.sanctioned = [...tags].sort();

    const oldImg = await legacyWindow(ocadToSvg, legacy, dom.window.document, oldObjects, rect, ocadBounds, size);
    const { stream } = render.symbolise({ objects: newObjects, symbols: input.symbols, fonts });
    const newRaster = await rasterisePassStream(stream, { colour, bounds: boundsUm, pxPerMm, background: "#ffffff", glyphOutline });
    const newImg: RgbaImage = { width: newRaster.width, height: newRaster.height, pixels: newRaster.pixels };
    if (newImg.width !== oldImg.width || newImg.height !== oldImg.height) {
      throw new Error(`${s.code}: pixel grids differ (${oldImg.width}×${oldImg.height} legacy, ${newImg.width}×${newImg.height} new)`);
    }
    const d = diffImages(oldImg, newImg, tolerance);
    const ink = inkUnion(oldImg, newImg);
    const unexplained = unexplainedPixels(oldImg, newImg);
    row.diff = { ...d, ink, inkRatio: ink === 0 ? 0 : d.differing / ink, unexplained, unexplainedRatio: ink === 0 ? 0 : unexplained / ink };
    row.verdict = ink === 0 ? "empty" : row.diff.unexplainedRatio <= CLOSE_INK_RATIO ? "close" : "diverges";
    if (opts.keepImages || opts.onImages) {
      const images = { old: oldImg, new: newImg, diff: diffPicture(oldImg, newImg, tolerance) };
      if (opts.keepImages) row.images = images;
      await opts.onImages?.(row, images);
    }
    rows.push(row);
  }
  // Legacy symbols the document has no symbol for (should not happen; reported, not drawn).
  for (const [symNum, objs] of legacyBySym) {
    if (seenSymNums.has(symNum) || symNum <= -2) continue;
    const ls = legacy.symbols.find((x) => x.symNum === symNum);
    const code = ls?.number ?? `${Math.floor(symNum / 1000)}.${symNum % 1000}`;
    if (opts.codes && !opts.codes.includes(code)) continue;
    rows.push({ code, name: ls?.description ?? "", kind: "?", objects: objs.length, state: "missing", sanctioned: [] });
  }

  rows.sort(rankRows);
  return { fileName, canonical, window: w, pxPerMm, size, rows, colourDifferences };
}

/** Compared rows first, most divergent first (unexplained ratio, then the plain ink ratio, then count); the rest by code. */
export function rankRows(a: ParityRow, b: ParityRow): number {
  if (!!a.diff !== !!b.diff) return a.diff ? -1 : 1;
  if (a.diff && b.diff) {
    return b.diff.unexplainedRatio - a.diff.unexplainedRatio || b.diff.inkRatio - a.diff.inkRatio || b.diff.unexplained - a.diff.unexplained || compareCodes(a.code, b.code);
  }
  return compareCodes(a.code, b.code);
}

function compareCodes(a: string, b: string): number {
  const [ai, af] = a.split(".").map(Number), [bi, bf] = b.split(".").map(Number);
  return Number.isFinite(ai) && Number.isFinite(bi) ? ai - bi || (af ?? 0) - (bf ?? 0) : a.localeCompare(b);
}

/** Whole mm, outwards. */
export function snapWindow(w: ParityWindowMm): ParityWindowMm {
  return { minX: Math.floor(w.minX), minY: Math.floor(w.minY), maxX: Math.ceil(w.maxX), maxY: Math.ceil(w.maxY) };
}

/** Sanctioned differences a symbol triggers, from its IR and its objects' vertex flags. */
export function sanctionedFor(sym: render.RenderSymbol, objects: readonly render.RenderObject[]): SanctionedCode[] {
  const out = new Set<SanctionedCode>();
  let flags = 0;
  for (const o of objects) for (const f of o.path.flags ?? []) flags |= f;
  const F = render.COORD_FLAG;
  const line = (b: render.LineSymbolBody | undefined) => {
    if (!b) return;
    const strokes = [b.main, b.borders?.left, b.borders?.right].filter((x) => !!x);
    if (strokes.some((x) => x.dash?.layout === "ocad")) out.add("dash-fitting");
    if (flags & F.dash && (strokes.some((x) => x.dash) || b.glyphs?.some((g) => g.placement.at === "dashPoints"))) out.add("dash-points");
    if (b.glyphs?.some((g) => g.placement.at === "sectionCentres")) out.add("secondary-symbols");
    if (b.glyphs?.some((g) => g.placement.at === "corners" || g.placement.at === "dashPoints")) out.add("corner-angle");
    if (b.borders && flags & (F.noLeft | F.noRight)) out.add("border-flags");
    if (flags & F.gap) out.add("gap-flags");
    if (b.main?.cap === "pointed") out.add("pointed-caps");
    if (b.glyphs?.some((g) => g.placement.at === "spaced")) out.add("glyph-spacing");
    if (b.glyphs?.length && flags & F.bezierFirst) out.add("curve-glyphs");
    const endMask = (b.glyphs ?? []).reduce((m, g) => m | (g.placement.at === "corners" ? F.corner : g.placement.at === "dashPoints" ? F.dash : 0), 0);
    if (endMask && objects.some((o) => !o.path.closed && o.path.flags && (o.path.flags[0] & endMask || o.path.flags[o.path.flags.length - 1] & endMask))) out.add("corner-ends");
  };
  if (sym.type === "line") line(sym);
  else if (sym.type === "area") {
    if (sym.patterns?.length || sym.hatches?.length) out.add("pattern-origin");
    line(sym.border);
  } else if (sym.type === "text") out.add("text-fonts");
  return [...out].sort();
}

async function legacyWindow(
  ocadToSvg: OcadToSvg,
  legacy: LegacyFile,
  document: unknown,
  objects: LegacyObject[],
  rect: OcadRect,
  ocadBounds: number[],
  size: { width: number; height: number },
): Promise<RgbaImage> {
  if (objects.length === 0) return blank(size);
  const svg = ocadToSvg(legacy, { document, generateSymbolElements: true, exportHidden: false, objects }).outerHTML;
  const root = parseViewBox(svg);
  const viewBox = root ? windowViewBox(root, ocadBounds, rect) : null;
  if (!viewBox) throw new Error("legacy SVG viewBox does not span the OCAD bounds");
  const { renderAsync } = await import("@resvg/resvg-js");
  const r = await renderAsync(withViewBox(svg, viewBox), { fitTo: { mode: "width", value: size.width }, background: "white" });
  return { width: r.width, height: r.height, pixels: new Uint8Array(r.pixels.buffer, r.pixels.byteOffset, r.pixels.byteLength) };
}

function blank(size: { width: number; height: number }): RgbaImage {
  return { ...size, pixels: new Uint8Array(size.width * size.height * 4).fill(255) };
}

function countNear(doc: mapDocument.MapDocument, si: number, b: render.Bounds, m: number): number {
  const unitUm = 1000 / doc.header.unitsPerMm;
  let n = 0;
  for (let i = 0; i < doc.header.objects.count; i++) {
    if (doc.attrs.symbolIdx[i] !== si) continue;
    const s = doc.coordStart[i], e = doc.coordStart[i + 1];
    for (let k = s; k < e; k++) {
      const x = doc.coords[k * 2] * unitUm, y = doc.coords[k * 2 + 1] * unitUm;
      if (x >= b.minX - m && x <= b.maxX + m && y >= b.minY - m && y <= b.maxY + m) {
        n++;
        break;
      }
    }
  }
  return n;
}

const INK = 250;
const isInk = (p: Uint8Array, o: number) => p[o] < INK || p[o + 1] < INK || p[o + 2] < INK;

/**
 * Shape difference: pixels inked on one side (more than `MASK_DEVIATION` below white in some channel,
 * about a fifth of full coverage) with no ink within one pixel on the other side. Anti-aliasing shades
 * and sub-pixel placement of the same shape never count; a missing, extra or displaced part does.
 */
export function unexplainedPixels(a: RgbaImage, b: RgbaImage): number {
  const { width: w, height: h } = a;
  const ma = inkMask(a), mb = inkMask(b);
  const near = (m: Uint8Array, x: number, y: number) => {
    for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++) {
      for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) if (m[yy * w + xx]) return true;
    }
    return false;
  };
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if ((ma[i] && !near(mb, x, y)) || (mb[i] && !near(ma, x, y))) n++;
    }
  }
  return n;
}

/** Channel deviation from white above which a pixel belongs to a shape. */
export const MASK_DEVIATION = 48;

function inkMask(img: RgbaImage): Uint8Array {
  const p = img.pixels, m = new Uint8Array(img.width * img.height);
  for (let i = 0, o = 0; i < m.length; i++, o += 4) m[i] = 255 - Math.min(p[o], p[o + 1], p[o + 2]) > MASK_DEVIATION ? 1 : 0;
  return m;
}

function inkUnion(a: RgbaImage, b: RgbaImage): number {
  let n = 0;
  for (let o = 0; o < a.pixels.length; o += 4) if (isInk(a.pixels, o) || isInk(b.pixels, o)) n++;
  return n;
}

/**
 * Red: ink only in the legacy image (missing in the new); blue: ink only in
 * the new; magenta: both inked, different colour; grey: equal ink.
 */
export function diffPicture(a: RgbaImage, b: RgbaImage, tolerance = 16): RgbaImage {
  const out = new Uint8Array(a.pixels.length);
  for (let o = 0; o < out.length; o += 4) {
    const pa = a.pixels, pb = b.pixels;
    const d = Math.max(Math.abs(pa[o] - pb[o]), Math.abs(pa[o + 1] - pb[o + 1]), Math.abs(pa[o + 2] - pb[o + 2]));
    const ia = isInk(pa, o), ib = isInk(pb, o);
    let rgb: [number, number, number];
    if (d <= tolerance) {
      const l = 255 - Math.round((255 - (pa[o] + pa[o + 1] + pa[o + 2]) / 3) * 0.35);
      rgb = [l, l, l];
    } else if (ia && !ib) rgb = [220, 0, 0];
    else if (ib && !ia) rgb = [0, 70, 230];
    else rgb = [200, 0, 200];
    out[o] = rgb[0]; out[o + 1] = rgb[1]; out[o + 2] = rgb[2]; out[o + 3] = 255;
  }
  return { width: a.width, height: a.height, pixels: out };
}

function channelDistance(a: string, b: string): number {
  let d = 0;
  for (let i = 1; i < 7; i += 2) d = Math.max(d, Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16)));
  return d;
}

/** File-name stem for a row's images: the code with characters safe on every file system. */
export function rowFileStem(row: Pick<ParityRow, "code">): string {
  return row.code.replace(/[^0-9A-Za-z._-]/g, "_");
}

/** The Markdown summary the CLI writes next to the images. */
export function parityMarkdown(report: ParityReport): string {
  const pct = (x: number) => `${(x * 100).toFixed(2)} %`;
  const w = report.window;
  const lines = [
    `# Corpus parity — ${report.fileName}`,
    "",
    `Window ${w.minX},${w.minY} – ${w.maxX},${w.maxY} mm (paper, y-up), ${report.pxPerMm} px/mm, ${report.size.width}×${report.size.height} px. ` +
      `Legacy = \`ocad2geojson\` SVG via resvg (the tiles); new = document → reference raster, coloured with the legacy RGB, ` +
      `${report.canonical ? "matched symbols drawn from their canonical entries (as users see the map)" : "every symbol drawn from its source definition (canonical rendering off)"}. ` +
      `Unexplained = inked on one side with no ink within one pixel on the other (shape, not anti-aliasing); differing = channel tolerance 16. ` +
      `Verdict \`close\` at ≤ ${pct(CLOSE_INK_RATIO)} unexplained. docs/map-rendering.md §6.4.`,
    "",
    "| # | Code | Name | Kind | Objects | Drawn from | Unexplained / ink | Differing / ink | Verdict | Sanctioned | Images |",
    "|---|------|------|------|---------|------------|-------------------|-----------------|---------|------------|--------|",
  ];
  let i = 0;
  for (const r of report.rows) {
    const from = r.state === "canonical" ? `canonical ${r.canonicalId ?? ""}`.trim() : r.state;
    const stem = rowFileStem(r);
    const imgs = r.diff ? `[old](${stem}.old.png) · [new](${stem}.new.png) · [diff](${stem}.diff.png)` : "";
    lines.push(
      `| ${r.diff ? ++i : "–"} | ${r.code} | ${r.name.replace(/\|/g, "/")} | ${r.kind} | ${r.objects} | ${from} | ` +
        `${r.diff ? `${pct(r.diff.unexplainedRatio)} (${r.diff.unexplained} / ${r.diff.ink})` : "–"} | ${r.diff ? pct(r.diff.inkRatio) : "–"} | ` +
        `${r.verdict ?? "not compared"} | ${r.sanctioned.join(", ")} | ${imgs} |`,
    );
  }
  lines.push("", "Diff images: red = ink only in the legacy, blue = ink only in the new, magenta = both inked in different colours, grey = equal.", "");
  const used = [...new Set(report.rows.flatMap((r) => r.sanctioned))].sort();
  if (used.length) {
    lines.push("## Sanctioned differences triggered", "");
    for (const c of used) lines.push(`- \`${c}\`: ${SANCTIONED[c as SanctionedCode]}`);
    lines.push("");
  }
  if (report.colourDifferences.length) {
    lines.push("## Colour conversion (not part of the diff)", "", "| OCAD colour | Name | Legacy RGB | Shared `cmykToHex` |", "|---|---|---|---|");
    for (const c of report.colourDifferences) lines.push(`| ${c.number} | ${c.name} | ${c.legacy} | ${c.shared} |`);
    lines.push("");
  }
  return lines.join("\n");
}
