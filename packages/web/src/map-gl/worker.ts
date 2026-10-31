/**
 * WebGL2 backend, worker side (04 §4.5, §10 point 6): everything but the
 * GL calls. A map document's bytes go in; the worker decodes, bridges,
 * symbolises, builds the mesh atlas, resolves text against the text
 * atlas, assigns buckets and prepares the
 * always-resident layers (every cell's fills and hatches, the large
 * bucket) at once, then prepares cells' detail on request. Typed arrays
 * go back as transferables.
 *
 * This module is the pure message handler, so it is unit-tested without
 * a Worker and can run inline on the main thread (`engine.ts` `inlineTransport`);
 * `worker-entry.ts` binds it to `self`.
 *
 * Protocol (docs/map-rendering.md §5.2 "Worker"):
 *   → load     { source: document bytes | objects + symbols, fonts, text atlas pages }   ← loaded { summary, atlas, grid, base parts, large part }
 *   → prepare  { ids }   replaces the queue; ← part { part } per id, nearest first
 *   → course   { generation, input }   ← course { generation, part, colours, derivation, filter, … } (§5.2 "Dynamic bucket", "Filter regions")
 *   ← error    { message } (load failures; the queue stops)
 */

import { course, mapDocument, render } from "@oxygen/shared";
import { MeshAtlasBuilder, type AtlasMesh, type MeshAtlas } from "./mesh-atlas.js";
import { buildTextGlyphs, haloEm, textGlyphKey, type TextAtlasPage } from "./text-atlas.js";
import { triangulateEvenOdd } from "./prepare.js";
import {
  aboveZoomGate, assignBuckets, fitView, partTransferables, prepareBucketPart, PREFETCH_MARGIN_CELLS, visibleCells,
  type Assignment, type Grid, type PrepareContext, type PreparedPart, type TextPassGlyphs, type ViewRect,
} from "./buckets.js";

/** Flattening tolerance, paper µm (OCAD's own resolution). */
export const TOLERANCE_UM = 10;

export type LoadSource =
  | { kind: "document"; bytes: ArrayBuffer; options: mapDocument.DocumentRenderOptions }
  /** Dev-only S1 reader path: objects already converted on the main thread. */
  | { kind: "objects"; objects: render.RenderObject[]; symbols: render.RenderSymbol[] }
  /** Dev-only: an already symbolised stream (the golden scenes through the arena path, `MapGlFixturePage`). */
  | { kind: "stream"; stream: render.PassStream };

/** The view the caller will show first: given, or "fit the document into this canvas". */
export type FirstView = { kind: "view"; view: ViewRect } | { kind: "fit"; widthPx: number; heightPx: number; fill?: number };

export interface LoadRequest {
  type: "load";
  source: LoadSource;
  fonts: { family: render.FontFamily; bytes: ArrayBuffer }[];
  /**
   * The text atlas pages the renderer holds, in its page order (§5.2 "Text atlas"). Without them
   * text is not drawn (`TEXT_ATLAS_MISSING`).
   */
  textAtlas?: TextAtlasPage[];
  /**
   * With a first view the worker queues that view's detail (prefetch margin, nearest first) right
   * after the always-resident layers — no round trip — unless the view is below the zoom gate.
   */
  firstView?: FirstView;
  /** Apply the zoom gate to the first view (default true). */
  gate?: boolean;
  prefetchMarginCells?: number;
  toleranceUm?: number;
  cellUm?: number;
  largeCells?: number;
  /**
   * Prepare for a course layer (document source; §5.2 "Dynamic bucket"): the static buckets are
   * built on the course-completed stack (`course.courseColourStack`), the cut features are
   * extracted, and `course` requests are answered. Default false: the stack is the document's.
   */
  courseLayer?: boolean;
}

export interface PrepareRequest {
  type: "prepare";
  /** Bucket ids whose detail layer is wanted, most urgent first; replaces any queued request. */
  ids: number[];
}

/** What the viewer decides of a course layer; the worker adds the document context and cut features. */
export type CourseLayerRequest = Pick<course.CourseLayerInput, "structure" | "sites" | "objects" | "appearance" | "viewOptions" | "regions"> & {
  /**
   * A filter region is being dragged: `hide` regions use the fast bbox predicate on the
   * objects' symbolised bounds (04 §7); the request on release leaves it off for the exact result.
   */
  fastFilter?: boolean;
};

export interface CourseRequest {
  type: "course";
  /** Echoed in the reply; the engine keeps only the latest. */
  generation: number;
  /** `null` clears the layer. */
  input: CourseLayerRequest | null;
}

export type WorkerRequest = LoadRequest | PrepareRequest | CourseRequest;

/** The dynamic bucket's id (never a cell or the large bucket). */
export const COURSE_BUCKET = -2;

/** Course symbol dimensions on paper, mm: what the UI layer sizes its hit targets and rings by. */
export interface CourseMetrics {
  circleRadiusMm: number;
  finishRadiusMm: number;
  startRadiusMm: number;
  lineWidthMm: number;
  digitHeightMm: number;
}

export interface LoadSummary {
  /** Paper bounds of everything drawn, µm. */
  bounds: render.Bounds | undefined;
  originX: number;
  originY: number;
  grid: Grid;
  largeId: number;
  /** Cell ids that have a detail layer (strokes, glyphs, text, clips). */
  detailCells: number[];
  /** The cell with the most passes (the bench's dense viewport), −1 if none. */
  densestCell: number;
  passes: number;
  passKinds: Record<string, number>;
  colours: number;
  objects: { total: number; drawn: number; large: number };
  /** Bridge statistics (document source only). */
  bridge?: mapDocument.DocumentRenderInput["stats"];
  /**
   * Backend warnings are counted here too: `TEXT_ATLAS_MISSING` (text passes, no pages loaded),
   * `TEXT_GLYPH_NOT_IN_ATLAS` (glyphs the pages do not hold), `TEXT_HALO_CLAMPED` (halo passes
   * wider than the field).
   */
  warnings: Record<string, number>;
  /** Text atlas pages used and glyphs resolved against them. */
  text: { pages: string[]; glyphs: number; missing: number };
  /** The first view resolved (fit computed here when asked for) and the detail cells queued for it. */
  view?: ViewRect;
  queued: number[];
  ms: { decode: number; bridge: number; symbolise: number; atlas: number; assign: number; base: number; large: number };
  bytes: { base: number; large: number; atlas: number };
  /** The stack the parts' colour indices refer to (document source): the document's, or with `courseLayer` the course-completed one. */
  colourStack?: render.ColourStack;
  /** With `courseLayer`: whether `course` requests can be drawn (an unaligned stack cannot), and the cut features found. */
  courseLayer?: { supported: true; cutFeatures: number } | { supported: false; reason: string };
}

/**
 * Filter regions resolved for the static buckets (§5.2 "Filter regions"): the hidden objects and,
 * per range-table entry `(object, colour)`, the mask it draws under, with each mask's region
 * triangles (origin-relative, even-odd triangulated per region).
 */
export interface FilterReply {
  hidden: Uint32Array;
  /** `object, colour, mask` triples. */
  entries: Uint32Array;
  positions: Float32Array;
  indices: Uint32Array;
  masks: { offset: number; count: number }[];
}

export interface LoadedReply {
  type: "loaded";
  summary: LoadSummary;
  atlas: MeshAtlas;
  base: PreparedPart[];
  large: PreparedPart | undefined;
  /** A `stream` source carrying filter masks: the masks for the static buckets. */
  filter?: FilterReply;
}

export interface PartReply {
  type: "part";
  part: PreparedPart;
}

export interface ErrorReply {
  type: "error";
  message: string;
}

export interface CourseReply {
  type: "course";
  generation: number;
  /** The dynamic bucket (`COURSE_BUCKET`, layer `all`); null when cleared or unsupported. */
  part: PreparedPart | null;
  /** The stack to draw everything with while this layer is shown: the completed stack plus layout-object rows on top. */
  colours: render.ColourStack;
  derivation: course.CourseDerivation | null;
  metrics: CourseMetrics | null;
  /** symbolise, `TEXT_*` and `COURSE_UNAVAILABLE` counts. */
  warnings: Record<string, number>;
  /** The whole mesh atlas, only when the course added meshes to it (earlier meshes keep their `base`). */
  atlas?: MeshAtlas;
  /** The input's filter regions over the document's objects; null without regions (clears the filter). */
  filter: FilterReply | null;
}

export type WorkerReply = LoadedReply | PartReply | ErrorReply | CourseReply;

export type Post = (msg: WorkerReply, transfer: ArrayBuffer[]) => void;

interface State {
  stream: render.PassStream;
  assignment: Assignment;
  ctx: PrepareContext;
  /** Present after a `courseLayer` load of a document with an aligned stack. */
  course?: CourseState;
  /** The stack the static parts index (document source). */
  colourStack: render.ColourStack;
  /** Symbolised bounds per document object, computed on the first filter request. */
  objectBounds?: Map<number, render.Bounds>;
}

/**
 * A filter result as the engine applies it: masked range-table entries as `(object, colour, mask)`
 * triples (a mask is a function of the pair, `render.filterStream`) and the masks' region triangles.
 */
export function filterReply(stream: render.PassStream, hidden: readonly number[], maskIdx: Int32Array | undefined, masks: render.FilterMask[], ctx: Pick<PrepareContext, "originX" | "originY" | "toleranceUm">): FilterReply {
  const seen = new Set<number>();
  const entries: number[] = [];
  if (maskIdx) {
    for (let i = 0; i < maskIdx.length; i++) {
      const m = maskIdx[i];
      if (m < 0) continue;
      const o = stream.objectIdx[i], c = stream.passes[i].colour;
      const key = o * 65536 + c;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(o, c, m);
    }
  }
  const positions: number[] = [];
  const indices: number[] = [];
  const out: FilterReply["masks"] = [];
  for (const m of masks) {
    const offset = indices.length;
    for (const r of m.regions) {
      const t = triangulateEvenOdd(render.flattenRings({ ...r, closed: true }, ctx.toleranceUm));
      const base = positions.length / 2;
      for (let k = 0; k < t.positions.length; k += 2) positions.push(t.positions[k] - ctx.originX, t.positions[k + 1] - ctx.originY);
      for (const i of t.indices) indices.push(i + base);
    }
    out.push({ offset, count: indices.length - offset });
  }
  return { hidden: Uint32Array.from(hidden), entries: Uint32Array.from(entries), positions: Float32Array.from(positions), indices: Uint32Array.from(indices), masks: out };
}

const filterTransferables = (f: FilterReply): ArrayBuffer[] => [f.hidden.buffer, f.entries.buffer, f.positions.buffer, f.indices.buffer] as ArrayBuffer[];

interface CourseState {
  document: course.CourseDocumentContext;
  cutFeatures: course.CutFeature[];
  stackIndex: ReadonlyMap<string, number>;
  /** Stream objects of the document: the course part's object ids start here (`courseObjectOffset`). */
  objectOffset: number;
  fonts: render.FontMetrics[];
  textAtlas: TextAtlasPage[] | undefined;
  atlas: MeshAtlasBuilder;
  /** The atlas's meshes as last sent to the main thread. */
  meshes: AtlasMesh[];
}

/** Queued detail parts are prepared in slices of about this long, then the worker yields so a newer request can overtake. */
export const PREPARE_SLICE_MS = 8;

/** A task scheduler without `setTimeout`'s 4 ms nesting clamp. */
export function messageChannelScheduler(): (fn: () => void) => void {
  const ch = new MessageChannel();
  const q: (() => void)[] = [];
  ch.port1.onmessage = () => q.shift()?.();
  return (fn) => {
    q.push(fn);
    ch.port2.postMessage(0);
  };
}

/** The worker's message handler. `schedule` runs one slice of queued buckets per task so a newer request can overtake. */
export function createMapGlWorker(post: Post, schedule: (fn: () => void) => void = messageChannelScheduler(), sliceMs = PREPARE_SLICE_MS) {
  let state: State | undefined;
  let queue: number[] = [];
  let pumping = false;

  const pump = () => {
    pumping = false;
    if (!state) return;
    const t0 = performance.now();
    do {
      const id = queue.shift();
      if (id === undefined) break;
      const passes = state.assignment.bucketPasses.get(id);
      if (passes && id !== state.assignment.largeId) {
        const part = prepareBucketPart(state.stream, id, passes, "detail", state.ctx);
        post({ type: "part", part }, partTransferables(part));
      }
    } while (queue.length && performance.now() - t0 < sliceMs);
    if (queue.length) {
      pumping = true;
      schedule(pump);
    }
  };

  return {
    handle(msg: WorkerRequest): void {
      if (msg.type === "load") {
        queue = [];
        try {
          const { reply, transfer, next } = load(msg);
          state = next;
          queue = reply.summary.queued.slice();
          post(reply, transfer);
          if (queue.length && !pumping) {
            pumping = true;
            schedule(pump);
          }
        } catch (e) {
          state = undefined;
          post({ type: "error", message: e instanceof Error ? e.message : String(e) }, []);
        }
        return;
      }
      if (msg.type === "course") {
        const { reply, transfer } = courseReply(state, msg);
        post(reply, transfer);
        return;
      }
      queue = msg.ids.slice();
      if (!pumping && queue.length) {
        pumping = true;
        schedule(pump);
      }
    },
    /** Queue length, for tests. */
    get queued(): number {
      return queue.length;
    },
  };
}

function load(msg: LoadRequest): { reply: LoadedReply; transfer: ArrayBuffer[]; next: State } {
  const tol = msg.toleranceUm ?? TOLERANCE_UM;
  const fonts = msg.fonts.map((f) => render.parseTrueType(f.bytes, f.family));
  const t0 = performance.now();
  let objects: render.RenderObject[] = [], symbols: render.RenderSymbol[] = [];
  let bridge: mapDocument.DocumentRenderInput["stats"] | undefined;
  let tDecode = t0;
  let colourStack: render.ColourStack = [];
  let courseSupport: LoadSummary["courseLayer"];
  let courseDoc: { document: course.CourseDocumentContext; cutFeatures: course.CutFeature[]; stackIndex: ReadonlyMap<string, number> } | undefined;
  if (msg.source.kind === "document") {
    const doc = mapDocument.decodeMapDocument(new Uint8Array(msg.source.bytes));
    tDecode = performance.now();
    const input = mapDocument.documentRenderInput(doc, msg.source.options);
    objects = input.objects;
    symbols = input.symbols;
    bridge = input.stats;
    colourStack = doc.header.colours;
    if (msg.courseLayer) {
      // The static buckets are keyed on the stack the course layer draws with, course shown or not:
      // it is a function of the document alone, so showing a course re-prepares nothing (§5.2 "Dynamic bucket").
      try {
        const stack = course.courseColourStack(doc.header.colours);
        if (stack.remap) symbols = symbols.map((s) => render.remapRenderColours(s, stack.remap!));
        colourStack = stack.colours;
        const cutFeatures = course.cutFeaturesOfDocument(doc);
        courseDoc = { document: course.courseDocumentContext(doc.header), cutFeatures, stackIndex: stack.index };
        courseSupport = { supported: true, cutFeatures: cutFeatures.length };
      } catch (e) {
        if (!(e instanceof course.CourseStackError)) throw e;
        courseSupport = { supported: false, reason: e.message };
      }
    }
  } else if (msg.source.kind === "objects") {
    objects = msg.source.objects;
    symbols = msg.source.symbols;
  }
  const tBridge = performance.now();
  const { stream, warnings } = msg.source.kind === "stream" ? { stream: msg.source.stream, warnings: [] } : render.symbolise({ objects, symbols, fonts });
  const tSym = performance.now();

  // Mesh atlas: every glyph part. Text: every glyph resolved against the text atlas pages.
  const atlas = new MeshAtlasBuilder();
  const glyphMesh = new Map<string, number>();
  const glyphTol = Math.max(0.5, tol / 4);
  for (const m of stream.glyphTable) glyphMesh.set(`${m.glyphId}/${m.partIdx}`, atlas.glyph(m, glyphTol));
  const textWarn: Record<string, number> = {};
  const textStats = { pages: (msg.textAtlas ?? []).map((p) => p.page), glyphs: 0, missing: 0 };
  const textGlyph = resolveText(stream, fonts, msg.textAtlas, textWarn, textStats);
  const built = atlas.build();
  const tAtlas = performance.now();

  const meshRadius = (glyphId: number, partIdx: number) => {
    const mi = glyphMesh.get(`${glyphId}/${partIdx}`);
    return mi === undefined ? 0 : built.meshes[mi].radius;
  };
  const assignment = assignBuckets(stream, meshRadius, { cellUm: msg.cellUm, largeCells: msg.largeCells });
  const { grid, largeId } = assignment;
  const tAssign = performance.now();

  const originX = (grid.minCol + grid.cols / 2) * grid.cellUm;
  const originY = (grid.minRow + grid.rows / 2) * grid.cellUm;
  const ctx: PrepareContext = { toleranceUm: tol, originX, originY, meshes: built.meshes, glyphMesh, textGlyph };

  const base: PreparedPart[] = [];
  const detailCells: number[] = [];
  const isBase = (k: render.PassKind) => k === "fill" || k === "hatch";
  for (const [id, passes] of [...assignment.bucketPasses.entries()].sort((a, b) => a[0] - b[0])) {
    if (id === largeId) continue;
    if (passes.some((pi) => isBase(stream.passes[pi].kind))) base.push(prepareBucketPart(stream, id, passes, "base", ctx));
    if (passes.some((pi) => !isBase(stream.passes[pi].kind))) detailCells.push(id);
  }
  const tBase = performance.now();
  let densestCell = -1, densest = 0;
  for (const [id, passes] of assignment.bucketPasses) {
    if (id !== largeId && passes.length > densest) { densest = passes.length; densestCell = id; }
  }
  const largePasses = assignment.bucketPasses.get(largeId);
  const large = largePasses ? prepareBucketPart(stream, largeId, largePasses, "all", ctx) : undefined;
  const tLarge = performance.now();

  const passKinds: Record<string, number> = {};
  for (const p of stream.passes) passKinds[p.kind] = (passKinds[p.kind] ?? 0) + 1;
  const warn: Record<string, number> = {};
  for (const w of warnings) warn[w.code] = (warn[w.code] ?? 0) + 1;
  for (const [code, n] of Object.entries(textWarn)) warn[code] = (warn[code] ?? 0) + n;
  let drawn = 0, largeObjects = 0;
  for (const b of assignment.objectBucket) {
    if (b >= 0) drawn++;
    if (b === largeId) largeObjects++;
  }
  const r = (x: number) => Math.round(x * 100) / 100;
  const bounds = render.passStreamBounds(stream);
  const fv = msg.firstView;
  const view = fv ? (fv.kind === "view" ? fv.view : fitView(bounds, fv.widthPx, fv.heightPx, fv.fill)) : undefined;
  const detail = new Set(detailCells);
  const queued = view && (msg.gate === false || aboveZoomGate(view.pxPerUm))
    ? visibleCells(view, grid, msg.prefetchMarginCells ?? PREFETCH_MARGIN_CELLS).filter((id) => detail.has(id))
    : [];
  const summary: LoadSummary = {
    bounds,
    ...(view ? { view } : {}),
    queued,
    originX, originY, grid, largeId, detailCells, densestCell,
    passes: stream.passes.length,
    passKinds,
    colours: new Set(stream.passes.map((p) => p.colour)).size,
    objects: { total: msg.source.kind === "stream" ? assignment.objectBucket.length : objects.length, drawn, large: largeObjects },
    ...(bridge ? { bridge } : {}),
    warnings: warn,
    text: textStats,
    ms: {
      decode: r(tDecode - t0), bridge: r(tBridge - tDecode), symbolise: r(tSym - tBridge), atlas: r(tAtlas - tSym),
      assign: r(tAssign - tAtlas), base: r(tBase - tAssign), large: r(tLarge - tBase),
    },
    bytes: { base: base.reduce((n, p) => n + p.gpuBytes, 0), large: large?.gpuBytes ?? 0, atlas: built.data.byteLength },
    ...(msg.source.kind === "document" ? { colourStack } : {}),
    ...(msg.courseLayer ? { courseLayer: courseSupport ?? { supported: false, reason: "a course layer needs a document source" } } : {}),
  };
  const courseState: CourseState | undefined = courseDoc && {
    ...courseDoc, objectOffset: objects.length, fonts, textAtlas: msg.textAtlas, atlas, meshes: built.meshes,
  };
  const transfer: ArrayBuffer[] = [built.data.buffer as ArrayBuffer];
  for (const p of base) transfer.push(...partTransferables(p));
  if (large) transfer.push(...partTransferables(large));
  const filter = stream.masks?.length && stream.maskIdx ? filterReply(stream, [], stream.maskIdx, stream.masks, ctx) : undefined;
  if (filter) transfer.push(...filterTransferables(filter));
  return { reply: { type: "loaded", summary, atlas: built, base, large, ...(filter ? { filter } : {}) }, transfer, next: { stream, assignment, ctx, colourStack, ...(courseState ? { course: courseState } : {}) } };
}

/**
 * The dynamic bucket (§5.2 "Dynamic bucket"; 04 §7): the course layer
 * symbolised on its own — its symbols already index the completed stack
 * the static parts were built on — and prepared as one `all` part. Object
 * ids continue after the document's (`courseRenderInput`'s
 * `courseObjectOffset`), glyph meshes join the atlas by content, numbers
 * resolve against the loaded text pages.
 */
function courseReply(state: State | undefined, msg: CourseRequest): { reply: CourseReply; transfer: ArrayBuffer[] } {
  const empty = (colours: render.ColourStack, warnings: Record<string, number> = {}): { reply: CourseReply; transfer: ArrayBuffer[] } => ({
    reply: { type: "course", generation: msg.generation, part: null, colours, derivation: null, metrics: null, warnings, filter: null },
    transfer: [],
  });
  const cs = state?.course;
  if (!state || !cs) return empty(state?.colourStack ?? [], msg.input ? { COURSE_UNAVAILABLE: 1 } : {});
  if (!msg.input) return empty(state.colourStack);

  const { fastFilter, ...input } = msg.input;
  const layer = course.courseLayer({ ...input, document: cs.document, cutFeatures: cs.cutFeatures });
  const set = course.courseSymbols(cs.document, cs.stackIndex, msg.input.appearance);
  const sym = render.symbolise({ objects: layer.objects.map(({ ref: _ref, ...o }) => o), symbols: layer.symbols, fonts: cs.fonts });
  const objectIdx = new Uint32Array(sym.stream.objectIdx.length);
  for (let i = 0; i < objectIdx.length; i++) objectIdx[i] = sym.stream.objectIdx[i] + cs.objectOffset;
  const stream: render.PassStream = { ...sym.stream, objectIdx };

  const before = cs.atlas.size;
  const glyphMesh = new Map<string, number>();
  const tol = state.ctx.toleranceUm;
  for (const m of stream.glyphTable) glyphMesh.set(`${m.glyphId}/${m.partIdx}`, cs.atlas.glyph(m, Math.max(0.5, tol / 4), `c/${meshKey(m)}`));
  const grown = cs.atlas.size > before ? cs.atlas.build() : undefined;
  if (grown) cs.meshes = grown.meshes;

  const warnings: Record<string, number> = {};
  for (const w of sym.warnings) warnings[w.code] = (warnings[w.code] ?? 0) + 1;
  const textGlyph = resolveText(stream, cs.fonts, cs.textAtlas, warnings, { glyphs: 0, missing: 0 });
  const ctx: PrepareContext = { ...state.ctx, meshes: cs.meshes, glyphMesh, textGlyph };
  const passes = stream.passes.map((_, i) => i);
  const part = passes.length ? prepareBucketPart(stream, COURSE_BUCKET, passes, "all", ctx) : null;

  // Filter regions act on the document's stream only (the course part is never filtered, §4.11).
  let filter: FilterReply | null = null;
  if (layer.regions.length) {
    state.objectBounds ??= render.objectBounds(state.stream);
    const f = render.filterStream(state.stream, layer.regions, { fast: !!fastFilter, objectBounds: state.objectBounds });
    for (const w of f.warnings) warnings[w.code] = (warnings[w.code] ?? 0) + 1;
    filter = filterReply(state.stream, f.hidden, f.maskIdx, f.masks, state.ctx);
  }

  const um = (v: number) => v / 1000;
  const reply: CourseReply = {
    type: "course", generation: msg.generation, part, colours: layer.colours, derivation: layer.derivation, warnings, filter,
    metrics: {
      circleRadiusMm: um(set.circleRadiusUm), finishRadiusMm: um(set.finishRadiusUm), startRadiusMm: um(set.startRadiusUm),
      lineWidthMm: um(set.lineWidthUm), digitHeightMm: um(set.digitHeightUm),
    },
    ...(grown ? { atlas: grown } : {}),
  };
  const transfer = part ? partTransferables(part) : [];
  if (grown) transfer.push(grown.data.buffer as ArrayBuffer);
  if (filter) transfer.push(...filterTransferables(filter));
  return { reply, transfer };
}

/** A glyph part's geometry as a key: the course stream's glyph ids change with every re-symbolisation. */
function meshKey(m: render.GlyphMesh): string {
  return JSON.stringify([m.fills.map((f) => [Array.from(f.coords), Array.from(f.flags), f.closed]), m.strokes.map((s) => [Array.from(s.path.coords), Array.from(s.path.flags), s.path.closed, s.widthUm, s.cap, s.join])]);
}

/**
 * Every text pass's glyphs as text-atlas entries (§5.2 "Text atlas"):
 * looked up by (font family, glyph id); a glyph the pages do not hold is
 * −1 and counted unless it has no outline (nothing to draw anyway) or is
 * `.notdef` (glyph 0: what the shaper emits for an unmapped code point
 * such as a tab — not drawn here, §8).
 */
function resolveText(
  stream: render.PassStream,
  fonts: render.FontMetrics[],
  pages: TextAtlasPage[] | undefined,
  warn: Record<string, number>,
  stats: { glyphs: number; missing: number },
): Map<number, TextPassGlyphs> {
  const out = new Map<number, TextPassGlyphs>();
  const count = (code: string, n = 1) => { warn[code] = (warn[code] ?? 0) + n; };
  const texts = stream.passes.flatMap((p, i) => (p.kind === "text" ? [i] : []));
  if (!texts.length) return out;
  if (!pages?.length) {
    count("TEXT_ATLAS_MISSING", texts.length);
    return out;
  }
  const { lookup } = buildTextGlyphs(pages);
  const rangeEm = pages[0].distanceRangePx / pages[0].emPx;
  const refById = new Map(stream.fontTable.map((r) => [r.fontId, r]));
  for (const i of texts) {
    const p = stream.passes[i] as render.TextPass;
    const ref = refById.get(p.fontId);
    const font = ref && (fonts.find((f) => f.family === ref.family && !!f.bold === ref.bold && !!f.italic === ref.italic) ?? fonts.find((f) => f.family === ref.family));
    const entries = new Int32Array(p.glyphs.length).fill(-1);
    const pageOf = new Uint8Array(p.glyphs.length);
    for (let g = 0; g < p.glyphs.length; g++) {
      const hit = ref === undefined ? undefined : lookup.get(textGlyphKey(ref.family, ref.bold, p.glyphs[g]));
      if (hit) {
        entries[g] = hit.entry;
        pageOf[g] = hit.page;
        stats.glyphs++;
      } else if (p.glyphs[g] !== 0 && font?.outline?.(p.glyphs[g])) {
        stats.missing++;
        count("TEXT_GLYPH_NOT_IN_ATLAS");
      }
    }
    let halo = 0;
    if (p.haloWidthUm) {
      const h = haloEm(p.haloWidthUm, p.sizeUm, rangeEm);
      halo = h.em;
      if (h.clamped) count("TEXT_HALO_CLAMPED");
    }
    out.set(i, { entries, pages: pageOf, haloEm: halo });
  }
  return out;
}
