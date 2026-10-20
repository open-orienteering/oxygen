/**
 * WebGL2 backend, main-thread controller: the worker client, residency
 * (zoom gate, prefetch, LRU eviction under the budget) and the visible
 * set. The renderer stays dumb — it uploads what it is given and draws
 * the visible set; this class decides what that is
 * (docs/map-rendering.md §5.2 "Arena and buckets", "Worker").
 *
 *   setView(view)  → which cells are drawn; request missing detail; evict
 *   render(opts)   → rebuild the visible set if the drawn set changed; draw
 *
 * B4's `VectorMapLayer` drives the same two calls from its viewport.
 */

import {
  aboveZoomGate, BucketLru, buildVisibleSet, CLUB_BUDGET_BYTES, DRAW_MARGIN_CELLS, PREFETCH_MARGIN_CELLS, visibleCells,
  type PreparedPart, type ResidentPart, type ViewRect,
} from "./buckets.js";
import type { DocumentRenderOptions, FrameStats, MapGlRenderer } from "./renderer.js";
import { createMapGlWorker, messageChannelScheduler, type LoadRequest, type LoadSummary, type WorkerReply, type WorkerRequest } from "./worker.js";

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
  /** Bytes the budget counts: base + large + atlas + resident detail + visible-set buffers. */
  residentBytes: number;
  overBudget: boolean;
  evictions: number;
  rebuilds: number;
  lastRebuildMs: number;
  /** Worker preparation time per detail part, ms, in arrival order. */
  prepareMs: number[];
}

const BASE = (id: number) => `b${id}`;
const DETAIL = (id: number) => `d${id}`;
const LARGE = "L";

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
  private hidden: ReadonlySet<number> = new Set();
  private view: ViewRect | undefined;
  private loadWaiter: { resolve: (s: LoadSummary) => void; reject: (e: Error) => void } | undefined;
  private completeWaiters: (() => void)[] = [];
  private st = { evictions: 0, rebuilds: 0, lastRebuildMs: 0, prepareMs: [] as number[], overBudget: false };
  /** Called when something arrived that changes the picture (a detail part for a drawn cell). */
  onChange: (() => void) | undefined;

  constructor(renderer: MapGlRenderer, transport: Transport, opts: EngineOptions = {}) {
    this.renderer = renderer;
    this.transport = transport;
    this.opts = { budgetBytes: opts.budgetBytes ?? CLUB_BUDGET_BYTES, gate: opts.gate ?? true, prefetchMarginCells: opts.prefetchMarginCells ?? PREFETCH_MARGIN_CELLS };
    this.lru = new BucketLru(this.opts.budgetBytes);
    transport.onMessage = (m) => this.receive(m);
  }

  /** Loads a document in the worker; resolves when the always-resident layers are uploaded. */
  load(req: Omit<LoadRequest, "type">): Promise<LoadSummary> {
    const transfer: Transferable[] = req.fonts.map((f) => f.bytes);
    if (req.source.kind === "document") transfer.push(req.source.bytes);
    return new Promise((resolve, reject) => {
      this.loadWaiter = { resolve, reject };
      this.transport.post({ type: "load", ...req }, transfer);
    });
  }

  private receive(m: WorkerReply): void {
    if (m.type === "error") {
      this.loadWaiter?.reject(new Error(m.message));
      this.loadWaiter = undefined;
      return;
    }
    if (m.type === "loaded") {
      const s = m.summary;
      this.summary = s;
      this.renderer.setDocument(s.originX, s.originY, m.atlas);
      this.base.clear();
      this.detail.clear();
      this.pending.clear();
      this.lastRequest = "";
      this.lru = new BucketLru(this.opts.budgetBytes);
      for (const p of m.base) this.base.set(p.bucket, this.renderer.uploadPart(BASE(p.bucket), p));
      this.large = m.large ? this.renderer.uploadPart(LARGE, m.large) : undefined;
      this.detailCells = new Set(s.detailCells);
      this.fixedBytes = s.bytes.base + s.bytes.large + s.bytes.atlas;
      this.lru.fixedBytes = this.fixedBytes;
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
    this.st.prepareMs.push(part.ms);
    this.detail.set(id, this.renderer.uploadPart(DETAIL(id), part));
    this.lru.add(id, part.gpuBytes);
    const drawn = !this.gated && this.drawn.includes(id);
    if (drawn) this.dirty = true;
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
      const want = visibleCells(view, s.grid, this.opts.prefetchMarginCells).filter((id) => this.detailCells.has(id) && !this.detail.has(id));
      const key = want.join(",");
      if (key !== this.lastRequest) {
        this.lastRequest = key;
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
    const key = `${this.gated ? "g" : ""}${this.drawn.filter((id) => this.base.has(id) || this.detail.has(id)).sort((a, b) => a - b).join(",")}|${this.gated ? "" : this.drawn.filter((id) => this.detail.has(id)).length}`;
    if (key !== this.drawnKey) {
      this.drawnKey = key;
      this.dirty = true;
    }
    this.evict();
    this.checkComplete();
  }

  /** Hides objects (stream object indices): their ranges are skipped in the visible set (04 §7). */
  setHidden(objects: ReadonlySet<number>): void {
    this.hidden = objects;
    this.dirty = true;
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
    if (this.lastRequest && evict.length) this.lastRequest = ""; // an evicted prefetch cell may be wanted again
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

  /** Draws the current view; rebuilds the visible set first if the drawn set changed. */
  render(opts: DocumentRenderOptions): FrameStats {
    const view = this.view;
    if (!view || !this.summary) return { drawCalls: 0, cpuMs: 0 };
    const t0 = performance.now();
    if (this.dirty) {
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
      this.renderer.setVisibleSet(buildVisibleSet(parts, this.hidden));
      this.lru.fixedBytes = this.fixedBytes + this.renderer.documentBytes.visibleSet;
      this.dirty = false;
      this.st.rebuilds++;
      this.st.lastRebuildMs = performance.now() - t0;
    }
    const stats = this.renderer.renderDocument(view, opts);
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
      prepareMs: this.st.prepareMs.slice(),
    };
  }

  dispose(): void {
    this.transport.terminate();
  }
}
