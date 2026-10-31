/**
 * Pass stream — the contract between the shared symbolisation stage and
 * every rendering backend (WebGL2, PDF, reference raster).
 *
 * Normative description: docs/map-rendering.md §2–§3. Research record:
 * docs/research/vector-map-pipeline/04-render-core.md §4.2.
 *
 * Everything in a pass is measurable on paper: lengths are integer
 * micrometres at the document's reference scale, geometry keeps its Bézier
 * segments, dashes are (segment, t) slices. Nothing here depends on pixels.
 */

/** Per-coordinate flag bits, identical to the document format (02 §3). */
export const COORD_FLAG = {
  /** First control point of a cubic Bézier segment. */
  bezierFirst: 1,
  /** Second control point of a cubic Bézier segment. */
  bezierSecond: 2,
  /** Corner point: dash/glyph layout restarts here. */
  corner: 4,
  /** Dash point: a dash is centred here and layout restarts. */
  dash: 8,
  /** First point of a hole ring (area objects). */
  hole: 16,
  /** No left border line from this point (line symbols with borders). */
  noLeft: 32,
  /** No right border line from this point. */
  noRight: 64,
  /** Gap point: the main line is interrupted from here to the next gap point. */
  gap: 128,
} as const;

/**
 * A path in paper micrometres, y-up. `coords` holds x,y pairs; `flags[i]`
 * belongs to point `i`. A cubic segment is encoded as anchor, control
 * (flag 1), control (flag 2), anchor — the OCAD/OMAP convention, kept so
 * the PDF backend can emit the curve as authored.
 */
export interface RenderPath {
  coords: Int32Array;
  flags: Uint8Array;
  closed: boolean;
}

/** A sub-range of a path in (segment index, parameter) space. */
export interface Slice {
  seg0: number;
  t0: number;
  seg1: number;
  t1: number;
}

export type StrokeCap = "butt" | "round" | "square" | "pointed";
export type StrokeJoin = "miter" | "round" | "bevel";

export interface FillPass {
  kind: "fill";
  /** Index into the document's colour stack. */
  colour: number;
  path: RenderPath;
  /**
   * Even-odd, always: OCAD and OMAP hole rings carry no winding
   * guarantee, so the rule is the only way holes come out as holes. Kept
   * as a field so a backend cannot silently pick its own default.
   */
  rule: "evenodd";
}

export interface StrokePass {
  kind: "stroke";
  colour: number;
  path: RenderPath;
  /** Dash layout output. `undefined` means the whole path is drawn. */
  slices?: Slice[];
  widthUm: number;
  cap: StrokeCap;
  join: StrokeJoin;
  /** Linear width taper over the first / last `n` µm (pointed line ends). */
  taper?: { startUm?: number; endUm?: number };
}

export interface GlyphPass {
  kind: "glyph";
  colour: number;
  glyphId: number;
  /** Which colour part of the glyph this pass draws (one pass per part). */
  partIdx: number;
  /** `x, y, cos, sin, scale` per instance, x/y in paper µm. */
  instances: Float32Array;
  /** Only for pattern fills in clip mode: instances are clipped to this area. */
  clip?: RenderPath;
}

export interface HatchPass {
  kind: "hatch";
  colour: number;
  path: RenderPath;
  widthUm: number;
  spacingUm: number;
  offsetUm: number;
  angleDeg: number;
}

export interface TextPass {
  kind: "text";
  colour: number;
  fontId: number;
  /** Em size in µm (already derived from digit height where the symbol says so). */
  sizeUm: number;
  glyphs: Uint16Array;
  /** `x, y` per glyph (baseline origin), paper µm. */
  positions: Float32Array;
  /**
   * Rotation per glyph, degrees counter-clockwise, about the glyph's own
   * origin. Absent = every glyph upright (map-rendering §3.5).
   */
  angles?: Float32Array;
  /** Set only on a halo pass, which is a separate pass in the halo colour. */
  haloWidthUm?: number;
}

export type Pass = FillPass | StrokePass | GlyphPass | HatchPass | TextPass;
export type PassKind = Pass["kind"];

/**
 * Backend-independent draw order of kinds within one colour. Fills under
 * hatches under strokes under glyphs under text — the order OCAD and
 * Mapper use within a colour when symbols of different types share it.
 */
export const PASS_KIND_ORDER: Record<PassKind, number> = {
  fill: 0,
  hatch: 1,
  stroke: 2,
  glyph: 3,
  text: 4,
};

/** One colour part of a point/line/pattern glyph, geometry in glyph-local µm. */
export interface GlyphMesh {
  glyphId: number;
  partIdx: number;
  fills: RenderPath[];
  strokes: { path: RenderPath; widthUm: number; cap: StrokeCap; join: StrokeJoin }[];
}

export type FontFamily =
  | "liberation-sans"
  | "liberation-sans-narrow"
  | "liberation-serif"
  | "liberation-mono";

export interface FontRef {
  fontId: number;
  family: FontFamily;
  bold: boolean;
  italic: boolean;
}

/**
 * A filter mask (docs/map-rendering.md §3.8, §4.11): a masked pass is
 * drawn only **outside every region** — each region read even-odd, so a
 * hole ring of a region is outside it. The outer frame of that "outside"
 * is the backend's (image frame, PDF window); the stream has none.
 */
export interface FilterMask {
  /** Closed region paths, paper µm; holes are rings starting at a `hole` point. */
  regions: RenderPath[];
}

export interface PassStream {
  /** Per pass → owning object index (hit-testing, per-object hide). */
  objectIdx: Uint32Array;
  /** Per pass → source symbol index (filter regions by symbol). */
  symbolIdx: Uint32Array;
  /** Sorted by (colour, kind, symbol); see `sortPassStream`. */
  passes: Pass[];
  glyphTable: GlyphMesh[];
  fontTable: FontRef[];
  /** Filter masks (clip-mode filter regions, §4.11); absent = none. */
  masks?: FilterMask[];
  /** Per pass → index into `masks`, −1 = unmasked. Absent = no pass is masked. */
  maskIdx?: Int32Array;
}

/**
 * Sort key of a pass: colour-major (the painter's order of the colour
 * stack), then kind, then symbol so a symbol subset of a colour is a few
 * contiguous index ranges. Insertion order breaks remaining ties, which
 * keeps the result stable for identical inputs.
 */
export function comparePassOrder(
  a: { colour: number; kind: PassKind; symbolIdx: number },
  b: { colour: number; kind: PassKind; symbolIdx: number },
): number {
  if (a.colour !== b.colour) return a.colour - b.colour;
  if (a.kind !== b.kind) return PASS_KIND_ORDER[a.kind] - PASS_KIND_ORDER[b.kind];
  return a.symbolIdx - b.symbolIdx;
}

/** Returns a new stream with passes (and their index arrays) in canonical order. */
export function sortPassStream(stream: PassStream): PassStream {
  const n = stream.passes.length;
  const order = Array.from({ length: n }, (_, i) => i);
  order.sort((i, j) => {
    const c = comparePassOrder(
      { colour: stream.passes[i].colour, kind: stream.passes[i].kind, symbolIdx: stream.symbolIdx[i] },
      { colour: stream.passes[j].colour, kind: stream.passes[j].kind, symbolIdx: stream.symbolIdx[j] },
    );
    return c !== 0 ? c : i - j;
  });
  const objectIdx = new Uint32Array(n);
  const symbolIdx = new Uint32Array(n);
  const passes = new Array<Pass>(n);
  const maskIdx = stream.maskIdx ? new Int32Array(n) : undefined;
  order.forEach((src, dst) => {
    objectIdx[dst] = stream.objectIdx[src];
    symbolIdx[dst] = stream.symbolIdx[src];
    passes[dst] = stream.passes[src];
    if (maskIdx) maskIdx[dst] = stream.maskIdx![src];
  });
  return { ...stream, objectIdx, symbolIdx, passes, ...(maskIdx ? { maskIdx } : {}) };
}

/** Incremental construction of a stream; `build()` sorts canonically. */
export class PassStreamBuilder {
  private readonly passes: Pass[] = [];
  private readonly objects: number[] = [];
  private readonly symbols: number[] = [];
  readonly glyphTable: GlyphMesh[] = [];
  readonly fontTable: FontRef[] = [];

  push(pass: Pass, objectIdx: number, symbolIdx: number): this {
    this.passes.push(pass);
    this.objects.push(objectIdx);
    this.symbols.push(symbolIdx);
    return this;
  }

  get length(): number {
    return this.passes.length;
  }

  build(): PassStream {
    return sortPassStream({
      objectIdx: Uint32Array.from(this.objects),
      symbolIdx: Uint32Array.from(this.symbols),
      passes: this.passes.slice(),
      glyphTable: this.glyphTable.slice(),
      fontTable: this.fontTable.slice(),
    });
  }
}

/** Build a `RenderPath` from plain numbers; flags default to 0. */
export function makePath(
  coords: ArrayLike<number>,
  flags?: ArrayLike<number>,
  closed = false,
): RenderPath {
  if (coords.length % 2 !== 0) throw new Error("coords must be x,y pairs");
  const n = coords.length / 2;
  const f = new Uint8Array(n);
  if (flags) {
    if (flags.length !== n) throw new Error("flags length must equal point count");
    f.set(flags);
  }
  return { coords: Int32Array.from(coords), flags: f, closed };
}
