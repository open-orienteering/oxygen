/**
 * Pass stream → PDF content-stream operators, one pass at a time and in
 * stream order (docs/map-rendering.md §5.3, research 05 §5.2–5.3). Every
 * decision is the stage's; this layer only encodes:
 *
 * - coordinates as integer µm relative to an origin, under one `cm` the
 *   caller supplies (paper µm → page points, `mapLayerOperators`);
 * - fills `m / l / c … h f*` (even-odd, map-rendering §3.1), Béziers kept;
 * - strokes `w J j … S`; dash slices as one subpath each (never `d`);
 *   `pointed` + `taper` as the shared `strokeOutline()` filled `f`;
 * - glyph parts as form XObjects drawn `q cm /Gn Do Q` per instance, a
 *   clip-mode pattern inside `q <area> W* n … Q`;
 * - hatches as explicit `hatchLines()` inside the area's clip;
 * - text `BT /Fn size Tf … Tm <gid> Tj ET`, a halo pass with `1 Tr`
 *   at `2 × haloWidthUm`; without an embedded font, the glyph outlines.
 *
 * Writer-independent: resources are names handed out by `OperatorResources`.
 */

import type { FontRef, GlyphMesh, Pass, PassStream, RenderPath, StrokeCap, StrokeJoin } from "../render/pass-stream.js";
import { type Segment, hatchLines, pathBounds, pathRings, ringSegments, sliceSegments } from "../render/path.js";
import { STROKE_MITRE_LIMIT, strokeOutline } from "../render/geometry.js";
import type { GlyphOutline } from "../render/reference-svg.js";
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
  /** Form XObject resource name for one glyph part (without the slash). */
  glyph(mesh: GlyphMesh): string;
}

export interface OperatorOptions {
  /** The document's colour stack: pass colour index → entry with CMYK. */
  colours: Pick<ColourStack[number], "cmyk">[];
  mode: ColourMode;
  resources: OperatorResources;
  /** Paper µm subtracted from every coordinate so integers stay small (the window origin). */
  originUm?: [number, number];
}

/** A PDF number: fixed-point (never JS exponent notation, ISO 32000 §7.3.3), trailing zeros dropped. */
const num = (v: number, decimals: number): string => {
  let t = v.toFixed(decimals);
  if (t.includes(".")) t = t.replace(/0+$/, "").replace(/\.$/, "");
  return t === "-0" ? "0" : t;
};
/** Integer µm. */
const um = (v: number) => num(v, 0);

/**
 * The `cm` operator. 6 decimals suit instance matrices (cos·scale); the
 * map layer's µm → pt factors (~3e-3) take 9, or a 1 m window would be
 * off by a quarter millimetre.
 */
export function cmOperator(m: Matrix, decimals = 6): string {
  return `${m.map((v) => num(v, decimals)).join(" ")} cm`;
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

function segmentsOps(segs: Segment[], ox: number, oy: number, out: string[]): void {
  if (segs.length === 0) return;
  out.push(`${um(segs[0].x0 - ox)} ${um(segs[0].y0 - oy)} m`);
  for (const s of segs) {
    out.push(
      s.kind === "line"
        ? `${um(s.x1 - ox)} ${um(s.y1 - oy)} l`
        : `${um(s.cx0 - ox)} ${um(s.cy0 - oy)} ${um(s.cx1 - ox)} ${um(s.cy1 - oy)} ${um(s.x1 - ox)} ${um(s.y1 - oy)} c`,
    );
  }
}

/** Path construction operators for every ring of a path; `h` closes each ring when closed. */
export function pathOperators(path: RenderPath, origin: [number, number] = [0, 0], forceClosed = false): string {
  const closed = path.closed || forceClosed;
  const out: string[] = [];
  for (const ring of pathRings(path)) {
    const segs = ringSegments(path, ring, false);
    if (segs.length === 0) continue;
    segmentsOps(segs, origin[0], origin[1], out);
    if (closed) out.push("h");
  }
  return out.join(" ");
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
  const [ox, oy] = opts.originUm ?? [0, 0];
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
    const w = um(widthUm);
    const parts: string[] = [];
    if (gs.w !== w) parts.push(`${(gs.w = w)} w`);
    if (gs.J !== cap) parts.push(`${(gs.J = cap)} J`);
    if (gs.j !== join) parts.push(`${(gs.j = join)} j`);
    if (parts.length) out.push(parts.join(" "));
  };
  const fonts = new Map<number, FontRef>();
  for (const f of stream.fontTable) fonts.set(f.fontId, f);
  const meshes = new Map<string, GlyphMesh>();
  for (const m of stream.glyphTable) meshes.set(`${m.glyphId}/${m.partIdx}`, m);

  const emit = (p: Pass) => {
    switch (p.kind) {
      case "fill":
        fill(p.colour);
        out.push(`${pathOperators(p.path, [ox, oy], true)} f*`);
        break;
      case "stroke": {
        if (p.cap === "pointed" && ((p.taper?.startUm ?? 0) > 0 || (p.taper?.endUm ?? 0) > 0)) {
          const outline = strokeOutline(p.path, { widthUm: p.widthUm, join: p.join, taper: p.taper, slices: p.slices });
          if (outline.coords.length === 0) break;
          fill(p.colour);
          out.push(`${pathOperators(outline, [ox, oy], true)} f`);
          break;
        }
        let body: string;
        if (p.slices) {
          const parts: string[] = [];
          for (const sl of p.slices) segmentsOps(sliceSegments(p.path, sl), ox, oy, parts);
          if (parts.length === 0) break;
          body = parts.join(" ");
        } else {
          body = pathOperators(p.path, [ox, oy]);
          if (!body) break;
        }
        strokeColour(p.colour);
        lineStyle(p.widthUm, CAP[p.cap], JOIN[p.join]);
        out.push(`${body} S`);
        break;
      }
      case "glyph": {
        const mesh = meshes.get(`${p.glyphId}/${p.partIdx}`);
        if (!mesh || p.instances.length === 0) break;
        const name = opts.resources.glyph(mesh);
        // A form XObject inherits the colours: set both, whichever its content paints.
        if (mesh.fills.length) fill(p.colour);
        if (mesh.strokes.length) strokeColour(p.colour);
        const clipped = p.clip !== undefined;
        if (clipped) {
          save();
          out.push(`${pathOperators(p.clip!, [ox, oy], true)} W* n`);
        }
        const inst = p.instances;
        for (let i = 0; i < inst.length; i += 5) {
          const c = inst[i + 2], s = inst[i + 3], k = inst[i + 4];
          out.push(`q ${cmOperator([c * k, s * k, -s * k, c * k, Math.round(inst[i] - ox), Math.round(inst[i + 1] - oy)])} /${name} Do Q`);
        }
        if (clipped) restore();
        break;
      }
      case "hatch": {
        const lines = hatchLines(pathBounds(p.path), { spacingUm: p.spacingUm, offsetUm: p.offsetUm, angleDeg: p.angleDeg });
        if (lines.length === 0) break;
        strokeColour(p.colour);
        save();
        out.push(`${pathOperators(p.path, [ox, oy], true)} W* n`);
        lineStyle(p.widthUm, 0, 0);
        out.push(`${lines.map((l) => `${um(l.x0 - ox)} ${um(l.y0 - oy)} m ${um(l.x1 - ox)} ${um(l.y1 - oy)} l`).join(" ")} S`);
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
        const tm = (i: number): Matrix => {
          const a = p.angles ? (p.angles[i] * Math.PI) / 180 : 0;
          const c = Math.cos(a), s = Math.sin(a);
          return [c, s, -s, c, Math.round(p.positions[2 * i] - ox), Math.round(p.positions[2 * i + 1] - oy)];
        };
        if (name !== undefined) {
          const tr = halo ? 1 : 0;
          const parts = ["BT", `/${name} ${num(p.sizeUm, 3)} Tf`];
          if (gs.Tr !== tr) parts.push(`${(gs.Tr = tr)} Tr`);
          out.push(parts.join(" "));
          for (let i = 0; i < p.glyphs.length; i++) {
            out.push(`${tm(i).map((v) => num(v, 6)).join(" ")} Tm ${glyphHex([p.glyphs[i]])} Tj`);
          }
          out.push("ET");
        } else {
          // Fallback: the outlines the reference raster draws, even-odd like it.
          for (let i = 0; i < p.glyphs.length; i++) {
            const o = opts.resources.glyphOutline?.(ref, p.glyphs[i]);
            if (!o) continue;
            const k = p.sizeUm / o.unitsPerEm;
            const [c, s, , , x, y] = tm(i);
            const body = pathOperators(o.path, [0, 0], true);
            if (halo) {
              out.push(`q ${cmOperator([k * c, k * s, -k * s, k * c, x, y])} ${num((2 * p.haloWidthUm!) / k, 3)} w 1 J 1 j ${body} S Q`);
            } else {
              out.push(`q ${cmOperator([k * c, k * s, -k * s, k * c, x, y])} ${body} f* Q`);
            }
          }
        }
        break;
      }
    }
  };
  for (const p of stream.passes) emit(p);
  return out.join("\n");
}

/** Clip to a region for the operators that follow until the matching `Q` (filter regions, 05 §5.3). */
export function clipOperators(path: RenderPath, rule: "nonzero" | "evenodd", origin: [number, number] = [0, 0]): string {
  return `${pathOperators(path, origin, true)} ${rule === "evenodd" ? "W*" : "W"} n`;
}

/**
 * The map layer: `q <matrix> cm 4 M <passes> Q`. `matrix` maps paper µm
 * relative to `originUm` to page points (window, print scale, rotation
 * folded in — research 05 §5.2; the page composer computes it).
 */
export function mapLayerOperators(stream: PassStream, opts: OperatorOptions & { matrix: Matrix }): string {
  return ["q", cmOperator(opts.matrix, 9), `${STROKE_MITRE_LIMIT} M`, passStreamOperators(stream, opts), "Q"].join("\n");
}

/** Page-layer number: millimetres with 3 decimals (1 µm, research 05 §5.2). */
export function fmtMm(v: number): string {
  return num(v, 3);
}
