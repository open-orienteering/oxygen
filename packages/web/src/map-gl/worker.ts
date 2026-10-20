/**
 * WebGL2 backend, worker side (04 §4.5, §10 point 6): everything but the
 * GL calls. A map document's bytes go in; the worker decodes, bridges,
 * symbolises, builds the mesh atlas, assigns buckets and prepares the
 * always-resident layers (every cell's fills and hatches, the large
 * bucket) at once, then prepares cells' detail on request. Typed arrays
 * go back as transferables.
 *
 * This module is the pure message handler, so it is unit-tested without
 * a Worker and can run inline on the main thread (`worker-client.ts`);
 * `worker-entry.ts` binds it to `self`.
 *
 * Protocol (docs/map-rendering.md §5.2 "Worker"):
 *   → load     { source: document bytes | objects + symbols, fonts }   ← loaded { summary, atlas, grid, base parts, large part }
 *   → prepare  { ids }   replaces the queue; ← part { part } per id, nearest first
 *   ← error    { message } (load failures; the queue stops)
 */

import { mapDocument, render } from "@oxygen/shared";
import { MeshAtlasBuilder, type MeshAtlas } from "./mesh-atlas.js";
import {
  aboveZoomGate, assignBuckets, fitView, partTransferables, prepareBucketPart, PREFETCH_MARGIN_CELLS, visibleCells,
  type Assignment, type Grid, type PrepareContext, type PreparedPart, type ViewRect,
} from "./buckets.js";

/** Flattening tolerance, paper µm (OCAD's own resolution). */
export const TOLERANCE_UM = 10;

export type LoadSource =
  | { kind: "document"; bytes: ArrayBuffer; options: mapDocument.DocumentRenderOptions }
  /** Dev-only S1 reader path: objects already converted on the main thread. */
  | { kind: "objects"; objects: render.RenderObject[]; symbols: render.RenderSymbol[] };

/** The view the caller will show first: given, or "fit the document into this canvas". */
export type FirstView = { kind: "view"; view: ViewRect } | { kind: "fit"; widthPx: number; heightPx: number; fill?: number };

export interface LoadRequest {
  type: "load";
  source: LoadSource;
  fonts: { family: render.FontFamily; bytes: ArrayBuffer }[];
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
}

export interface PrepareRequest {
  type: "prepare";
  /** Bucket ids whose detail layer is wanted, most urgent first; replaces any queued request. */
  ids: number[];
}

export type WorkerRequest = LoadRequest | PrepareRequest;

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
  warnings: Record<string, number>;
  /** The first view resolved (fit computed here when asked for) and the detail cells queued for it. */
  view?: ViewRect;
  queued: number[];
  ms: { decode: number; bridge: number; symbolise: number; atlas: number; assign: number; base: number; large: number };
  bytes: { base: number; large: number; atlas: number };
}

export interface LoadedReply {
  type: "loaded";
  summary: LoadSummary;
  atlas: MeshAtlas;
  base: PreparedPart[];
  large: PreparedPart | undefined;
}

export interface PartReply {
  type: "part";
  part: PreparedPart;
}

export interface ErrorReply {
  type: "error";
  message: string;
}

export type WorkerReply = LoadedReply | PartReply | ErrorReply;

export type Post = (msg: WorkerReply, transfer: ArrayBuffer[]) => void;

interface State {
  stream: render.PassStream;
  assignment: Assignment;
  ctx: PrepareContext;
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
  let objects: render.RenderObject[], symbols: render.RenderSymbol[];
  let bridge: mapDocument.DocumentRenderInput["stats"] | undefined;
  let tDecode = t0;
  if (msg.source.kind === "document") {
    const doc = mapDocument.decodeMapDocument(new Uint8Array(msg.source.bytes));
    tDecode = performance.now();
    const input = mapDocument.documentRenderInput(doc, msg.source.options);
    objects = input.objects;
    symbols = input.symbols;
    bridge = input.stats;
  } else {
    objects = msg.source.objects;
    symbols = msg.source.symbols;
  }
  const tBridge = performance.now();
  const { stream, warnings } = render.symbolise({ objects, symbols, fonts });
  const tSym = performance.now();

  // Atlas: every glyph part, every text glyph (font units, tolerance by size), halos stroked.
  const atlas = new MeshAtlasBuilder();
  const glyphMesh = new Map<string, number>();
  const glyphTol = Math.max(0.5, tol / 4);
  for (const m of stream.glyphTable) glyphMesh.set(`${m.glyphId}/${m.partIdx}`, atlas.glyph(m, glyphTol));
  const fontById = new Map<number, render.FontMetrics>();
  for (const ref of stream.fontTable) {
    const f = fonts.find((x) => x.family === ref.family);
    if (f) fontById.set(ref.fontId, f);
  }
  const textMesh = new Map<number, { meshes: Int32Array; scale: number }>();
  stream.passes.forEach((p, i) => {
    if (p.kind !== "text") return;
    const font = fontById.get(p.fontId);
    if (!font?.outline) return;
    const k = p.sizeUm / font.unitsPerEm;
    const ft = Math.max(1, Math.round(tol / k / 2));
    const halo = p.haloWidthUm ? p.haloWidthUm / k : undefined;
    const meshes = new Int32Array(p.glyphs.length);
    for (let g = 0; g < p.glyphs.length; g++) meshes[g] = atlas.text(font, p.fontId, p.glyphs[g], ft, halo) ?? -1;
    textMesh.set(i, { meshes, scale: k });
  });
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
  const ctx: PrepareContext = { toleranceUm: tol, originX, originY, meshes: built.meshes, glyphMesh, textMesh };

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
    objects: { total: objects.length, drawn, large: largeObjects },
    ...(bridge ? { bridge } : {}),
    warnings: warn,
    ms: {
      decode: r(tDecode - t0), bridge: r(tBridge - tDecode), symbolise: r(tSym - tBridge), atlas: r(tAtlas - tSym),
      assign: r(tAssign - tAtlas), base: r(tBase - tAssign), large: r(tLarge - tBase),
    },
    bytes: { base: base.reduce((n, p) => n + p.gpuBytes, 0), large: large?.gpuBytes ?? 0, atlas: built.data.byteLength },
  };
  const transfer: ArrayBuffer[] = [built.data.buffer as ArrayBuffer];
  for (const p of base) transfer.push(...partTransferables(p));
  if (large) transfer.push(...partTransferables(large));
  return { reply: { type: "loaded", summary, atlas: built, base, large }, transfer, next: { stream, assignment, ctx } };
}
