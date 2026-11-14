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
 *   → load     { source: document bytes (+ patch) | objects + symbols, fonts, text atlas pages }   ← loaded { summary, atlas, grid, base parts, large part }
 *   → prepare  { ids }   replaces the queue; ← part { part } per id, nearest first
 *   → course   { generation, input }   ← course { generation, part, colours, derivation, filter, … } (§5.2 "Dynamic bucket", "Filter regions")
 *   → patch    { generation, patch, detail }   ← patched { generation, patch state, touched buckets' parts } (§5.2 "Patch")
 *   ← error    { message } (load failures, the queue stops; a course or patch request that throws)
 *
 * Range-table object ids are the effective document's `objectIndex`
 * (§5.2 "Object identity"); the course layer's start at
 * `COURSE_OBJECT_BASE`.
 */

import { course, mapDocument, render } from "@oxygen/shared";
import { MeshAtlasBuilder, type AtlasMesh, type MeshAtlas } from "./mesh-atlas.js";
import { buildTextGlyphs, haloEm, textGlyphKey, type TextAtlasPage } from "./text-atlas.js";
import { triangulateEvenOdd } from "./prepare.js";
import {
  aboveZoomGate, assignBuckets, assignToGrid, fitView, LARGE_CELLS, partTransferables, prepareBucketPart, prepareBucketPartFrom, PREFETCH_MARGIN_CELLS, sourcesHaveLayer, visibleCells,
  type Assignment, type Grid, type PartLayer, type PartSource, type PrepareContext, type PreparedPart, type TextPassGlyphs, type ViewRect,
} from "./buckets.js";

/** Flattening tolerance, paper µm (OCAD's own resolution). */
export const TOLERANCE_UM = 10;

export type LoadSource =
  | {
    kind: "document"; bytes: ArrayBuffer; options: mapDocument.DocumentRenderOptions;
    /** The event's patch over this document (§5.2 "Patch"); the caller pairs it by hash (map-patches §2). */
    patch?: mapDocument.MapPatch | null;
  }
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
  /**
   * Layout mode's page (docs/course-layout.md §1): the sheet's page-anchored objects and
   * description block through the composer's own page layer, answered as a second part.
   */
  page?: PageLayerRequest;
};

/** The page of a sheet as the composer takes it; the worker adds the document context. */
export type PageLayerRequest = Pick<course.PageLayerInput, "paper" | "frame" | "window" | "objects" | "textValues" | "description">;

export interface CourseRequest {
  type: "course";
  /** Echoed in the reply; the engine keeps only the latest. */
  generation: number;
  /** `null` clears the layer. */
  input: CourseLayerRequest | null;
}

/**
 * A patch change (§5.2 "Patch"): the effective document is redrawn without reloading the
 * document. The worker applies `patch` to the pinned document it holds; `null` (or a disabled
 * or empty patch) is the document itself.
 */
export interface PatchRequest {
  type: "patch";
  /** Echoed in the reply. */
  generation: number;
  patch: mapDocument.MapPatch | null;
  /** Cells whose detail part the engine holds: a touched one comes back prepared in the reply. */
  detail: number[];
}

export type WorkerRequest = LoadRequest | PrepareRequest | CourseRequest | PatchRequest;

/** The dynamic bucket's id (never a cell or the large bucket). */
export const COURSE_BUCKET = -2;
/** The page part's id (Layout mode, docs/course-layout.md §1). */
export const PAGE_BUCKET = -3;
/**
 * The course part's first range-table object id (§5.2 "Object identity"): document objects are
 * their effective `objectIndex`, which a patch's added objects extend, so the course's ids start
 * far above any document's.
 */
export const COURSE_OBJECT_BASE = 0x4000_0000;

/** What the worker drew of a patch: the objects it hides (range-table ids) and the ops it skipped. */
export interface PatchState {
  /** Effective `objectIndex`es the patch hides: skipped in the visible set (map-patches §2.2). */
  hidden: Uint32Array;
  /** Pinned objects re-symbolised (modified or resymbolled, not hidden) and objects added. */
  changed: number;
  added: number;
  /** `applyPatch`'s issues (map-patches §2.3): reported, never thrown. */
  issues: mapDocument.PatchIssue[];
  /** With a course layer: the automatic-cut features of the effective document. */
  cutFeatures?: number;
}

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
  /** A document source: the patch drawn with it (none: the identity state). */
  patch?: PatchState;
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
  /** Set when a `course` request threw: that request's generation (F20b). A failed load, or `onerror`, has none. */
  generation?: number;
  /** Set when a `patch` request threw: that request's generation. */
  patch?: number;
}

/**
 * A patch change applied (§5.2 "Patch"): the buckets whose content changed, re-prepared. A touched
 * cell absent from `base` has no base part now; one absent from `detail` has none prepared (the
 * engine drops what it holds and asks again if the cell still has detail).
 */
export interface PatchedReply {
  type: "patched";
  generation: number;
  patch: PatchState;
  /** Bucket ids whose parts changed (cells and possibly the large bucket). */
  touched: number[];
  base: PreparedPart[];
  /** Detail parts of the touched cells the request said the engine holds. */
  detail: PreparedPart[];
  /** The large bucket when it is touched (`null`: it is empty now); absent when untouched. */
  large?: PreparedPart | null;
  /** Every cell with a detail layer now. */
  detailCells: number[];
  bytes: { base: number; large: number };
  /** The whole mesh atlas, only when the patch added meshes (earlier meshes keep their `base`). */
  atlas?: MeshAtlas;
  ms: number;
}

/**
 * The course layer as the editor hit-tests it (docs/map-rendering.md §5.5):
 * the symbolised stream with layer-local object ids, and each object's
 * `ref` (site, leg, number, …) by that id. Small (hundreds of passes);
 * the main thread runs `render.hitTest` on it synchronously.
 */
export interface CourseHitIndex {
  stream: render.PassStream;
  refs: course.CourseRef[];
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
  /** What the editor hit-tests; null when cleared or unsupported. */
  hit: CourseHitIndex | null;
  /**
   * The page part (`PAGE_BUCKET`, layer `all`; docs/course-layout.md §1): the page layer in
   * paper µm, its colour indices offset by `page.colourBase` so it draws after every map colour,
   * as the PDF draws the page layer after the map layer. Null without a `page` request.
   */
  pagePart: PreparedPart | null;
  /** With a page: where its colours start in `colours` (the page's copy of the table) and the frame in paper µm (the map clip). */
  page: { colourBase: number; frameRingUm: [number, number][] } | null;
}

export type WorkerReply = LoadedReply | PartReply | ErrorReply | CourseReply | PatchedReply;

export type Post = (msg: WorkerReply, transfer: ArrayBuffer[]) => void;

interface State {
  /** The pinned document's stream; `objectIdx` is the document's `objectIndex` (document source). */
  stream: render.PassStream;
  assignment: Assignment;
  ctx: PrepareContext;
  /** Present after a `courseLayer` load of a document with an aligned stack. */
  course?: CourseState;
  /** The stack the static parts index (document source). */
  colourStack: render.ColourStack;
  /** Symbolised bounds per document object, computed on the first filter request. */
  objectBounds?: Map<number, render.Bounds>;
  fonts: render.FontMetrics[];
  textAtlas: TextAtlasPage[] | undefined;
  atlas: MeshAtlasBuilder;
  /** The atlas's meshes as last sent to the main thread. */
  meshes: AtlasMesh[];
  glyphTol: number;
  largeCells: number;
  /** A document source: what a patch is applied to. */
  document?: PinnedDocument;
  /** Cells with a detail layer now; base part bytes per cell and the large part's. */
  detailCells: Set<number>;
  baseBytes: Map<number, number>;
  largeBytes: number;
  /** The patch drawn now (§5.2 "Patch"); absent: the pinned document as it is. */
  overlay?: Overlay;
}

interface PinnedDocument {
  doc: mapDocument.MapDocument;
  options: mapDocument.DocumentRenderOptions;
  /** The course-completed stack's re-indexing of the bridged symbols (`courseLayer`). */
  remap?: ArrayLike<number>;
  /** `sourceIndex` → `objectIndex`, built on the first patch. */
  bySource?: Map<number, number>;
}

/**
 * A patch's overlay on the pinned document's stream (§5.2 "Patch"): the objects it hides (ids
 * only), and the objects it changes or adds, symbolised on their own and assigned to the load's
 * grid. A bucket's part is its pinned passes without the changed objects', merged by colour with
 * the overlay's passes in it.
 */
interface Overlay {
  state: PatchState;
  /** Pinned objects whose passes the overlay replaces (modified or resymbolled, not hidden). */
  changed: Set<number>;
  /** Per bucket: its pinned objects that are in `changed`. */
  lost: Map<number, Set<number>>;
  stream: render.PassStream;
  glyphMesh: Map<string, number>;
  textGlyph: Map<number, TextPassGlyphs>;
  bucketPasses: Map<number, number[]>;
  /** Per bucket: what the overlay takes from and adds to it; a bucket is touched when this changes. */
  signature: Map<number, string>;
  objectBounds?: Map<number, render.Bounds>;
  warnings: Record<string, number>;
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
  /** Of the effective document (§5.2 "Patch"): recomputed with every patch change. */
  cutFeatures: course.CutFeature[];
  stackIndex: ReadonlyMap<string, number>;
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
      const part = id !== state.assignment.largeId ? partFor(state, id, "detail") : null;
      if (part) post({ type: "part", part }, partTransferables(part));
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
        // A request whose derivation throws answers `error`: the engine keeps one course request in
        // flight and must hear that it ended (F20, docs/bugfix-course-drag-redraw.md).
        try {
          const { reply, transfer } = courseReply(state, msg);
          post(reply, transfer);
        } catch (e) {
          // Its generation, so the engine ends this request only and leaves a load in flight alone (F20b).
          post({ type: "error", message: e instanceof Error ? e.message : String(e), generation: msg.generation }, []);
        }
        return;
      }
      if (msg.type === "patch") {
        // Like a course request: answered at once, between prepare slices; the queue goes on with
        // the new content (`partFor` reads the overlay).
        try {
          const { reply, transfer } = patchReply(state, msg);
          post(reply, transfer);
        } catch (e) {
          post({ type: "error", message: e instanceof Error ? e.message : String(e), patch: msg.generation }, []);
        }
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
  let docIdx: number[] | undefined;
  let bridge: mapDocument.DocumentRenderInput["stats"] | undefined;
  let tDecode = t0;
  let colourStack: render.ColourStack = [];
  let courseSupport: LoadSummary["courseLayer"];
  let courseDoc: CourseState | undefined;
  let pinned: PinnedDocument | undefined;
  if (msg.source.kind === "document") {
    const doc = mapDocument.decodeMapDocument(new Uint8Array(msg.source.bytes));
    tDecode = performance.now();
    const input = mapDocument.documentRenderInput(doc, msg.source.options);
    objects = input.objects;
    symbols = input.symbols;
    docIdx = input.docIdx;
    bridge = input.stats;
    colourStack = doc.header.colours;
    pinned = { doc, options: msg.source.options };
    if (msg.courseLayer) {
      // The static buckets are keyed on the stack the course layer draws with, course shown or not:
      // it is a function of the document alone, so showing a course re-prepares nothing (§5.2 "Dynamic bucket").
      try {
        const stack = course.courseColourStack(doc.header.colours);
        if (stack.remap) {
          symbols = symbols.map((s) => render.remapRenderColours(s, stack.remap!));
          pinned.remap = stack.remap;
        }
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
  const symbolised = msg.source.kind === "stream" ? { stream: msg.source.stream, warnings: [] } : render.symbolise({ objects, symbols, fonts });
  const { warnings } = symbolised;
  // Object identity across the bridge (§5.2 "Object identity"): the stream's ids index the bridge's
  // filtered object list; a document's range tables key on the document's own `objectIndex`.
  const stream = docIdx ? withObjectIds(symbolised.stream, docIdx) : symbolised.stream;
  const tSym = performance.now();

  // Mesh atlas: every glyph part. Text: every glyph resolved against the text atlas pages.
  const atlas = new MeshAtlasBuilder();
  const glyphMesh = new Map<string, number>();
  const glyphTol = Math.max(0.5, tol / 4);
  for (const m of stream.glyphTable) glyphMesh.set(`${m.glyphId}/${m.partIdx}`, atlas.glyph(m, glyphTol));
  const textWarn: Record<string, number> = {};
  const textStats = { pages: (msg.textAtlas ?? []).map((p) => p.page), glyphs: 0, missing: 0 };
  const textGlyph = resolveText(stream, fonts, msg.textAtlas, textWarn, textStats);
  let built = atlas.build();
  const tAtlas = performance.now();

  const meshRadius = (glyphId: number, partIdx: number) => {
    const mi = glyphMesh.get(`${glyphId}/${partIdx}`);
    return mi === undefined ? 0 : built.meshes[mi].radius;
  };
  const largeCells = msg.largeCells ?? LARGE_CELLS;
  const assignment = assignBuckets(stream, meshRadius, { cellUm: msg.cellUm, largeCells });
  const { grid, largeId } = assignment;
  const tAssign = performance.now();

  const originX = (grid.minCol + grid.cols / 2) * grid.cellUm;
  const originY = (grid.minRow + grid.rows / 2) * grid.cellUm;
  const ctx: PrepareContext = { toleranceUm: tol, originX, originY, meshes: built.meshes, glyphMesh, textGlyph };
  const state: State = {
    stream, assignment, ctx, colourStack, fonts, textAtlas: msg.textAtlas, atlas, meshes: built.meshes, glyphTol, largeCells,
    detailCells: new Set(), baseBytes: new Map(), largeBytes: 0,
    ...(courseDoc ? { course: courseDoc } : {}),
    ...(pinned ? { document: pinned } : {}),
  };

  // A patch that comes with the load is drawn from the first frame: the overlay is computed
  // before the parts, so each is prepared once.
  let patchState: PatchState | undefined;
  if (pinned) {
    const applied = applyOverlay(state, msg.source.kind === "document" ? msg.source.patch ?? null : null);
    patchState = applied.state;
    if (applied.grown) built = applied.grown;
    for (const [code, n] of Object.entries(state.overlay?.warnings ?? {})) textWarn[code] = (textWarn[code] ?? 0) + n;
  }

  const base: PreparedPart[] = [];
  const detailCells: number[] = [];
  for (const id of bucketIds(state)) {
    if (id === largeId) continue;
    const part = partFor(state, id, "base");
    if (part) {
      base.push(part);
      state.baseBytes.set(id, part.gpuBytes);
    }
    if (sourcesHaveLayer(partSources(state, id), "detail")) detailCells.push(id);
  }
  state.detailCells = new Set(detailCells);
  const tBase = performance.now();
  let densestCell = -1, densest = 0;
  for (const [id, passes] of assignment.bucketPasses) {
    if (id !== largeId && passes.length > densest) { densest = passes.length; densestCell = id; }
  }
  const large = partFor(state, largeId, "all") ?? undefined;
  state.largeBytes = large?.gpuBytes ?? 0;
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
  const queued = view && (msg.gate === false || aboveZoomGate(view.pxPerUm))
    ? visibleCells(view, grid, msg.prefetchMarginCells ?? PREFETCH_MARGIN_CELLS).filter((id) => state.detailCells.has(id))
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
    ...(msg.courseLayer ? { courseLayer: courseSupport && courseSupport.supported ? { supported: true as const, cutFeatures: state.course!.cutFeatures.length } : courseSupport ?? { supported: false, reason: "a course layer needs a document source" } } : {}),
    ...(patchState ? { patch: patchState } : {}),
  };
  const transfer: ArrayBuffer[] = [built.data.buffer as ArrayBuffer];
  for (const p of base) transfer.push(...partTransferables(p));
  if (large) transfer.push(...partTransferables(large));
  if (patchState) transfer.push(patchState.hidden.buffer as ArrayBuffer);
  const filter = stream.masks?.length && stream.maskIdx ? filterReply(stream, [], stream.maskIdx, stream.masks, ctx) : undefined;
  if (filter) transfer.push(...filterTransferables(filter));
  return { reply: { type: "loaded", summary, atlas: built, base, large, ...(filter ? { filter } : {}) }, transfer, next: state };
}

/** A stream whose object ids are `ids[objectIdx]`. */
function withObjectIds(stream: render.PassStream, ids: ArrayLike<number>): render.PassStream {
  const objectIdx = new Uint32Array(stream.objectIdx.length);
  for (let i = 0; i < objectIdx.length; i++) objectIdx[i] = ids[stream.objectIdx[i]];
  return { ...stream, objectIdx };
}

// ---- the patch (§5.2 "Patch") ------------------------------------------------

/** Every bucket with passes: the pinned stream's and the overlay's, ascending. */
function bucketIds(state: State): number[] {
  const ids = new Set(state.assignment.bucketPasses.keys());
  for (const id of state.overlay?.bucketPasses.keys() ?? []) ids.add(id);
  return [...ids].sort((a, b) => a - b);
}

/** What a bucket's parts are prepared from: its pinned passes less the changed objects', then the overlay's. */
function partSources(state: State, id: number): PartSource[] {
  const out: PartSource[] = [];
  const pinned = state.assignment.bucketPasses.get(id);
  const ov = state.overlay;
  if (pinned) {
    const lost = ov?.lost.get(id);
    const passes = lost ? pinned.filter((pi) => !lost.has(state.stream.objectIdx[pi])) : pinned;
    out.push({ stream: state.stream, passes, glyphMesh: state.ctx.glyphMesh, textGlyph: state.ctx.textGlyph });
  }
  const own = ov?.bucketPasses.get(id);
  if (ov && own) out.push({ stream: ov.stream, passes: own, glyphMesh: ov.glyphMesh, textGlyph: ov.textGlyph });
  return out;
}

/** One layer of one bucket of the effective document; null when it has nothing of that layer. */
function partFor(state: State, id: number, layer: PartLayer): PreparedPart | null {
  const sources = partSources(state, id);
  if (!sourcesHaveLayer(sources, layer)) return null;
  return prepareBucketPartFrom(sources, id, layer, state.ctx);
}

/**
 * Applies `patch` to the pinned document and replaces the overlay (§5.2 "Patch"). Always from the
 * pinned state — a patch is a set of keyed states, so the overlay is a function of its content —
 * and the touched buckets are those whose signature changed. Grows the mesh atlas for the
 * overlay's glyphs and, with a course layer, recomputes the cut features.
 */
function applyOverlay(state: State, patch: mapDocument.MapPatch | null): { state: PatchState; touched: Set<number>; grown?: MeshAtlas } {
  const pd = state.document;
  if (!pd) throw new Error("a patch needs a document source");
  const before = state.overlay;
  const { document: eff, issues } = mapDocument.applyPatch(pd.doc, patch);
  let grown: MeshAtlas | undefined;
  let next: Overlay | undefined;
  if (eff !== pd.doc) {
    const n = pd.doc.header.objects.count;
    const total = eff.header.objects.count;
    const hidden: number[] = [];
    for (let i = 0; i < n; i++) if (eff.hidden?.[i]) hidden.push(i);
    // Changed: the targets of the modify and resymbol ops that applied, unless hidden (hidden wins); and every added object.
    pd.bySource ??= new Map(Array.from(pd.doc.attrs.sourceIndex, (s, i) => [s, i]));
    const skipped = new Set(issues.map((x) => x.opId));
    const changed = new Set<number>();
    for (const [id, op] of Object.entries(patch!.ops)) {
      if ((op.op !== "modify" && op.op !== "resymbol") || skipped.has(id)) continue;
      const i = pd.bySource.get(op.sourceIndex);
      if (i !== undefined && !eff.hidden?.[i]) changed.add(i);
    }
    for (let i = n; i < total; i++) changed.add(i);

    // The changed objects symbolised on their own, ids rewritten to the effective objectIndex.
    const input = mapDocument.documentRenderInput(eff, { ...pd.options, only: [...changed] });
    const symbols = pd.remap ? input.symbols.map((s) => render.remapRenderColours(s, pd.remap!)) : input.symbols;
    const sym = render.symbolise({ objects: input.objects, symbols, fonts: state.fonts });
    const stream = withObjectIds(sym.stream, input.docIdx);
    const warnings: Record<string, number> = {};
    for (const w of sym.warnings) warnings[w.code] = (warnings[w.code] ?? 0) + 1;

    // Glyph meshes join the atlas by content (a re-symbolisation's glyph ids are its own).
    const glyphMesh = new Map<string, number>();
    for (const m of stream.glyphTable) glyphMesh.set(`${m.glyphId}/${m.partIdx}`, state.atlas.glyph(m, state.glyphTol, `c/${meshKey(m)}`));
    // Against the meshes last sent, not the size before this call: a request that failed after
    // growing the atlas left meshes the main thread has not seen.
    if (state.atlas.size > state.meshes.length) {
      grown = state.atlas.build();
      state.meshes = grown.meshes;
      state.ctx.meshes = grown.meshes;
    }
    const textGlyph = resolveText(stream, state.fonts, state.textAtlas, warnings, { glyphs: 0, missing: 0 });
    const meshRadius = (g: number, p: number) => {
      const mi = glyphMesh.get(`${g}/${p}`);
      return mi === undefined ? 0 : state.meshes[mi].radius;
    };
    const { grid, largeId, objectBucket: pinnedBucket } = state.assignment;
    const { objectBucket, bucketPasses } = assignToGrid(stream, meshRadius, grid, largeId, state.largeCells);

    // Per bucket: the pinned objects it loses and what it gains, by content.
    const lost = new Map<number, Set<number>>();
    for (const i of changed) {
      const b = i < pinnedBucket.length ? pinnedBucket[i] : -1;
      if (b < 0) continue;
      let set = lost.get(b);
      if (!set) lost.set(b, (set = new Set()));
      set.add(i);
    }
    const gained = new Map<number, number[]>();
    for (const [o, b] of objectBucket) {
      let arr = gained.get(b);
      if (!arr) gained.set(b, (arr = []));
      arr.push(o);
    }
    const signature = new Map<number, string>();
    for (const b of new Set([...lost.keys(), ...gained.keys()])) {
      const out = [...(lost.get(b) ?? [])].sort((x, y) => x - y);
      const inn = (gained.get(b) ?? []).sort((x, y) => x - y).map((o) => objectSignature(eff, patch!, o));
      signature.set(b, JSON.stringify([out, inn]));
    }
    next = {
      state: { hidden: Uint32Array.from(hidden), changed: changed.size - (total - n), added: total - n, issues },
      changed, lost, stream, glyphMesh, textGlyph, bucketPasses, signature, warnings,
    };
  }

  const touched = new Set<number>();
  const was = before?.signature ?? new Map<number, string>();
  const now = next?.signature ?? new Map<number, string>();
  for (const [b, s] of was) if (now.get(b) !== s) touched.add(b);
  for (const [b, s] of now) if (was.get(b) !== s) touched.add(b);
  state.overlay = next;
  const patchState: PatchState = next?.state ?? { hidden: new Uint32Array(0), changed: 0, added: 0, issues };
  // Recomputed unless the document is drawn as pinned now and was before (the load computed them).
  if (state.course && (eff !== pd.doc || before)) {
    state.course.cutFeatures = course.cutFeaturesOfDocument(eff);
    patchState.cutFeatures = state.course.cutFeatures.length;
  }
  return { state: patchState, touched, ...(grown ? { grown } : {}) };
}

/** What an object of the overlay is drawn from: its index, its ops' states and, for a patch symbol, the symbol. */
function objectSignature(eff: mapDocument.EffectiveDocument, patch: mapDocument.MapPatch, o: number): string {
  const p = eff.patch!;
  let ops: unknown[];
  if (o >= p.baseCount) ops = [patch.ops[`add:${p.added[o - p.baseCount]}`]];
  else {
    const s = eff.attrs.sourceIndex[o];
    ops = [patch.ops[`modify:${s}`] ?? null, patch.ops[`resymbol:${s}`] ?? null];
  }
  const si = eff.attrs.symbolIdx[o];
  return JSON.stringify([o, ops, si >= p.baseSymbols ? eff.header.symbols[si] : si]);
}

/** A patch change (§5.2 "Patch"): the overlay replaced, the touched buckets re-prepared. */
function patchReply(state: State | undefined, msg: PatchRequest): { reply: PatchedReply; transfer: ArrayBuffer[] } {
  if (!state) throw new Error("no document loaded");
  // A request that throws leaves the worker as the engine still has it: the next change is diffed
  // against the overlay the engine drew, and an atlas grown here goes with the next reply.
  const saved = {
    overlay: state.overlay, cutFeatures: state.course?.cutFeatures, meshes: state.meshes,
    baseBytes: new Map(state.baseBytes), detailCells: new Set(state.detailCells), largeBytes: state.largeBytes,
  };
  try {
    return patchReplyOf(state, msg);
  } catch (e) {
    state.overlay = saved.overlay;
    if (state.course && saved.cutFeatures) state.course.cutFeatures = saved.cutFeatures;
    state.meshes = saved.meshes;
    state.ctx.meshes = saved.meshes;
    state.baseBytes = saved.baseBytes;
    state.detailCells = saved.detailCells;
    state.largeBytes = saved.largeBytes;
    throw e;
  }
}

function patchReplyOf(state: State, msg: PatchRequest): { reply: PatchedReply; transfer: ArrayBuffer[] } {
  const t0 = performance.now();
  const applied = applyOverlay(state, msg.patch);
  const { largeId } = state.assignment;
  const held = new Set(msg.detail);
  const base: PreparedPart[] = [];
  const detail: PreparedPart[] = [];
  let large: PreparedPart | null | undefined;
  for (const id of [...applied.touched].sort((a, b) => a - b)) {
    if (id === largeId) {
      large = partFor(state, id, "all");
      state.largeBytes = large?.gpuBytes ?? 0;
      continue;
    }
    const b = partFor(state, id, "base");
    if (b) {
      base.push(b);
      state.baseBytes.set(id, b.gpuBytes);
    } else state.baseBytes.delete(id);
    if (sourcesHaveLayer(partSources(state, id), "detail")) {
      state.detailCells.add(id);
      if (held.has(id)) detail.push(partFor(state, id, "detail")!);
    } else state.detailCells.delete(id);
  }
  let baseTotal = 0;
  for (const n of state.baseBytes.values()) baseTotal += n;
  const reply: PatchedReply = {
    type: "patched", generation: msg.generation, patch: applied.state, touched: [...applied.touched].sort((a, b) => a - b),
    base, detail, ...(large !== undefined ? { large } : {}),
    detailCells: [...state.detailCells].sort((a, b) => a - b),
    bytes: { base: baseTotal, large: state.largeBytes },
    ...(applied.grown ? { atlas: applied.grown } : {}),
    ms: performance.now() - t0,
  };
  const transfer: ArrayBuffer[] = [applied.state.hidden.buffer as ArrayBuffer];
  for (const p of [...base, ...detail]) transfer.push(...partTransferables(p));
  if (large) transfer.push(...partTransferables(large));
  if (applied.grown) transfer.push(applied.grown.data.buffer as ArrayBuffer);
  return { reply, transfer };
}

/**
 * Filter regions over the effective document (§5.2 "Filter regions", "Patch"): the pinned stream
 * without the changed objects' results, and the overlay's stream, so a moved object is filtered
 * where it is now and an added one is filtered too.
 */
function effectiveFilter(state: State, regions: render.FilterRegion[], fast: boolean, warnings: Record<string, number>): FilterReply {
  const count = (ws: readonly { code: string }[]) => { for (const w of ws) warnings[w.code] = (warnings[w.code] ?? 0) + 1; };
  state.objectBounds ??= render.objectBounds(state.stream);
  const f = render.filterStream(state.stream, regions, { fast, objectBounds: state.objectBounds });
  count(f.warnings);
  const ov = state.overlay;
  if (!ov?.stream.passes.length) {
    const hidden = ov ? f.hidden.filter((o) => !ov.changed.has(o)) : f.hidden;
    return dropObjects(filterReply(state.stream, hidden, f.maskIdx, f.masks, state.ctx), ov?.changed);
  }
  ov.objectBounds ??= render.objectBounds(ov.stream);
  const g = render.filterStream(ov.stream, regions, { fast, objectBounds: ov.objectBounds });
  const a = dropObjects(filterReply(state.stream, f.hidden.filter((o) => !ov.changed.has(o)), f.maskIdx, f.masks, state.ctx), ov.changed);
  const b = filterReply(ov.stream, g.hidden, g.maskIdx, g.masks, state.ctx);
  return concatFilters(a, b);
}

/** A filter reply without the entries of `objects`. */
function dropObjects(f: FilterReply, objects: ReadonlySet<number> | undefined): FilterReply {
  if (!objects?.size) return f;
  const keep: number[] = [];
  for (let i = 0; i < f.entries.length; i += 3) if (!objects.has(f.entries[i])) keep.push(f.entries[i], f.entries[i + 1], f.entries[i + 2]);
  return { ...f, entries: Uint32Array.from(keep) };
}

/** Two filter replies as one: the second's masks after the first's. */
function concatFilters(a: FilterReply, b: FilterReply): FilterReply {
  const entries = new Uint32Array(a.entries.length + b.entries.length);
  entries.set(a.entries);
  for (let i = 0; i < b.entries.length; i += 3) {
    entries[a.entries.length + i] = b.entries[i];
    entries[a.entries.length + i + 1] = b.entries[i + 1];
    entries[a.entries.length + i + 2] = b.entries[i + 2] + a.masks.length;
  }
  const positions = new Float32Array(a.positions.length + b.positions.length);
  positions.set(a.positions);
  positions.set(b.positions, a.positions.length);
  const vertexBase = a.positions.length / 2;
  const indices = new Uint32Array(a.indices.length + b.indices.length);
  indices.set(a.indices);
  for (let i = 0; i < b.indices.length; i++) indices[a.indices.length + i] = b.indices[i] + vertexBase;
  const hidden = new Uint32Array(a.hidden.length + b.hidden.length);
  hidden.set(a.hidden);
  hidden.set(b.hidden, a.hidden.length);
  return { hidden, entries, positions, indices, masks: [...a.masks, ...b.masks.map((m) => ({ offset: m.offset + a.indices.length, count: m.count }))] };
}

/**
 * The dynamic bucket (§5.2 "Dynamic bucket"; 04 §7): the course layer
 * symbolised on its own — its symbols already index the completed stack
 * the static parts were built on — and prepared as one `all` part. Object
 * ids start at `COURSE_OBJECT_BASE` (§5.2 "Object identity"), glyph meshes
 * join the atlas by content, numbers resolve against the loaded text pages.
 */
function courseReply(state: State | undefined, msg: CourseRequest): { reply: CourseReply; transfer: ArrayBuffer[] } {
  const empty = (colours: render.ColourStack, warnings: Record<string, number> = {}): { reply: CourseReply; transfer: ArrayBuffer[] } => ({
    reply: { type: "course", generation: msg.generation, part: null, colours, derivation: null, metrics: null, warnings, filter: null, hit: null, pagePart: null, page: null },
    transfer: [],
  });
  const cs = state?.course;
  if (!state || !cs) return empty(state?.colourStack ?? [], msg.input ? { COURSE_UNAVAILABLE: 1 } : {});
  if (!msg.input) return empty(state.colourStack);

  const { fastFilter, page: pageInput, ...input } = msg.input;
  const layer = course.courseLayer({ ...input, document: cs.document, cutFeatures: cs.cutFeatures });
  const set = course.courseSymbols(cs.document, cs.stackIndex, msg.input.appearance);
  const sym = render.symbolise({ objects: layer.objects.map(({ ref: _ref, ...o }) => o), symbols: layer.symbols, fonts: state.fonts });
  const objectIdx = new Uint32Array(sym.stream.objectIdx.length);
  for (let i = 0; i < objectIdx.length; i++) objectIdx[i] = sym.stream.objectIdx[i] + COURSE_OBJECT_BASE;
  const stream: render.PassStream = { ...sym.stream, objectIdx };

  const warnings: Record<string, number> = {};
  for (const w of sym.warnings) warnings[w.code] = (warnings[w.code] ?? 0) + 1;

  // The page layer: the composer's own, in paper µm, its colours after every map colour.
  let pageStream: render.PassStream | null = null;
  let colours: render.ColourStack = layer.colours;
  let page: CourseReply["page"] = null;
  if (pageInput) {
    const pl = course.pageLayer({ ...pageInput, context: cs.document }, layer.colours, state.fonts);
    for (const w of pl.warnings) warnings[w.code] = (warnings[w.code] ?? 0) + 1;
    const base = pl.colours.length;
    const inMap = course.pageStreamInMap(pl);
    const pageObjectOffset = COURSE_OBJECT_BASE + layer.objects.length;
    const ids = new Uint32Array(inMap.objectIdx.length);
    for (let i = 0; i < ids.length; i++) ids[i] = inMap.objectIdx[i] + pageObjectOffset;
    pageStream = { ...inMap, objectIdx: ids, passes: inMap.passes.map((p) => ({ ...p, colour: p.colour + base })) };
    colours = [...pl.colours, ...pl.colours.map((c) => ({ ...c, id: `page:${c.id}` }))];
    page = { colourBase: base, frameRingUm: pl.frameRing.map((p) => [p.x * 1000, p.y * 1000] as [number, number]) };
  }

  const meshesOf = (s: render.PassStream, prefix: string) => {
    const out = new Map<string, number>();
    for (const m of s.glyphTable) out.set(`${m.glyphId}/${m.partIdx}`, state.atlas.glyph(m, state.glyphTol, `${prefix}/${meshKey(m)}`));
    return out;
  };
  const glyphMesh = meshesOf(stream, "c");
  const pageGlyphMesh = pageStream ? meshesOf(pageStream, "c") : undefined;
  const grown = state.atlas.size > state.meshes.length ? state.atlas.build() : undefined;
  if (grown) {
    state.meshes = grown.meshes;
    state.ctx.meshes = grown.meshes;
  }

  const prepared = (s: render.PassStream, bucket: number, mesh: Map<string, number>) => {
    const textGlyph = resolveText(s, state.fonts, state.textAtlas, warnings, { glyphs: 0, missing: 0 });
    const ctx: PrepareContext = { ...state.ctx, meshes: state.meshes, glyphMesh: mesh, textGlyph };
    const passes = s.passes.map((_, i) => i);
    return passes.length ? prepareBucketPart(s, bucket, passes, "all", ctx) : null;
  };
  const part = prepared(stream, COURSE_BUCKET, glyphMesh);
  const pagePart = pageStream && pageGlyphMesh ? prepared(pageStream, PAGE_BUCKET, pageGlyphMesh) : null;

  // Filter regions act on the document's objects only (the course part is never filtered, §4.11) —
  // the effective document's (§5.2 "Patch").
  const filter = layer.regions.length ? effectiveFilter(state, layer.regions, !!fastFilter, warnings) : null;

  const um = (v: number) => v / 1000;
  const reply: CourseReply = {
    type: "course", generation: msg.generation, part, colours, derivation: layer.derivation, warnings, filter, pagePart, page,
    hit: { stream: sym.stream, refs: layer.objects.map((o) => o.ref) },
    metrics: {
      circleRadiusMm: um(set.circleRadiusUm), finishRadiusMm: um(set.finishRadiusUm), startRadiusMm: um(set.startRadiusUm),
      lineWidthMm: um(set.lineWidthUm), digitHeightMm: um(set.digitHeightUm),
    },
    ...(grown ? { atlas: grown } : {}),
  };
  const transfer = part ? partTransferables(part) : [];
  if (pagePart) transfer.push(...partTransferables(pagePart));
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
