/**
 * WebGL2 backend, main-thread controller: the worker client, residency
 * (zoom gate, prefetch, LRU eviction under the budget) and the visible
 * set. The renderer stays dumb — it uploads what it is given and draws
 * the visible set; this class decides what that is
 * (docs/map-rendering.md §5.2 "Arena and buckets", "Worker").
 *
 *   setView(view)  → which cells are drawn; request missing detail; evict
 *   setCourse(req) → the dynamic bucket: the course layer, re-symbolised in the worker (§5.2 "Dynamic bucket")
 *   setPatch(p)    → the effective document: hidden ids, the touched buckets re-prepared (§5.2 "Patch")
 *   render(opts)   → rebuild the visible set if the drawn set changed; draw
 *
 * B4's `VectorMapLayer` drives the same two calls from its viewport.
 */

import {
  aboveZoomGate, BucketLru, buildVisibleSet, CLUB_BUDGET_BYTES, DRAW_MARGIN_CELLS, filterEntryKey, PREFETCH_MARGIN_CELLS, visibleCells,
  type PreparedPart, type ResidentPart, type ViewRect, type VisibleFilter,
} from "./buckets.js";
import type { mapDocument, render as R } from "@oxygen/shared";
import type { DocumentRenderOptions, FrameStats, InsetBox, MapGlRenderer, TextAtlasImage } from "./renderer.js";
import type { RenderTarget } from "./view.js";
import {
  createMapGlWorker, messageChannelScheduler,
  type CourseLayerRequest, type CourseReply, type FilterReply, type LoadRequest, type LoadSummary, type PatchedReply, type PatchState, type WorkerReply, type WorkerRequest,
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
export type CourseInfo = Pick<CourseReply, "colours" | "derivation" | "metrics" | "warnings" | "hit">;

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

interface PatchWaiter {
  resolve: (s: PatchState) => void;
  reject: (e: Error) => void;
}

const BASE = (id: number) => `b${id}`;
const DETAIL = (id: number) => `d${id}`;
const LARGE = "L";
const COURSE = "C";
const PAGE = "P";

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
  /** Layout mode's page part (docs/course-layout.md §1): drawn after every map colour; the map clipped to its frame. */
  private page: ResidentPart | undefined;
  private pageClip: DocumentRenderOptions["pageClip"];
  /** The last `setCourse` input (`undefined`: never set), re-sent after a load. */
  private courseInput: CourseLayerRequest | null | undefined;
  private courseGeneration = 0;
  /**
   * The generation the worker is deriving (`undefined`: none). One course request is in flight at a
   * time: a drag's pointer moves would otherwise queue a full derivation each, all run to completion
   * (docs/bugfix-course-drag-redraw.md).
   */
  private courseInFlight: number | undefined;
  /** A `setCourse` came while one was in flight: `courseInput` is posted when its reply is in. */
  private courseWaiting = false;
  private loadPosted = false;
  private atlasBytes = 0;
  /** The patch to draw (`undefined`: never set; sent with a document load). */
  private patch: mapDocument.MapPatch | null | undefined;
  /** Objects the patch hides (effective `objectIndex`), joined with `setHidden`'s for the visible set. */
  private patchHidden: ReadonlySet<number> = new Set();
  private patchGeneration = 0;
  /** As the course: one patch request in flight, the latest input waiting for its reply. */
  private patchInFlight: number | undefined;
  private patchWaiting = false;
  private patchWaiters: PatchWaiter[] = [];
  private inFlightWaiters: PatchWaiter[] = [];
  private loadPatchWaiters: PatchWaiter[] = [];
  /** What the worker drew of the patch last (the load's or the latest reply's). */
  patchState: PatchState | undefined;
  /** Called when something arrived that changes the picture (a detail part for a drawn cell, a course layer). */
  onChange: (() => void) | undefined;
  /**
   * Called with each course reply the engine draws: the latest posted generation's. While one is in
   * flight, newer inputs wait and only the last is posted after its reply, so a drag redraws at the
   * rate the worker derives (one in flight, latest wins).
   */
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
    // The patch goes with the document (§5.2 "Patch"): the first frame is the effective document.
    if (msg.source.kind === "document" && this.patch !== undefined) msg.source = { ...msg.source, patch: this.patch };
    this.loadPatchWaiters.push(...this.patchWaiters);
    this.patchWaiters = [];
    this.patchWaiting = false;
    return new Promise((resolve, reject) => {
      this.loadWaiter = { resolve, reject };
      this.transport.post(msg, transfer);
      this.loadPosted = true;
      this.courseColours = undefined;
      // Sent at once, in flight or not: a reply to a request before this load answers the old document and is dropped.
      if (this.courseInput !== undefined) this.postCourse();
    });
  }

  /**
   * Shows (or with `null` clears) the course layer (§5.2 "Dynamic bucket"): the worker symbolises it
   * and prepares one part; the reply replaces the resident one and the next `render` rebuilds the
   * visible set at once. One request is in flight at a time: an input made meanwhile (`null`
   * included) waits, replaced by any newer one, and the last is posted when the reply is in. Only
   * the latest posted generation's reply is used. Before `load`, the input waits and is posted right
   * after the load message.
   */
  setCourse(input: CourseLayerRequest | null): void {
    this.courseInput = input;
    if (!this.loadPosted) return;
    if (this.courseInFlight !== undefined) this.courseWaiting = true;
    else this.postCourse();
  }

  private postCourse(): void {
    this.courseWaiting = false;
    this.courseInFlight = ++this.courseGeneration;
    this.transport.post({ type: "course", generation: this.courseInFlight, input: this.courseInput ?? null }, []);
  }

  /** The request in flight is answered (or failed): post the input that waited for it, if any. */
  private courseDone(): void {
    this.courseInFlight = undefined;
    if (this.courseWaiting) this.postCourse();
  }

  /**
   * Draws the document with `patch` applied (§5.2 "Patch"; `null` none): no reload — the worker
   * hides through the range table and re-prepares only the buckets the change touches. Before the
   * load it goes with the load message. As `setCourse`, one request is in flight at a time and the
   * latest input waits for its reply. Resolves with what the worker drew of the patch once a reply
   * covering this input is applied; rejects if that request failed.
   */
  setPatch(patch: mapDocument.MapPatch | null): Promise<PatchState> {
    this.patch = patch;
    return new Promise((resolve, reject) => {
      this.patchWaiters.push({ resolve, reject });
      if (!this.loadPosted) return;
      if (this.patchInFlight !== undefined) this.patchWaiting = true;
      else this.postPatch();
    });
  }

  private postPatch(): void {
    this.patchWaiting = false;
    this.patchInFlight = ++this.patchGeneration;
    this.inFlightWaiters.push(...this.patchWaiters);
    this.patchWaiters = [];
    this.transport.post({ type: "patch", generation: this.patchInFlight, patch: this.patch ?? null, detail: [...this.detail.keys()] }, []);
  }

  private patchDone(): void {
    this.patchInFlight = undefined;
    if (this.patchWaiting) this.postPatch();
  }

  /**
   * A patch reply (§5.2 "Patch"): the touched buckets' parts replaced — a touched cell's resident
   * detail swapped for the fresh one in the same reply, or dropped and asked for again — and the
   * hidden set taken. Replies are deltas, so each is applied in order. The course is asked again:
   * its cuts and filter read the effective document.
   */
  private acceptPatched(m: PatchedReply): void {
    const s = this.summary;
    if (!s) return;
    if (m.atlas) {
      this.renderer.setAtlas(m.atlas);
      this.atlasBytes = m.atlas.data.byteLength;
    }
    for (const id of m.touched) {
      if (id === s.largeId) continue;
      if (this.base.delete(id)) this.renderer.releasePart(BASE(id));
      if (this.detail.delete(id)) {
        this.renderer.releasePart(DETAIL(id));
        this.lru.remove(id);
      }
    }
    for (const p of m.base) this.base.set(p.bucket, this.renderer.uploadPart(BASE(p.bucket), p));
    for (const p of m.detail) {
      this.detail.set(p.bucket, this.renderer.uploadPart(DETAIL(p.bucket), p));
      this.lru.add(p.bucket, p.gpuBytes);
      this.pending.delete(p.bucket);
    }
    if (m.large !== undefined) {
      this.renderer.releasePart(LARGE);
      this.large = m.large ? this.renderer.uploadPart(LARGE, m.large) : undefined;
    }
    this.detailCells = new Set(m.detailCells);
    this.summary = { ...s, detailCells: m.detailCells, bytes: { ...s.bytes, base: m.bytes.base, large: m.bytes.large, atlas: this.atlasBytes } };
    this.patchHidden = new Set(m.patch.hidden);
    this.patchState = m.patch;
    this.updateFixedBytes();
    this.dirty = true;
    this.arrivalOnly = false;
    // A touched cell whose detail is not resident now is asked for again.
    this.lastRequest = "\u0000";
    if (this.view) this.setView(this.view);
    else this.evict();
    if (this.courseInput && s.courseLayer?.supported) this.setCourse(this.courseInput);
    const ws = this.inFlightWaiters;
    this.inFlightWaiters = [];
    for (const w of ws) w.resolve(m.patch);
    this.onChange?.();
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
    this.renderer.releasePart(PAGE);
    this.page = m.pagePart ? this.renderer.uploadPart(PAGE, m.pagePart) : undefined;
    this.pageClip = m.page ? { fromColour: m.page.colourBase, ringUm: m.page.frameRingUm } : undefined;
    this.courseColours = m.colours.length ? m.colours : undefined;
    this.filter = engineFilter(m.filter);
    this.updateFixedBytes();
    this.dirty = true;
    this.arrivalOnly = false;
    this.evict();
    this.onCourse?.({ colours: m.colours, derivation: m.derivation, metrics: m.metrics, warnings: m.warnings, hit: m.hit });
    this.onChange?.();
  }

  private updateFixedBytes(): void {
    const s = this.summary;
    if (!s) return;
    this.fixedBytes = s.bytes.base + s.bytes.large + this.atlasBytes + this.renderer.textAtlasBytes + (this.course?.part.gpuBytes ?? 0) + (this.page?.part.gpuBytes ?? 0);
    this.lru.fixedBytes = this.fixedBytes;
  }

  private receive(m: WorkerReply): void {
    if (m.type === "error" && m.patch !== undefined) {
      // A patch request that threw ends that request only (as a course error, F20b).
      if (m.patch === this.patchInFlight) {
        const ws = this.inFlightWaiters;
        this.inFlightWaiters = [];
        for (const w of ws) w.reject(new Error(m.message));
        this.patchDone();
      }
      return;
    }
    if (m.type === "patched") {
      if (m.generation !== this.patchInFlight) return;
      this.acceptPatched(m);
      this.patchDone();
      return;
    }
    if (m.type === "error") {
      // A course request that threw names its generation (F20b): it ends that request only — a stale one
      // (overtaken by a load's re-send) ends nothing — and never a load in flight.
      if (m.generation !== undefined) {
        if (m.generation === this.courseInFlight) this.courseDone();
        return;
      }
      this.loadWaiter?.reject(new Error(m.message));
      this.loadWaiter = undefined;
      for (const w of this.loadPatchWaiters.splice(0)) w.reject(new Error(m.message));
      // A worker error without a generation (`onerror`, a failed load) may be the course request's own:
      // never leave the waiting input stuck behind a reply that will not come. A late reply is then stale.
      if (this.courseInFlight !== undefined) this.courseDone();
      return;
    }
    if (m.type === "course") {
      // Not the one in flight: overtaken by a load's re-send, or by an error that ended it.
      if (m.generation !== this.courseInFlight) return;
      this.acceptCourse(m);
      this.courseDone();
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
      this.patchHidden = new Set(s.patch?.hidden ?? []);
      this.patchState = s.patch;
      for (const w of this.loadPatchWaiters.splice(0)) {
        if (s.patch) w.resolve(s.patch);
        else w.reject(new Error("a patch needs a document source"));
      }
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

  /** Hides objects (effective `objectIndex`, §5.2 "Object identity"): their ranges are skipped in the visible set (04 §7). */
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
      // The page's colours sort after every map colour: the page layer draws over the map, as in the PDF.
      if (this.page) parts.push(this.page);
      const f = this.filter;
      const extra = [...(f?.hidden ?? []), ...this.patchHidden];
      const hidden = extra.length ? new Set([...this.hidden, ...extra]) : this.hidden;
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
    const stats = this.renderer.renderDocument(view, this.pageClip ? { ...opts, pageClip: this.pageClip } : opts, target);
    stats.cpuMs = performance.now() - t0;
    return stats;
  }

  /**
   * The editor's loupe (docs/map-rendering.md §5.5 "Loupe"), after `render` in the same frame:
   * draws the visible set `render` last built once more with `view` (`loupeView`) into the
   * renderer's inset target and composites it into the circle of `box` on the canvas. No cell
   * selection, no worker request, no rebuild: the loupe shows what is resident.
   */
  renderInset(view: ViewRect, opts: DocumentRenderOptions, box: InsetBox): FrameStats {
    if (!this.view || !this.summary) return { drawCalls: 0, cpuMs: 0 };
    const t0 = performance.now();
    const target = this.renderer.insetTarget(box.size);
    const stats = this.renderer.renderDocument(view, this.pageClip ? { ...opts, pageClip: this.pageClip } : opts, target);
    this.renderer.compositeInset(box);
    stats.cpuMs = performance.now() - t0;
    return stats;
  }

  /** Frees the loupe's target once it is gone. */
  releaseInset(): void {
    this.renderer.releaseInset();
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
