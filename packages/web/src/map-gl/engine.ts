/**
 * WebGL2 backend, main-thread controller: the worker client, residency
 * (zoom gate, prefetch, LRU eviction under the budget) and the visible
 * set. The renderer stays dumb — it uploads what it is given and draws
 * the visible set; this class decides what that is
 * (docs/map-rendering.md §5.2 "Arena and buckets", "Worker").
 *
 *   setView(view)  → which cells are drawn; request missing detail; evict
 *   setCourse(req) → the dynamic bucket: the course layer, re-symbolised in the worker (§5.2 "Dynamic bucket")
 *   render(opts)   → rebuild the visible set if the drawn set changed; draw
 *
 * B4's `VectorMapLayer` drives the same two calls from its viewport.
 */

import {
  aboveZoomGate, BucketLru, buildVisibleSet, CLUB_BUDGET_BYTES, DRAW_MARGIN_CELLS, filterEntryKey, PREFETCH_MARGIN_CELLS, visibleCells,
  type PreparedPart, type ResidentPart, type ViewRect, type VisibleFilter,
} from "./buckets.js";
import type { render as R } from "@oxygen/shared";
import type { DocumentRenderOptions, FrameStats, MapGlRenderer, TextAtlasImage } from "./renderer.js";
import type { RenderTarget } from "./view.js";
import {
  createMapGlWorker, messageChannelScheduler,
  type CourseLayerRequest, type CourseReply, type FilterReply, type LoadRequest, type LoadSummary, type WorkerReply, type WorkerRequest,
} from "./worker.js";

/** Message transport to the worker: a real Web Worker, or the same handler inline. */
export interface Transport {
  post(msg: WorkerRequest, transfer: Transferable[]): void;
  onMessage: ((msg: WorkerReply) => void) | undefined;
  terminate(): void;
}

export function workerTransport(): Transport {
  const w = new Worker(new URL("./worker-entry.ts", import.meta.url), { type: "module" });
  const t: Transport = {
    post: (msg, transfer) => w.postMessage(msg, transfer),
    onMessage: undefined,
    terminate: () => w.terminate(),
  };
  w.onmessage = (e: MessageEvent<WorkerReply>) => t.onMessage?.(e.data);
  w.onerror = (e) => t.onMessage?.({ type: "error", message: e.message || "worker failed" });
  return t;
}

/** The worker's handler on this thread (tests, `?worker=0`). Messages are delivered as tasks, as across a worker. */
export function inlineTransport(): Transport {
  const t: Transport = { post: () => undefined, onMessage: undefined, terminate: () => undefined };
  const schedule = messageChannelScheduler();
  const handler = createMapGlWorker((msg) => schedule(() => t.onMessage?.(msg)), schedule);
  t.post = (msg) => schedule(() => handler.handle(msg));
  return t;
}

/** What `MapGlEngine.load` takes: the worker's load request, with the text atlas pages decoded for the renderer. */
export type EngineLoadRequest = Omit<LoadRequest, "type" | "gate" | "prefetchMarginCells" | "textAtlas"> & {
  /** Text atlas pages (`lib/map-fonts.ts` `loadTextAtlas`); without them no text is drawn. */
  textAtlas?: TextAtlasImage[];
};

/** What a course reply tells the host (the UI layer's geometry, the stack, warnings). */
export type CourseInfo = Pick<CourseReply, "colours" | "derivation" | "metrics" | "warnings">;

export interface EngineOptions {
  /** Resident GPU budget, bytes. Default 150 MB (club); B4 passes 30 MB for event maps. */
  budgetBytes?: number;
  /** Apply the zoom gate (default true); false prepares detail at every zoom (measurement only). */
  gate?: boolean;
  prefetchMarginCells?: number;
}

export interface EngineStats {
  /** Cells meeting the view + draw margin. */
  drawnCells: number;
  /** Of those with a detail layer: resident and drawn. */
  drawnDetail: number;
  /** Requested, not yet arrived. */
  pending: number;
  gated: boolean;
  residentDetail: number;
  /** Bytes the budget counts: base + large + mesh atlas + text atlas + resident detail + visible-set buffers. */
  residentBytes: number;
  overBudget: boolean;
  evictions: number;
  rebuilds: number;
  lastRebuildMs: number;
  /** Of that, building the arrays on the CPU (the rest is the upload). */
  lastBuildMs: number;
  /** Worker preparation time per detail part, ms, in arrival order. */
  prepareMs: number[];
}

/**
 * While detail parts stream in, the visible set is rebuilt at most this
 * often for arrivals alone (a change of the drawn set rebuilds at once):
 * a rebuild is linear in the indices in view, tens of ms for a whole club map.
 */
export const ARRIVAL_REBUILD_MS = 150;

const BASE = (id: number) => `b${id}`;
const DETAIL = (id: number) => `d${id}`;
const LARGE = "L";
const COURSE = "C";

/** A worker filter reply as the visible set takes it. */
function engineFilter(f: FilterReply | null): { hidden: ReadonlySet<number>; visible: VisibleFilter } | undefined {
  if (!f) return undefined;
  const entryMask = new Map<number, number>();
  for (let i = 0; i < f.entries.length; i += 3) entryMask.set(filterEntryKey(f.entries[i], f.entries[i + 1]), f.entries[i + 2]);
  return { hidden: new Set(f.hidden), visible: { entryMask, positions: f.positions, indices: f.indices, masks: f.masks } };
}

export class MapGlEngine {
  private readonly renderer: MapGlRenderer;
  private readonly transport: Transport;
  private readonly opts: Required<EngineOptions>;
  summary: LoadSummary | undefined;
  private base = new Map<number, ResidentPart>();
  private detail = new Map<number, ResidentPart>();
  private large: ResidentPart | undefined;
  private detailCells = new Set<number>();
  private lru: BucketLru;
  private fixedBytes = 0;
  private pending = new Set<number>();
  private lastRequest = "";
  private drawn: number[] = [];
  private drawnKey = "";
  private gated = false;
  private dirty = true;
  /** Dirty only because detail arrived (may wait for ARRIVAL_REBUILD_MS). */
  private arrivalOnly = false;
  private lastRebuildAt = -Infinity;
  private holdTimer: ReturnType<typeof setTimeout> | undefined;
  private hidden: ReadonlySet<number> = new Set();
  /** Filter regions on the static buckets (§5.2 "Filter regions"): from the course reply, or a stream source's masks. */
  private filter: { hidden: ReadonlySet<number>; visible: VisibleFilter } | undefined;
  private view: ViewRect | undefined;
  private loadWaiter: { resolve: (s: LoadSummary) => void; reject: (e: Error) => void } | undefined;
  private completeWaiters: (() => void)[] = [];
  private st = { evictions: 0, rebuilds: 0, lastRebuildMs: 0, lastBuildMs: 0, prepareMs: [] as number[], overBudget: false };
  /** The dynamic bucket: resident whatever the zoom gate and the budget (counted as fixed bytes). */
  private course: ResidentPart | undefined;
  private courseColours: R.ColourStack | undefined;
  /** The last `setCourse` input (`undefined`: never set), re-sent after a load. */
  private courseInput: CourseLayerRequest | null | undefined;
  private courseGeneration = 0;
  private loadPosted = false;
  private atlasBytes = 0;
  /** Called when something arrived that changes the picture (a detail part for a drawn cell, a course layer). */
  onChange: (() => void) | undefined;
  /** Called with each current course reply (not with replies a newer `setCourse` overtook). */
  onCourse: ((info: CourseInfo) => void) | undefined;

  constructor(renderer: MapGlRenderer, transport: Transport, opts: EngineOptions = {}) {
    this.renderer = renderer;
    this.transport = transport;
    this.opts = { budgetBytes: opts.budgetBytes ?? CLUB_BUDGET_BYTES, gate: opts.gate ?? true, prefetchMarginCells: opts.prefetchMarginCells ?? PREFETCH_MARGIN_CELLS };
    this.lru = new BucketLru(this.opts.budgetBytes);
    transport.onMessage = (m) => this.receive(m);
  }

  /**
   * Loads a document in the worker; resolves when the always-resident layers are uploaded. Pass the
   * view you will show first (`firstView`) and draw `summary.view`: its detail is then already on
   * its way.
   */
  load(req: EngineLoadRequest): Promise<LoadSummary> {
    const transfer: Transferable[] = req.fonts.map((f) => f.bytes);
    if (req.source.kind === "document") transfer.push(req.source.bytes);
    // The renderer holds the page images, the worker resolves glyphs against the same pages in the same order.
    const { textAtlas, ...rest } = req;
    this.renderer.setTextAtlas(textAtlas ?? []);
    const msg: LoadRequest = { type: "load", ...rest, gate: this.opts.gate, prefetchMarginCells: this.opts.prefetchMarginCells };
    if (textAtlas?.length) msg.textAtlas = textAtlas.map((t) => t.page);
    return new Promise((resolve, reject) => {
      this.loadWaiter = { resolve, reject };
      this.transport.post(msg, transfer);
      this.loadPosted = true;
      this.courseColours = undefined;
      if (this.courseInput !== undefined) this.postCourse();
    });
  }

  /**
   * Shows (or with `null` clears) the course layer (§5.2 "Dynamic bucket"): the worker symbolises it
   * and prepares one part; the reply replaces the resident one and the next `render` rebuilds the
   * visible set at once. Only the latest request's reply is used. Before `load`, the request waits.
   */
  setCourse(input: CourseLayerRequest | null): void {
    this.courseInput = input;
    if (this.loadPosted) this.postCourse();
  }

  private postCourse(): void {
    this.transport.post({ type: "course", generation: ++this.courseGeneration, input: this.courseInput ?? null }, []);
  }

  /** The stack to draw with: the course reply's (layout-object rows on top) once one arrived, else the load's. */
  get colours(): R.ColourStack {
    return this.courseColours ?? this.summary?.colourStack ?? [];
  }

  private acceptCourse(m: CourseReply): void {
    if (m.generation !== this.courseGeneration || !this.summary) return;
    if (m.atlas) {
      this.renderer.setAtlas(m.atlas);
      this.atlasBytes = m.atlas.data.byteLength;
    }
    this.renderer.releasePart(COURSE);
    this.course = m.part ? this.renderer.uploadPart(COURSE, m.part) : undefined;
    this.courseColours = m.colours.length ? m.colours : undefined;
    this.filter = engineFilter(m.filter);
    this.updateFixedBytes();
    this.dirty = true;
    this.arrivalOnly = false;
    this.evict();
    this.onCourse?.({ colours: m.colours, derivation: m.derivation, metrics: m.metrics, warnings: m.warnings });
    this.onChange?.();
  }

  private updateFixedBytes(): void {
    const s = this.summary;
    if (!s) return;
    this.fixedBytes = s.bytes.base + s.bytes.large + this.atlasBytes + this.renderer.textAtlasBytes + (this.course?.part.gpuBytes ?? 0);
    this.lru.fixedBytes = this.fixedBytes;
  }

  private receive(m: WorkerReply): void {
    if (m.type === "error") {
      this.loadWaiter?.reject(new Error(m.message));
      this.loadWaiter = undefined;
      return;
    }
    if (m.type === "course") {
      this.acceptCourse(m);
      return;
    }
    if (m.type === "loaded") {
      const s = m.summary;
      this.summary = s;
      this.renderer.setDocument(s.originX, s.originY, m.atlas);
      this.base.clear();
      this.detail.clear();
      // What the worker queued for the first view is pending; the same view does not re-send it.
      this.pending = new Set(s.queued);
      this.lastRequest = s.queued.join(",");
      this.lru = new BucketLru(this.opts.budgetBytes);
      for (const p of m.base) this.base.set(p.bucket, this.renderer.uploadPart(BASE(p.bucket), p));
      this.large = m.large ? this.renderer.uploadPart(LARGE, m.large) : undefined;
      this.detailCells = new Set(s.detailCells);
      // `setDocument` dropped every part; a course request posted after the load replies after this.
      this.course = undefined;
      this.filter = engineFilter(m.filter ?? null);
      this.atlasBytes = s.bytes.atlas;
      this.updateFixedBytes();
      this.dirty = true;
      this.drawnKey = "";
      this.loadWaiter?.resolve(s);
      this.loadWaiter = undefined;
      if (this.view) this.setView(this.view);
      return;
    }
    this.acceptPart(m.part);
  }

  private acceptPart(part: PreparedPart): void {
    const id = part.bucket;
    this.pending.delete(id);
    // A part requested twice (a re-sent want list overtaking one in flight) is already resident:
    // keep the uploaded one, so the visible set never points at a released range.
    if (this.detail.has(id)) return;
    this.st.prepareMs.push(part.ms);
    this.detail.set(id, this.renderer.uploadPart(DETAIL(id), part));
    this.lru.add(id, part.gpuBytes);
    const drawn = !this.gated && this.drawn.includes(id);
    if (drawn && !this.dirty) {
      this.dirty = true;
      this.arrivalOnly = true;
    }
    this.evict();
    if (drawn) this.onChange?.();
    this.checkComplete();
  }

  /** Updates the drawn set for a view; requests what is missing, evicts what does not fit. */
  setView(view: ViewRect): void {
    this.view = view;
    const s = this.summary;
    if (!s) return;
    this.gated = this.opts.gate && !aboveZoomGate(view.pxPerUm);
    this.drawn = visibleCells(view, s.grid, DRAW_MARGIN_CELLS);
    if (!this.gated) {
      // The request is keyed by the view's wanted cells, resident or not: the same view never re-sends,
      // even after the budget evicted part of what it asked for.
      const wanted = visibleCells(view, s.grid, this.opts.prefetchMarginCells).filter((id) => this.detailCells.has(id));
      const key = wanted.join(",");
      if (key !== this.lastRequest) {
        this.lastRequest = key;
        const want = wanted.filter((id) => !this.detail.has(id));
        for (const id of want) this.pending.add(id);
        // The worker replaces its queue; what was pending but is no longer wanted will not arrive.
        for (const id of [...this.pending]) if (!want.includes(id)) this.pending.delete(id);
        this.transport.post({ type: "prepare", ids: want }, []);
      }
      this.lru.touch(this.drawn);
    } else if (this.lastRequest !== "") {
      this.lastRequest = "";
      this.pending.clear();
      this.transport.post({ type: "prepare", ids: [] }, []);
    }
    // Arrivals and evictions mark the set dirty themselves; this key is the view's part.
    const key = `${this.gated ? "g" : ""}${[...this.drawn].sort((a, b) => a - b).join(",")}`;
    if (key !== this.drawnKey) {
      this.drawnKey = key;
      this.dirty = true;
      this.arrivalOnly = false;
    }
    this.evict();
    this.checkComplete();
  }

  /** Hides objects (stream object indices): their ranges are skipped in the visible set (04 §7). */
  setHidden(objects: ReadonlySet<number>): void {
    this.hidden = objects;
    this.dirty = true;
    this.arrivalOnly = false;
  }

  private evict(): void {
    const protect = new Set(this.gated ? [] : this.drawn);
    const { evict, over } = this.lru.evictions(protect);
    for (const id of evict) {
      this.renderer.releasePart(DETAIL(id));
      this.detail.delete(id);
      this.lru.remove(id);
      this.st.evictions++;
    }
    // `lastRequest` is kept: re-sending the same want list after evicting part of it would re-prepare
    // the ring the budget just refused, without end. A view change sends a fresh list.
    this.st.overBudget = over;
  }

  /** Resolves once every drawn cell's detail is resident (immediately when gated). */
  whenComplete(): Promise<void> {
    return new Promise((resolve) => {
      this.completeWaiters.push(resolve);
      this.checkComplete();
    });
  }

  private isComplete(): boolean {
    if (!this.summary) return false;
    if (this.gated) return true;
    return this.drawn.every((id) => !this.detailCells.has(id) || this.detail.has(id));
  }

  private checkComplete(): void {
    if (!this.completeWaiters.length || !this.isComplete()) return;
    const ws = this.completeWaiters;
    this.completeWaiters = [];
    for (const w of ws) w();
  }

  /** Draws the current view into `target` (default the canvas); rebuilds the visible set first if the drawn set changed. */
  render(opts: DocumentRenderOptions, target?: RenderTarget): FrameStats {
    const view = this.view;
    if (!view || !this.summary) return { drawCalls: 0, cpuMs: 0 };
    const t0 = performance.now();
    // Arrivals are coalesced while more drawn detail is pending; the last one always rebuilds.
    const hold = this.dirty && this.arrivalOnly && !this.isComplete() && t0 - this.lastRebuildAt < ARRIVAL_REBUILD_MS;
    if (hold && !this.holdTimer) {
      this.holdTimer = setTimeout(() => {
        this.holdTimer = undefined;
        this.onChange?.();
      }, ARRIVAL_REBUILD_MS - (t0 - this.lastRebuildAt));
    }
    if (this.dirty && !hold) {
      const parts: ResidentPart[] = [];
      for (const id of [...this.drawn].sort((a, b) => a - b)) {
        const b = this.base.get(id);
        if (b) parts.push(b);
        if (!this.gated) {
          const d = this.detail.get(id);
          if (d) parts.push(d);
        }
      }
      if (this.large) parts.push(this.large);
      // Last: within a colour the course draws over the map's own objects of that colour.
      if (this.course) parts.push(this.course);
      const f = this.filter;
      const hidden = f && f.hidden.size ? new Set([...this.hidden, ...f.hidden]) : this.hidden;
      const vs = buildVisibleSet(parts, hidden, f?.visible);
      this.st.lastBuildMs = performance.now() - t0;
      this.renderer.setVisibleSet(vs);
      this.lru.fixedBytes = this.fixedBytes + this.renderer.documentBytes.visibleSet;
      this.dirty = false;
      this.arrivalOnly = false;
      this.lastRebuildAt = performance.now();
      this.st.rebuilds++;
      this.st.lastRebuildMs = performance.now() - t0;
    }
    const stats = this.renderer.renderDocument(view, opts, target);
    stats.cpuMs = performance.now() - t0;
    return stats;
  }

  stats(): EngineStats {
    return {
      drawnCells: this.drawn.length,
      drawnDetail: this.gated ? 0 : this.drawn.filter((id) => this.detail.has(id)).length,
      pending: this.pending.size,
      gated: this.gated,
      residentDetail: this.detail.size,
      residentBytes: this.lru.totalBytes,
      overBudget: this.st.overBudget,
      evictions: this.st.evictions,
      rebuilds: this.st.rebuilds,
      lastRebuildMs: this.st.lastRebuildMs,
      lastBuildMs: this.st.lastBuildMs,
      prepareMs: this.st.prepareMs.slice(),
    };
  }

  dispose(): void {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.transport.terminate();
  }
}
