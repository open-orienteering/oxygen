/**
 * Pass stream → PDF content-stream operators, one pass at a time and in
 * stream order (docs/map-rendering.md §5.3, research 05 §5.2–5.3). Every
 * decision is the stage's; this layer only encodes:
 *
 * - coordinates as integers in a layer unit relative to an origin, under
 *   one `cm` (paper µm → page points, `mapLayerOperators`): 5 µm on the
 *   printed paper or finer, a whole fraction of OCAD's 10 µm grid, the
 *   origin on that grid (map-rendering.md §5.3, SLICES C11); each fill or
 *   stroke under its own anchor `q 1 0 0 1 x y cm … Q` at its lower-left
 *   corner, so its numbers are short and never negative;
 * - fills `m / l / c … h f*` (even-odd, map-rendering §3.1), Béziers kept;
 *   a fill ring's closing `l` back to its start is left to `h`;
 * - strokes `w J j … S`; dash slices as one subpath each (never `d`);
 *   `pointed` + `taper` as the shared `strokeOutline()` filled `f`;
 * - glyph parts as form XObjects: instances sharing a turn and scale draw
 *   a form that carries it as `/Matrix`, chained by relative translations
 *   `1 0 0 1 dx dy cm /Gn Do` inside `q … Q`; a rare turn draws the plain
 *   form under its own `q a b c d e f cm /Gn Do Q`; a clip-mode pattern
 *   inside `q <area> W* n … Q`;
 * - hatches as explicit `hatchLines()` inside the area's clip;
 * - text `BT /Fn size Tf … Tm <gid> Tj ET`, a halo pass with `1 Tr`
 *   at `2 × haloWidthUm`; without an embedded font, the glyph outlines.
 *
 * Writer-independent: resources are names handed out by `OperatorResources`.
 */

import type { FontRef, GlyphMesh, Pass, PassStream, RenderPath, StrokeCap, StrokeJoin } from "../render/pass-stream.js";
import { type Bounds, type Segment, hatchLines, pathBounds, pathRings, ringSegments, sliceSegments, unionBounds } from "../render/path.js";
import { STROKE_MITRE_LIMIT, strokeOutline } from "../render/geometry.js";
import { type GlyphOutline, passStreamBounds } from "../render/reference-svg.js";
import { COORD_FLAG } from "../render/pass-stream.js";
import type { ColourStack } from "../render/symbol.js";
import { type ColourMode, type PdfColour, colourOperator, stackColour } from "./colour.js";
import { glyphHex } from "./fonts.js";

/** Paper µm → PDF points at 1:1 (72 pt per inch). */
export const UM_TO_PT = 72 / 25400;
/** Page millimetres → PDF points. */
export const MM_TO_PT = 72 / 25.4;

/** `[a b c d e f]` of a PDF transformation matrix. */
export type Matrix = [number, number, number, number, number, number];

/** Names of the resources a content stream refers to; the writer hands them out. */
export interface OperatorResources {
  /**
   * Font resource name for a text pass's face (without the slash), after
   * recording that `glyphIds` are drawn with it; `undefined` = draw the
   * glyph outlines instead (05 §5.6 fallback).
   */
  font(ref: FontRef, glyphIds: ArrayLike<number>): string | undefined;
  /** Outline of a glyph for the fallback (font units, y-up). */
  glyphOutline?(ref: FontRef, glyphId: number): GlyphOutline | undefined;
  /**
   * Form XObject resource name for one glyph part (without the slash),
   * drawn through `matrix` (its `/Matrix`: glyph µm → the content's
   * units, turn and scale folded in); default the identity.
   */
  glyph(mesh: GlyphMesh, matrix?: Matrix): string;
}

export interface OperatorOptions {
  /** The document's colour stack: pass colour index → entry with CMYK. */
  colours: Pick<ColourStack[number], "cmyk">[];
  mode: ColourMode;
  resources: OperatorResources;
  /** Paper µm subtracted from every coordinate so integers stay small (the window origin). */
  originUm?: [number, number];
  /** Paper µm per written coordinate unit; default 1. `mapLayerOperators` picks it (`layerUnitUm`). */
  unitUm?: number;
  /**
   * The printed frame in the stream's own coordinates (paper µm, before the
   * origin is subtracted): what cannot paint inside it is left out
   * (map-rendering.md §5.3 "Frame culling"). Unset = nothing is.
   */
  cull?: Bounds;
}

/** A PDF number: fixed-point (never JS exponent notation, ISO 32000 §7.3.3), trailing zeros dropped. */
const num = (v: number, decimals: number): string => {
  let t = v.toFixed(decimals);
  if (t.includes(".")) t = t.replace(/0+$/, "").replace(/\.$/, "");
  return t === "-0" ? "0" : t;
};
/** An integer (rounded half up; `-0` written `0`). */
const int = (v: number): string => String(Math.round(v) || 0);
/** Integer µm. */
const um = int;

/**
 * The `cm` operator. 6 decimals suit instance matrices (cos·scale); the
 * map layer's µm → pt factors (~3e-3) take 9, or a 1 m window would be
 * off by a quarter millimetre.
 */
export function cmOperator(m: Matrix, decimals = 6): string {
  return `${m.map((v) => num(v, decimals)).join(" ")} cm`;
}

/** OCAD's coordinate grid, µm: layer units divide it, so its coordinates are written exactly. */
export const PRINT_GRID_UM = 10;
/**
 * The largest layer unit on the printed paper, µm. Rounding moves a
 * computed point by at most ½√2 unit = 3.5 µm: 0.035 px at the golden
 * tier's 10 px/mm, ≤ 9 of its 16 levels per edge (10 µm, 7 µm, broke
 * `lib-borders` and `lib-hatch`); below every print resolution.
 */
export const PRINT_QUANTUM_UM = 5;

/**
 * The layer unit for `matrix` (paper µm → points): `PRINT_GRID_UM ÷ n`
 * with `n` the smallest whole number that keeps a unit at most
 * `PRINT_QUANTUM_UM` on the printed paper — 10 µm for a map reduced to
 * half, 5 µm at 1:1, 10/3 µm for a 1:15 000 map printed at 1:10 000.
 * A whole fraction of 10 µm keeps OCAD's coordinates exact; computed
 * points (dash ends, outlines, glyph and text origins) round by at most
 * half a unit per axis (map-rendering.md §5.3).
 */
export function layerUnitUm(matrix: Matrix): number {
  const printedPerUm = Math.hypot(matrix[0], matrix[1]) / UM_TO_PT;
  return PRINT_GRID_UM / Math.max(1, Math.ceil((printedPerUm * PRINT_GRID_UM) / PRINT_QUANTUM_UM - 1e-9));
}

/**
 * The map layer's matrix (research 05 §5.2): paper µm relative to the
 * operator origin → page points, at `scaleRatio` (map scale ÷ print
 * scale, e.g. 1.5 for a 1:15 000 map printed at 1:10 000), rotated
 * `rotationDeg` counter-clockwise, the origin landing on `atPt`. The
 * page composer (C2) picks origin, angle and point.
 */
export function layerMatrix(opts: { scaleRatio: number; rotationDeg?: number; atPt: [number, number] }): Matrix {
  const s = opts.scaleRatio * UM_TO_PT;
  const a = ((opts.rotationDeg ?? 0) * Math.PI) / 180;
  const c = Math.cos(a) * s, n = Math.sin(a) * s;
  return [c, n, -n, c, opts.atPt[0], opts.atPt[1]];
}

const CAP: Record<StrokeCap, number> = { butt: 0, round: 1, square: 2, pointed: 0 };
const JOIN: Record<StrokeJoin, number> = { miter: 0, round: 1, bevel: 2 };

/**
 * Paper µm → written coordinates: integers in a unit relative to an
 * origin, less an integer anchor (a path's own corner under its own `cm`).
 */
interface Coords {
  ox: number;
  oy: number;
  /** 1 ÷ unit. */
  k: number;
  ax: number;
  ay: number;
}

const coords = (origin: [number, number] = [0, 0], unitUm = 1): Coords => ({ ox: origin[0], oy: origin[1], k: 1 / unitUm, ax: 0, ay: 0 });
const cx = (e: Coords, x: number) => String(Math.round((x - e.ox) * e.k) - e.ax || 0);
const cy = (e: Coords, y: number) => String(Math.round((y - e.oy) * e.k) - e.ay || 0);
/** `e` anchored at the lower-left corner of `b` as written, so every coordinate inside is ≥ 0 and short. */
const anchorAt = (e: Coords, b: Bounds): Coords => ({ ...e, ax: Math.floor((b.minX - e.ox) * e.k), ay: Math.floor((b.minY - e.oy) * e.k) });

/**
 * `m`, then `l` / `c` per segment. `fill`: the ring is closed by `h`, so a
 * last line back onto the start point (as written) is left out — the same
 * edge, one point fewer.
 */
function segmentsOps(segs: Segment[], e: Coords, out: string[], fill = false): void {
  if (segs.length === 0) return;
  const start = `${cx(e, segs[0].x0)} ${cy(e, segs[0].y0)}`;
  out.push(`${start} m`);
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.kind === "line") {
      const p = `${cx(e, s.x1)} ${cy(e, s.y1)}`;
      if (!(fill && i === segs.length - 1 && i > 0 && p === start)) out.push(`${p} l`);
    } else {
      out.push(`${cx(e, s.cx0)} ${cy(e, s.cy0)} ${cx(e, s.cx1)} ${cy(e, s.cy1)} ${cx(e, s.x1)} ${cy(e, s.y1)} c`);
    }
  }
}

/**
 * Safety margin round the printed frame, stream µm: anything within it of
 * the frame is kept, so rounding at the clip edge never decides.
 */
export const CULL_MARGIN_UM = 100;

const segmentBounds = (s: Segment): Bounds =>
  s.kind === "line"
    ? { minX: Math.min(s.x0, s.x1), minY: Math.min(s.y0, s.y1), maxX: Math.max(s.x0, s.x1), maxY: Math.max(s.y0, s.y1) }
    : {
        minX: Math.min(s.x0, s.cx0, s.cx1, s.x1),
        minY: Math.min(s.y0, s.cy0, s.cy1, s.y1),
        maxX: Math.max(s.x0, s.cx0, s.cx1, s.x1),
        maxY: Math.max(s.y0, s.cy0, s.cy1, s.y1),
      };

/** `b` grown by `pad` meets the frame `cull` (unset: always). Control-point bounds contain the curve, so a miss is a miss. */
const meets = (b: Bounds, cull: Bounds | undefined, pad = 0): boolean =>
  !cull || (b.maxX + pad >= cull.minX && b.minX - pad <= cull.maxX && b.maxY + pad >= cull.minY && b.minY - pad <= cull.maxY);

const segmentsBounds = (segs: Segment[]): Bounds => segs.reduce<Bounds | undefined>((b, s) => unionBounds(b, segmentBounds(s)), undefined)!;

/**
 * The runs of consecutive kept segments of one ring. A closed ring's last
 * run joins its first when both reach the start vertex, so the join there
 * stays a join.
 */
function keptRuns(segs: Segment[], keep: boolean[], closed: boolean): Segment[][] {
  const runs: Segment[][] = [];
  let cur: Segment[] | undefined;
  segs.forEach((s, i) => {
    if (!keep[i]) cur = undefined;
    else if (cur) cur.push(s);
    else runs.push((cur = [s]));
  });
  if (closed && runs.length > 1 && keep[0] && keep[segs.length - 1]) {
    const first = runs.shift()!;
    runs[runs.length - 1].push(...first);
  }
  return runs;
}

/** Bounds of the rings of `path` that meet `cull` (the whole path's when all do). */
function fillBounds(path: RenderPath, cull: Bounds): Bounds {
  let all = true;
  let b: Bounds | undefined;
  for (const ring of pathRings(path)) {
    const segs = ringSegments(path, ring, false);
    if (segs.length === 0) continue;
    const rb = segmentsBounds(segs);
    if (meets(rb, cull)) b = unionBounds(b, rb);
    else all = false;
  }
  return all || !b ? pathBounds(path) : b;
}

/**
 * An open-stroke path cut to the segment runs that can paint inside `cull`
 * (each segment grown by `pad`); `undefined` when every segment stays — the
 * path is then written as it is. Closed rings lose their `h` once cut.
 */
function strokeRuns(path: RenderPath, cull: Bounds, pad: number): { runs: Segment[][]; bounds: Bounds } | undefined {
  const runs: Segment[][] = [];
  let dropped = false;
  for (const ring of pathRings(path)) {
    const segs = ringSegments(path, ring, path.closed);
    if (segs.length === 0) continue;
    const keep = segs.map((s) => meets(segmentBounds(s), cull, pad));
    if (keep.some((k) => !k)) dropped = true;
    runs.push(...keptRuns(segs, keep, path.closed));
  }
  if (!dropped) return undefined;
  return { runs, bounds: runs.length ? segmentsBounds(runs.flat()) : { minX: 0, minY: 0, maxX: 0, maxY: 0 } };
}

function pathOps(path: RenderPath, e: Coords, forceClosed: boolean, cull?: Bounds): string {
  const closed = path.closed || forceClosed;
  const out: string[] = [];
  for (const ring of pathRings(path)) {
    const segs = ringSegments(path, ring, false);
    // Even-odd: a ring that covers no point of the frame leaves the parity inside it unchanged.
    if (cull && segs.length > 0 && !meets(segmentsBounds(segs), cull)) continue;
    if (segs.length === 0) continue;
    segmentsOps(segs, e, out, forceClosed);
    if (closed) out.push("h");
  }
  return out.join(" ");
}

/**
 * Path construction operators for every ring of a path; `h` closes each
 * ring when closed. `forceClosed` = a fill or clip region: every ring
 * closed, its closing line left to `h`.
 */
export function pathOperators(path: RenderPath, origin: [number, number] = [0, 0], forceClosed = false, unitUm = 1): string {
  return pathOps(path, coords(origin, unitUm), forceClosed);
}

/** Bounding box of a glyph part in glyph-local µm, strokes and mitres included. */
export function glyphFormBBox(mesh: GlyphMesh): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (p: RenderPath, pad: number) => {
    if (p.coords.length === 0) return;
    const b = pathBounds(p);
    minX = Math.min(minX, b.minX - pad);
    minY = Math.min(minY, b.minY - pad);
    maxX = Math.max(maxX, b.maxX + pad);
    maxY = Math.max(maxY, b.maxY + pad);
  };
  for (const f of mesh.fills) add(f, 0);
  for (const s of mesh.strokes) add(s.path, (s.widthUm / 2) * STROKE_MITRE_LIMIT);
  if (minX === Infinity) return [0, 0, 0, 0];
  return [Math.floor(minX), Math.floor(minY), Math.ceil(maxX), Math.ceil(maxY)];
}

/** Content of a glyph part's form XObject: fills `f*`, strokes `w J j … S`; no colour (set by the pass). */
export function glyphFormContent(mesh: GlyphMesh): string {
  const out: string[] = [];
  if (mesh.fills.length) out.push(`${mesh.fills.map((f) => pathOperators(f, [0, 0], true)).join(" ")} f*`);
  for (const s of mesh.strokes) {
    out.push(`${um(s.widthUm)} w ${CAP[s.cap]} J ${JOIN[s.join]} j ${pathOperators(s.path)} S`);
  }
  return out.join("\n");
}

/**
 * Relative glyph placements per chain before it is re-anchored with an absolute
 * one: a reader that concatenates in single precision then drifts by at
 * most ~0.1 µm on an A3 page at 2400 dpi.
 */
export const CHAIN_LENGTH = 32;
/** A turn (and scale) used by this many instances of a pass gets its own form XObject. */
export const GLYPH_FORM_REUSE = 16;

/** A glyph form's `/Matrix` for a linear part (cos·scale, sin·scale) in a layer unit: 9 decimals, like the layer `cm`. */
function formMatrix(c: number, s: number, unit: number): Matrix {
  const r = (v: number) => Number(num(v / unit, 9));
  return [r(c), r(s), r(-s), r(c), 0, 0];
}

/**
 * A glyph pass's instances (x, y, cos, sin, scale per instance), in stream
 * order. Instances whose turn and scale is shared by `GLYPH_FORM_REUSE` or
 * more of the pass (pattern cells, unrotated point symbols) draw the form
 * that carries it as `/Matrix`, each placed by an integer translation
 * relative to the one before (`cm` concatenates; the form's own drawing is
 * bracketed by `Do`); the rest draw the plain form under a full `cm`.
 */
function glyphInstances(inst: ArrayLike<number>, mesh: GlyphMesh, unit: number, e: Coords, res: OperatorResources, out: string[], keep: (i: number) => boolean = () => true): void {
  const key = (i: number) => {
    const c = inst[i + 2] * inst[i + 4], s = inst[i + 3] * inst[i + 4];
    return `${num(c, 6)} ${num(s, 6)}`;
  };
  const uses = new Map<string, number>();
  for (let i = 0; i < inst.length; i += 5) uses.set(key(i), (uses.get(key(i)) ?? 0) + 1);
  const forms = new Map<string, string>();
  const form = (k: string, c: number, s: number) => {
    let name = forms.get(k);
    if (name === undefined) forms.set(k, (name = res.glyph(mesh, formMatrix(c, s, unit))));
    return name;
  };
  let chain: { name: string; x: number; y: number; n: number } | undefined;
  // Closes the open chain; a chain of one instance stays on one line.
  const close = () => {
    if (!chain) return;
    if (chain.n === 1) out[out.length - 1] += " Q";
    else out.push("Q");
    chain = undefined;
  };
  for (let i = 0; i < inst.length; i += 5) {
    if (!keep(i)) continue;
    const x = Math.round((inst[i] - e.ox) * e.k), y = Math.round((inst[i + 1] - e.oy) * e.k);
    const c = inst[i + 2] * inst[i + 4], s = inst[i + 3] * inst[i + 4];
    const k = key(i);
    if (k === "1 0" || uses.get(k)! >= GLYPH_FORM_REUSE) {
      const name = k === "1 0" ? form(k, 1, 0) : form(k, c, s);
      if (chain && chain.name === name && chain.n < CHAIN_LENGTH) {
        out.push(`1 0 0 1 ${x - chain.x} ${y - chain.y} cm /${name} Do`);
        chain.x = x;
        chain.y = y;
        chain.n++;
      } else {
        close();
        out.push(`q 1 0 0 1 ${x} ${y} cm /${name} Do`);
        chain = { name, x, y, n: 1 };
      }
    } else {
      close();
      out.push(`q ${cmOperator([c, s, -s, c, x, y])} /${form("1 0", 1, 0)} Do Q`);
    }
  }
  close();
}

/**
 * Margin of the filter-mask frame round everything the stream draws, µm:
 * a masked pass is clipped to "this frame minus the region", so the frame
 * only has to contain the pass (control-point bounds plus widths).
 */
export const FILTER_FRAME_MARGIN_UM = 10_000;

/** A filter-mask clip path: the frame rectangle with the region's rings as holes (read even-odd). */
export function filterClipPath(frame: Bounds, region: RenderPath): RenderPath {
  const { minX, minY, maxX, maxY } = frame;
  const coords = new Int32Array(8 + region.coords.length);
  coords.set([minX, minY, maxX, minY, maxX, maxY, minX, maxY].map(Math.round));
  coords.set(region.coords, 8);
  const flags = new Uint8Array(4 + region.flags.length);
  flags.set(region.flags, 4);
  flags[4] |= COORD_FLAG.hole;
  return { coords, flags, closed: true };
}

/** Graphics-state values the emitter tracks to skip redundant operators; mirrors `q` / `Q`. */
interface GState {
  fill?: string;
  stroke?: string;
  w?: string;
  J?: number;
  j?: number;
  Tr?: number;
}

/**
 * Operators for a whole stream, in its (canonical, colour-sorted) order.
 * No `cm` and no outer `q`: `mapLayerOperators` wraps it.
 */
export function passStreamOperators(stream: PassStream, opts: OperatorOptions): string {
  const unit = opts.unitUm ?? 1;
  const e = coords(opts.originUm, unit);
  const path = (p: RenderPath, forceClosed = false) => pathOps(p, e, forceClosed);
  const cull = opts.cull && { minX: opts.cull.minX - CULL_MARGIN_UM, minY: opts.cull.minY - CULL_MARGIN_UM, maxX: opts.cull.maxX + CULL_MARGIN_UM, maxY: opts.cull.maxY + CULL_MARGIN_UM };
  const out: string[] = [];
  let gs: GState = {};
  const stack: GState[] = [];
  const save = () => {
    out.push("q");
    stack.push({ ...gs });
  };
  const restore = () => {
    out.push("Q");
    gs = stack.pop() ?? {};
  };
  const colourCache = new Map<number, PdfColour>();
  const colourOf = (idx: number): PdfColour => {
    let c = colourCache.get(idx);
    if (!c) {
      const entry = opts.colours[idx];
      if (!entry) throw new Error(`pass colour ${idx} is not in the colour stack`);
      c = stackColour(entry, opts.mode);
      colourCache.set(idx, c);
    }
    return c;
  };
  const fill = (idx: number) => {
    const op = colourOperator(colourOf(idx), "fill");
    if (gs.fill !== op) out.push((gs.fill = op));
  };
  const strokeColour = (idx: number) => {
    const op = colourOperator(colourOf(idx), "stroke");
    if (gs.stroke !== op) out.push((gs.stroke = op));
  };
  const lineStyle = (widthUm: number, cap: number, join: number) => {
    const w = num(widthUm / unit, 3);
    const parts: string[] = [];
    if (gs.w !== w) parts.push(`${(gs.w = w)} w`);
    if (gs.J !== cap) parts.push(`${(gs.J = cap)} J`);
    if (gs.j !== join) parts.push(`${(gs.j = join)} j`);
    if (parts.length) out.push(parts.join(" "));
  };
  // One path object under its anchor: `q 1 0 0 1 ax ay cm … Q` (colour and line style set before, inherited).
  const anchored = (a: Coords, ops: string) => (a.ax === 0 && a.ay === 0 ? ops : `q 1 0 0 1 ${a.ax} ${a.ay} cm ${ops} Q`);
  const fonts = new Map<number, FontRef>();
  for (const f of stream.fontTable) fonts.set(f.fontId, f);
  const meshes = new Map<string, GlyphMesh>();
  for (const m of stream.glyphTable) meshes.set(`${m.glyphId}/${m.partIdx}`, m);

  const emit = (p: Pass) => {
    switch (p.kind) {
      case "fill": {
        const a = anchorAt(e, cull ? fillBounds(p.path, cull) : pathBounds(p.path));
        const body = pathOps(p.path, a, true, cull);
        if (!body) break;
        fill(p.colour);
        out.push(anchored(a, `${body} f*`));
        break;
      }
      case "stroke": {
        if (p.cap === "pointed" && ((p.taper?.startUm ?? 0) > 0 || (p.taper?.endUm ?? 0) > 0)) {
          const outline = strokeOutline(p.path, { widthUm: p.widthUm, join: p.join, taper: p.taper, slices: p.slices });
          if (outline.coords.length === 0 || !meets(pathBounds(outline), cull)) break;
          const a = anchorAt(e, pathBounds(outline));
          fill(p.colour);
          out.push(anchored(a, `${pathOps(outline, a, true)} f`));
          break;
        }
        // A stroke paints up to a mitre length of half the width beyond its geometry.
        const pad = (p.widthUm / 2) * STROKE_MITRE_LIMIT;
        // Slices lie inside the path's control hull: its corner anchors them too.
        let a = anchorAt(e, pathBounds(p.path));
        let body: string;
        if (p.slices) {
          const keptSegs: Segment[][] = [];
          for (const sl of p.slices) {
            const segs = sliceSegments(p.path, sl);
            if (cull && (segs.length === 0 || !meets(segmentsBounds(segs), cull, pad))) continue;
            keptSegs.push(segs);
          }
          if (keptSegs.length === 0) break;
          // Dropped slices: anchor at what is left, so the numbers stay short.
          if (cull && keptSegs.length < p.slices.length) a = anchorAt(e, segmentsBounds(keptSegs.flat()));
          const parts: string[] = [];
          for (const segs of keptSegs) segmentsOps(segs, a, parts);
          if (parts.length === 0) break;
          body = parts.join(" ");
        } else {
          const cut = cull ? strokeRuns(p.path, cull, pad) : undefined;
          if (cut) {
            if (cut.runs.length === 0) break;
            a = anchorAt(e, cut.bounds);
            const parts: string[] = [];
            for (const run of cut.runs) segmentsOps(run, a, parts);
            body = parts.join(" ");
          } else {
            body = pathOps(p.path, a, false);
            if (!body) break;
          }
        }
        strokeColour(p.colour);
        lineStyle(p.widthUm, CAP[p.cap], JOIN[p.join]);
        out.push(anchored(a, `${body} S`));
        break;
      }
      case "glyph": {
        const mesh = meshes.get(`${p.glyphId}/${p.partIdx}`);
        if (!mesh || p.instances.length === 0) break;
        let keep: ((i: number) => boolean) | undefined;
        if (cull) {
          const [x0, y0, x1, y1] = glyphFormBBox(mesh);
          // The form's farthest corner from its origin: a turn cannot take it farther.
          const reach = Math.hypot(Math.max(Math.abs(x0), Math.abs(x1)), Math.max(Math.abs(y0), Math.abs(y1)));
          const inst = p.instances;
          keep = (i) => {
            const r = reach * inst[i + 4];
            return meets({ minX: inst[i], minY: inst[i + 1], maxX: inst[i], maxY: inst[i + 1] }, cull, r);
          };
          let any = false;
          for (let i = 0; i < inst.length && !any; i += 5) any = keep(i);
          if (!any) break;
        }
        // A form XObject inherits the colours: set both, whichever its content paints.
        if (mesh.fills.length) fill(p.colour);
        if (mesh.strokes.length) strokeColour(p.colour);
        const clipped = p.clip !== undefined;
        if (clipped) {
          save();
          out.push(`${path(p.clip!, true)} W* n`);
        }
        glyphInstances(p.instances, mesh, unit, e, opts.resources, out, keep);
        if (clipped) restore();
        break;
      }
      case "hatch": {
        const lines = hatchLines(pathBounds(p.path), { spacingUm: p.spacingUm, offsetUm: p.offsetUm, angleDeg: p.angleDeg });
        if (lines.length === 0) break;
        strokeColour(p.colour);
        save();
        out.push(`${path(p.path, true)} W* n`);
        lineStyle(p.widthUm, 0, 0);
        out.push(`${lines.map((l) => `${cx(e, l.x0)} ${cy(e, l.y0)} m ${cx(e, l.x1)} ${cy(e, l.y1)} l`).join(" ")} S`);
        restore();
        break;
      }
      case "text": {
        if (p.glyphs.length === 0) break;
        const ref = fonts.get(p.fontId);
        if (!ref) break;
        const halo = (p.haloWidthUm ?? 0) > 0;
        const name = opts.resources.font(ref, p.glyphs);
        if (halo) {
          strokeColour(p.colour);
          lineStyle(2 * p.haloWidthUm!, 1, 1);
        } else fill(p.colour);
        const angle = (i: number) => ((p.angles ? p.angles[i] : 0) * Math.PI) / 180;
        const x = (i: number) => Math.round((p.positions[2 * i] - e.ox) * e.k);
        const y = (i: number) => Math.round((p.positions[2 * i + 1] - e.oy) * e.k);
        if (name !== undefined) {
          const tr = halo ? 1 : 0;
          const parts = ["BT", `/${name} ${num(p.sizeUm / unit, 3)} Tf`];
          if (gs.Tr !== tr) parts.push(`${(gs.Tr = tr)} Tr`);
          out.push(parts.join(" "));
          for (let i = 0; i < p.glyphs.length; i++) {
            const a = angle(i), c = Math.cos(a), s = Math.sin(a);
            out.push(`${[c, s, -s, c].map((v) => num(v, 6)).join(" ")} ${x(i)} ${y(i)} Tm ${glyphHex([p.glyphs[i]])} Tj`);
          }
          out.push("ET");
        } else {
          // Fallback: the outlines the reference raster draws, even-odd like it.
          for (let i = 0; i < p.glyphs.length; i++) {
            const o = opts.resources.glyphOutline?.(ref, p.glyphs[i]);
            if (!o) continue;
            const k = p.sizeUm / o.unitsPerEm;
            const a = angle(i), c = (Math.cos(a) * k) / unit, s = (Math.sin(a) * k) / unit;
            const body = pathOperators(o.path, [0, 0], true);
            if (halo) {
              out.push(`q ${cmOperator([c, s, -s, c, x(i), y(i)])} ${num((2 * p.haloWidthUm!) / k, 3)} w 1 J 1 j ${body} S Q`);
            } else {
              out.push(`q ${cmOperator([c, s, -s, c, x(i), y(i)])} ${body} f* Q`);
            }
          }
        }
        break;
      }
    }
  };
  // Filter masks (§3.8, 05 §5.3): a run of passes under one mask is drawn inside
  // `q <frame + region> W* n …` per region, closed by `Q` before the next mask or an unmasked pass.
  let frame: Bounds | undefined;
  if (stream.masks?.length) {
    let b = passStreamBounds(stream);
    for (const m of stream.masks) for (const r of m.regions) b = unionBounds(b, pathBounds(r));
    const g = FILTER_FRAME_MARGIN_UM;
    frame = b && { minX: b.minX - g, minY: b.minY - g, maxX: b.maxX + g, maxY: b.maxY + g };
  }
  let open = -1;
  stream.passes.forEach((p, i) => {
    const m = stream.maskIdx?.[i] ?? -1;
    if (m !== open) {
      if (open >= 0) restore();
      if (m >= 0) {
        save();
        for (const r of stream.masks![m].regions) out.push(`${path(filterClipPath(frame!, r), true)} W* n`);
      }
      open = m;
    }
    emit(p);
  });
  if (open >= 0) restore();
  return out.join("\n");
}

/** Clip to a region for the operators that follow until the matching `Q` (filter regions, 05 §5.3). */
export function clipOperators(path: RenderPath, rule: "nonzero" | "evenodd", origin: [number, number] = [0, 0], unitUm = 1): string {
  return `${pathOperators(path, origin, true, unitUm)} ${rule === "evenodd" ? "W*" : "W"} n`;
}

/**
 * The printed frame (page points) as bounds in the stream's own coordinates:
 * the axis-aligned box of its four corners taken back through `matrix`
 * (stream µm relative to `originUm` → points), so a turned map is culled
 * by a box that contains its frame.
 */
export function frameInStream(frame: { x: number; y: number; width: number; height: number }, matrix: Matrix, originUm: [number, number]): Bounds {
  const [a, b, c, d, tx, ty] = matrix;
  const det = a * d - b * c;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [px, py] of [[frame.x, frame.y], [frame.x + frame.width, frame.y], [frame.x + frame.width, frame.y + frame.height], [frame.x, frame.y + frame.height]]) {
    const dx = px - tx, dy = py - ty;
    const x = (d * dx - c * dy) / det + originUm[0], y = (-b * dx + a * dy) / det + originUm[1];
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

/**
 * The map layer: `q <matrix> cm 4 M <passes> Q`. `matrix` maps paper µm
 * relative to `originUm` to page points (window, print scale, rotation
 * folded in — research 05 §5.2; the page composer computes it); `frame`
 * (page points) is the clip the layer is drawn under, which culls what
 * cannot paint inside it. The
 * passes are written in `unitUm` (default `layerUnitUm(matrix)`) relative
 * to the origin moved onto that unit's grid; the written `cm` folds both
 * in, so the page is the same.
 */
export function mapLayerOperators(stream: PassStream, opts: Omit<OperatorOptions, "cull"> & { matrix: Matrix; frame?: { x: number; y: number; width: number; height: number } }): string {
  const unit = opts.unitUm ?? layerUnitUm(opts.matrix);
  const [ox, oy] = opts.originUm ?? [0, 0];
  // The origin on OCAD's 10 µm grid (a whole number of units when the unit divides it), so grid coordinates stay exact.
  const grid = Number.isInteger(Math.round((PRINT_GRID_UM / unit) * 1e9) / 1e9) ? PRINT_GRID_UM : unit;
  const sx = Math.round(ox / grid) * grid, sy = Math.round(oy / grid) * grid;
  const [a, b, c, d, tx, ty] = opts.matrix;
  const dx = sx - ox, dy = sy - oy;
  const m: Matrix = [a * unit, b * unit, c * unit, d * unit, tx + a * dx + c * dy, ty + b * dx + d * dy];
  return [
    "q",
    cmOperator(m, 9),
    `${STROKE_MITRE_LIMIT} M`,
    passStreamOperators(stream, { ...opts, originUm: [sx, sy], unitUm: unit, ...(opts.frame ? { cull: frameInStream(opts.frame, opts.matrix, [ox, oy]) } : {}) }),
    "Q",
  ].join("\n");
}

/** Page-layer number: millimetres with 3 decimals (1 µm, research 05 §5.2). */
export function fmtMm(v: number): string {
  return num(v, 3);
}
