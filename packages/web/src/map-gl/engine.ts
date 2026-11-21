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
 *   hitDocument(…) → the document's objects under a paper point (§5.5 "Document objects")
 *   setEdit(input) → the edit part: the selection highlighted, a draft drawn, its static copies hidden
 *   render(opts)   → rebuild the visible set if the drawn set changed; draw
 *   setTerrain(f)  → a height field for 3D (§5.6): prepared in the worker, uploaded here
 *   renderTerrain(frame, opts) → the 3D frame: the map rendered into the drape layers over the
 *                    camera's footprint when the camera settles or the content changes, then the mesh
 *
 * B4's `VectorMapLayer` drives the same two calls from its viewport.
 */

import {
  aboveZoomGate, BucketLru, buildVisibleSet, CLUB_BUDGET_BYTES, DRAW_MARGIN_CELLS, filterEntryKey, PREFETCH_MARGIN_CELLS, visibleCells,
  type ImageDraw, type PreparedPart, type ResidentPart, type ViewRect, type VisibleFilter,
} from "./buckets.js";
import type { GraphicTextures } from "../lib/graphic-textures.js";
import type { mapDocument, render as R } from "@oxygen/shared";
import type { DocumentRenderOptions, FrameStats, InsetBox, MapGlRenderer, TextAtlasImage } from "./renderer.js";
import { viewMatrix, type RenderTarget } from "./view.js";
import type { HeightField } from "@oxygen/shared/src/terrain/field/read.js";
import { DRAPE_MAX_SIDE, DRAPE_TEXEL_BYTES, drapeLayers, type DrapeLayer } from "./terrain/footprint.js";
import { meshBox, type TerrainMesh } from "./terrain/mesh.js";
import { fieldTextureBytes, type TerrainDrawStats } from "./terrain/program.js";
import type { TerrainCamera } from "./terrain/camera.js";
import type { LineDrawStats, TerrainLine } from "./terrain/lines.js";
import type { DrapeRenderStats } from "./renderer.js";
import {
  createMapGlWorker, messageChannelScheduler,
  HIGHLIGHT_COLOUR,
  type CourseLayerRequest, type CourseReply, type DocumentHit, type EditInput, type EditState, type FilterReply, type LoadRequest, type LoadSummary, type PatchedReply, type PatchState, type TerrainReply, type WorkerReply, type WorkerRequest,
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
  /** RGB (0–1) of the selection highlight (§5.5 "Document objects"). Default `#2563eb`, the editor's selection blue. */
  highlight?: [number, number, number];
}

/** The selection highlight's default: `#2563eb`. */
export const DEFAULT_HIGHLIGHT: [number, number, number] = [0x25 / 255, 0x63 / 255, 0xeb / 255];

/** What an edit reply tells the host: which selected refs are drawn and the draft's issues. */
export type EditInfo = Pick<EditState, "selected" | "highlighted" | "issues">;

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
  /** With a height field (§5.6 "Engine API"). */
  terrain?: TerrainStats;
  /** Image textures (J6): decoded bytes the loader holds (its own budget, not in `residentBytes`) and requests in flight. */
  graphicBytes: number;
  graphicsPending: number;
}

/** The 3D side of `stats()` (§5.6 "Measurements (H6)"). */
export interface TerrainStats {
  /** Height and normal textures. */
  fieldBytes: number;
  /** The drape layers' textures with their mip chains. */
  drapeBytes: number;
  /** The tile target (not in the budget, as the canvas's own buffers are not). */
  scratchBytes: number;
  /** The drape layers drawn, priority order; `ratio` = texel density / the layer's need (`DrapeLayer.needPxPerUm`: the nearest point's for the near or only layer, the split depth's for the far one). */
  layers: { role: DrapeLayer["role"]; widthPx: number; heightPx: number; pxPerUm: number; ratio: number }[];
  drapeRenders: number;
  /** The last drape re-render: visible-set rebuild + tiles + mip chains, ms; its draws and tiles. */
  lastDrapeMs: number;
  lastDrapeDraws: number;
  lastDrapeTiles: number;
  /** The worker's preparation of the field, ms. */
  prepareMs?: { fill: number; normals: number };
  /** `setField` on this thread (the mesh's assembly and the two texture uploads), ms. */
  uploadMs?: number;
}

/** What `renderTerrain` takes: the camera and how the mesh is drawn (the drape is the engine's). */
export interface EngineTerrainFrame {
  camera: TerrainCamera;
  /** Vertical exaggeration; no default (§5.6 decision 2). */
  exaggeration: number;
  lodPx?: number;
  level?: number;
  /** Lines drawn on the terrain after the mesh (§5.6 "Lines", H8); not part of the drape. */
  lines?: readonly TerrainLine[];
  /** Device px per CSS px for the lines' widths (default 1). */
  pxRatio?: number;
}

export interface TerrainFrameStats {
  /** The mesh draw (null: no field, or no document); `lines` when lines were drawn. */
  mesh: (TerrainDrawStats & FrameStats & { lines?: LineDrawStats }) | null;
  /** Set when this frame re-rendered the drape. */
  drape?: DrapeRenderStats & { layers: number };
  /** JS time of the whole frame, ms. */
  cpuMs: number;
  /** Graphics still loading or waiting (J6), as `EngineStats.graphicsPending`. */
  imagesPending?: number;
}

/**
 * While detail parts stream in, the visible set is rebuilt at most this
 * often for arrivals alone (a change of the drawn set rebuilds at once):
 * a rebuild is linear in the indices in view, tens of ms for a whole club map.
 */
export const ARRIVAL_REBUILD_MS = 150;

/**
 * The camera has settled when it has not changed for this long (§5.6 "Settling"): the drape is then
 * re-rendered over the new footprint. A timer calls `onChange` so the host draws that frame.
 */
export const DRAPE_SETTLE_MS = 150;

/**
 * While detail streams in, arrivals alone re-render the drape at most every `DRAPE_ARRIVAL_MS`, or
 * `DRAPE_ARRIVAL_FACTOR` × the last re-render's JS time where that is longer; the last arrival always
 * does (§5.6 "Settling"). A club map's drape takes 100–250 ms to render on a laptop.
 */
export const DRAPE_ARRIVAL_MS = 500;
export const DRAPE_ARRIVAL_FACTOR = 4;

/** The drape layers' share of the residency budget (§5.6 decision 5). */
export const DRAPE_BUDGET_SHARE = 1 / 3;

const viewKey = (v: ViewRect) => `${v.centreX},${v.centreY},${v.pxPerUm},${v.widthPx},${v.heightPx},${v.rotationDeg ?? 0}`;

interface PatchWaiter {
  resolve: (s: PatchState) => void;
  reject: (e: Error) => void;
}

const BASE = (id: number) => `b${id}`;
const DETAIL = (id: number) => `d${id}`;
const LARGE = "L";
const COURSE = "C";
const PAGE = "P";
const EDIT = "E";

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
  /** Of the drawn cells, those whose detail is drawn (none when every view is gated). */
  private detailDrawn = new Set<number>();
  private drawnKey = "";
  private gated = false;
  /** Which frame the drawn set was selected for: the 2D view, or the drape layers. */
  private selection: "2d" | "3d" = "2d";
  /** The height field drawn (§5.6), the pair of `mesh`: kept for H7's pick. */
  private field: HeightField | null = null;
  /** The field of the `setTerrain` in flight: becomes `field` with its mesh, so the two always match. */
  private pendingField: HeightField | null = null;
  private mesh: TerrainMesh | null = null;
  private terrainGeneration = 0;
  private terrainWaiter: { generation: number; resolve: (m: TerrainMesh | null) => void; reject: (e: Error) => void } | undefined;
  private terrainPrepareMs: TerrainStats["prepareMs"];
  private terrainUploadMs: number | undefined;
  /** The drape layers last rendered (priority order) and the views they were selected for. */
  private drapeLayersDrawn: DrapeLayer[] = [];
  private drapeKey = "";
  private drapeStale = true;
  private cameraKey = "";
  private lastMoveAt = -Infinity;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private drapeSt = { renders: 0, lastMs: 0, lastDraws: 0, lastTiles: 0 };
  private lastDrapeAt = -Infinity;
  private arrivalTimer: ReturnType<typeof setTimeout> | undefined;
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
   * (docs/bugfixes/course-drag-redraw.md).
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
  /** The edit part (§5.5 "Document objects"), and the static copies its draft hides. */
  private edit: ResidentPart | undefined;
  private editHidden: ReadonlySet<number> = new Set();
  private editInput: EditInput | null | undefined;
  private editGeneration = 0;
  private editInFlight: number | undefined;
  private editWaiting = false;
  private hitId = 0;
  private hits = new Map<number, { resolve: (h: DocumentHit[]) => void; reject: (e: Error) => void }>();
  /** The latest edit state drawn. */
  editState: EditInfo | undefined;
  /** Called with each edit state the engine draws (an edit reply, or a patch reply's). */
  onEdit: ((info: EditInfo) => void) | undefined;
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
    this.opts = {
      budgetBytes: opts.budgetBytes ?? CLUB_BUDGET_BYTES, gate: opts.gate ?? true, prefetchMarginCells: opts.prefetchMarginCells ?? PREFETCH_MARGIN_CELLS,
      highlight: opts.highlight ?? DEFAULT_HIGHLIGHT,
    };
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
      if (this.editInput !== undefined) this.postEdit();
    });
  }

  /**
   * The effective document's objects under a paper point (µm), topmost first (§5.5 "Document
   * objects"); hits on objects the engine does not draw (`setHidden`'s, a filter region's, the
   * static copy of an object under edit) are dropped. Several may be in flight; before the load it
   * resolves `[]`, and a request the worker fails rejects only its own promise.
   */
  hitDocument(xUm: number, yUm: number, toleranceUm: number): Promise<DocumentHit[]> {
    if (!this.loadPosted) return Promise.resolve([]);
    const id = ++this.hitId;
    return new Promise((resolve, reject) => {
      this.hits.set(id, { resolve, reject });
      this.transport.post({ type: "hit", id, x: xUm, y: yUm, toleranceUm }, []);
    });
  }

  /**
   * Draws (or with `null` clears) the edit part (§5.5 "Document objects"): the selected objects
   * in the highlight colour, a draft in its own colours with its targets' static copies hidden.
   * As `setCourse`: one request in flight, the latest input next, posted after the load.
   */
  setEdit(input: EditInput | null): void {
    this.editInput = input;
    if (!this.loadPosted) return;
    if (this.editInFlight !== undefined) this.editWaiting = true;
    else this.postEdit();
  }

  private postEdit(): void {
    this.editWaiting = false;
    this.editInFlight = ++this.editGeneration;
    this.transport.post({ type: "edit", generation: this.editInFlight, input: this.editInput ?? null }, []);
  }

  private editDone(): void {
    this.editInFlight = undefined;
    if (this.editWaiting) this.postEdit();
  }

  /** An edit state (an edit reply's, or a patch reply's): the part replaced, its hidden ids taken. */
  private acceptEdit(e: EditState): void {
    if (e.atlas) {
      this.renderer.setAtlas(e.atlas);
      this.atlasBytes = e.atlas.data.byteLength;
    }
    this.renderer.releasePart(EDIT);
    this.edit = e.part ? this.renderer.uploadPart(EDIT, e.part) : undefined;
    this.editHidden = new Set(e.hidden);
    this.editState = { selected: e.selected, highlighted: e.highlighted, issues: e.issues };
    this.updateFixedBytes();
    this.dirty = true;
    this.arrivalOnly = false;
    this.evict();
    this.onEdit?.(this.editState);
  }

  /** The render options with the highlight's reserved colour index resolved. */
  private withHighlight(opts: DocumentRenderOptions): DocumentRenderOptions {
    const hl = this.opts.highlight;
    const colour = opts.colour;
    const g = this.graphics;
    return {
      ...opts,
      colour: (i) => (i === HIGHLIGHT_COLOUR ? hl : colour(i)),
      ...(this.pageClip ? { pageClip: this.pageClip } : {}),
      ...(g && !opts.graphic ? { graphic: (img: ImageDraw, pxPerUm: number) => g.get(img, pxPerUm) } : {}),
    };
  }

  private graphics: GraphicTextures | null = null;

  /**
   * The image textures (J6, §5.2 "Images"): each frame asks it for the textures of the images in
   * view; an arrival redraws (`onChange`), a texture it drops is freed on the GPU. The engine
   * disposes it with itself; `null` detaches (images draw as outlines).
   */
  setGraphics(g: GraphicTextures | null): void {
    if (this.graphics === g) return;
    if (this.graphics) {
      this.graphics.onChange = undefined;
      this.graphics.onRelease = undefined;
    }
    this.graphics = g;
    if (g) {
      // A texture arriving or freed changes the drape too (§5.2 "Images").
      g.onChange = () => {
        this.drapeStale = true;
        this.onChange?.();
      };
      g.onRelease = (b) => {
        this.drapeStale = true;
        this.renderer.releaseGraphic(b);
      };
    }
    this.onChange?.();
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
    // The edit part against the new effective document, in the same step (§5.5 "Document objects").
    if (m.edit) this.acceptEdit(m.edit);
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
    this.fixedBytes = s.bytes.base + s.bytes.large + this.atlasBytes + this.renderer.textAtlasBytes + (this.course?.part.gpuBytes ?? 0) + (this.page?.part.gpuBytes ?? 0) + (this.edit?.part.gpuBytes ?? 0) +
      this.fieldBytes() + (this.mesh ? this.renderer.drapeBytes : 0);
    this.lru.fixedBytes = this.fixedBytes;
  }

  private receive(m: WorkerReply): void {
    if (m.type === "terrain" || (m.type === "error" && m.terrain !== undefined)) {
      this.acceptTerrain(m);
      return;
    }
    if (m.type === "hit" || (m.type === "error" && m.hit !== undefined)) {
      const id = m.type === "hit" ? m.id : m.hit!;
      const w = this.hits.get(id);
      this.hits.delete(id);
      if (m.type === "error") w?.reject(new Error(m.message));
      else if (w) {
        // What is not drawn is not hit.
        const f = this.filter?.hidden;
        w.resolve(m.hits.filter((h) => !this.hidden.has(h.objectIndex) && !f?.has(h.objectIndex) && !this.editHidden.has(h.objectIndex)));
      }
      return;
    }
    if (m.type === "edit" || (m.type === "error" && m.edit !== undefined)) {
      const g = m.type === "edit" ? m.generation : m.edit!;
      // Not the one in flight: overtaken by a load's re-send, or ended by an error.
      if (g !== this.editInFlight) return;
      if (m.type === "edit" && this.summary) {
        this.acceptEdit(m);
        this.onChange?.();
      }
      this.editDone();
      return;
    }
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
      // The same for a patch request in flight: its callers hear the failure, the waiting input goes.
      if (this.patchInFlight !== undefined) {
        for (const w of this.inFlightWaiters.splice(0)) w.reject(new Error(m.message));
        this.patchDone();
      }
      // And for the edit request and the hit-tests in flight.
      if (this.editInFlight !== undefined) this.editDone();
      for (const w of this.hits.values()) w.reject(new Error(m.message));
      this.hits.clear();
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
      // `setDocument` dropped every part; a course or edit request posted after the load replies after this.
      this.course = undefined;
      this.edit = undefined;
      this.editHidden = new Set();
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
      if (this.mesh) {
        // The mesh's model space is the arenas': a new document may bring a new origin.
        this.mesh = this.renderer.terrain.setOrigin({ x: s.originX, y: s.originY });
        this.drapeKey = "";
      }
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
    const drawn = this.detailDrawn.has(id);
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
    this.selection = "2d";
    this.selectViews([view], this.opts.prefetchMarginCells);
  }

  /**
   * The drawn set for one or more views (the 2D view, or the drape layers, §5.6 "Engine API"): the
   * cells each meets, with its detail where that view is above the zoom gate, requested with
   * `prefetch` cells of margin.
   */
  private selectViews(views: readonly ViewRect[], prefetch: number): void {
    const s = this.summary;
    if (!s) return;
    const drawn: number[] = [], detail = new Set<number>(), wanted: number[] = [];
    const seen = new Set<number>(), seenWanted = new Set<number>();
    for (const view of views) {
      const cells = visibleCells(view, s.grid, DRAW_MARGIN_CELLS);
      for (const id of cells) if (!seen.has(id)) { seen.add(id); drawn.push(id); }
      if (this.opts.gate && !aboveZoomGate(view.pxPerUm)) continue;
      for (const id of cells) detail.add(id);
      // The request is keyed by the view's wanted cells, resident or not: the same view never re-sends,
      // even after the budget evicted part of what it asked for.
      for (const id of visibleCells(view, s.grid, prefetch)) if (this.detailCells.has(id) && !seenWanted.has(id)) { seenWanted.add(id); wanted.push(id); }
    }
    this.drawn = drawn;
    this.detailDrawn = detail;
    this.gated = detail.size === 0;
    if (!this.gated) {
      const key = wanted.join(",");
      if (key !== this.lastRequest) {
        this.lastRequest = key;
        const want = wanted.filter((id) => !this.detail.has(id));
        for (const id of want) this.pending.add(id);
        // The worker replaces its queue; what was pending but is no longer wanted will not arrive.
        for (const id of [...this.pending]) if (!want.includes(id)) this.pending.delete(id);
        this.transport.post({ type: "prepare", ids: want }, []);
      }
      this.lru.touch([...detail]);
    } else if (this.lastRequest !== "") {
      this.lastRequest = "";
      this.pending.clear();
      this.transport.post({ type: "prepare", ids: [] }, []);
    }
    // Arrivals and evictions mark the set dirty themselves; this key is the views' part.
    const sorted = (ids: Iterable<number>) => [...ids].sort((a, b) => a - b).join(",");
    const key = `${this.gated ? "g" : ""}${sorted(drawn)}${detail.size && detail.size !== drawn.length ? `|${sorted(detail)}` : ""}`;
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
    const protect = this.detailDrawn;
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
    for (const id of this.detailDrawn) if (this.detailCells.has(id) && !this.detail.has(id)) return false;
    return true;
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
    // After a 3D frame the drawn set is the drape's: back to the view's.
    if (this.selection !== "2d") this.setView(view);
    this.rebuild(t0);
    const stats = this.renderer.renderDocument(view, this.withHighlight(opts), target);
    stats.cpuMs = performance.now() - t0;
    return stats;
  }

  /** Rebuilds the visible set if the drawn set changed (arrivals coalesced); true when it did. */
  private alphaLayers = 0;

  /** Alpha layers in the current visible set (J3, §5.2 "Alpha layers"); the fixture page's stats line. */
  get visibleAlphaLayers(): number {
    return this.alphaLayers;
  }

  private rebuild(t0: number): boolean {
    // Arrivals are coalesced while more drawn detail is pending; the last one always rebuilds.
    const hold = this.dirty && this.arrivalOnly && !this.isComplete() && t0 - this.lastRebuildAt < ARRIVAL_REBUILD_MS;
    if (hold && !this.holdTimer) {
      this.holdTimer = setTimeout(() => {
        this.holdTimer = undefined;
        this.onChange?.();
      }, ARRIVAL_REBUILD_MS - (t0 - this.lastRebuildAt));
    }
    if (!this.dirty || hold) return false;
    const parts: ResidentPart[] = [];
    for (const id of [...this.drawn].sort((a, b) => a - b)) {
      const b = this.base.get(id);
      if (b) parts.push(b);
      if (this.detailDrawn.has(id)) {
        const d = this.detail.get(id);
        if (d) parts.push(d);
      }
    }
    if (this.large) parts.push(this.large);
    // Last: within a colour the course draws over the map's own objects of that colour.
    if (this.course) parts.push(this.course);
    // The edit part: a draft in colour order over the course; the highlight's reserved colour sorts last.
    if (this.edit) parts.push(this.edit);
    // The page's colours sort after every map colour: the page layer draws over the map, as in the PDF.
    if (this.page) parts.push(this.page);
    const f = this.filter;
    const extra = [...(f?.hidden ?? []), ...this.patchHidden, ...this.editHidden];
    const hidden = extra.length ? new Set([...this.hidden, ...extra]) : this.hidden;
    const vs = buildVisibleSet(parts, hidden, f?.visible);
    this.st.lastBuildMs = performance.now() - t0;
    this.renderer.setVisibleSet(vs);
    this.alphaLayers = vs.alpha?.length ?? 0;
    this.lru.fixedBytes = this.fixedBytes + this.renderer.documentBytes.visibleSet;
    this.dirty = false;
    this.arrivalOnly = false;
    this.lastRebuildAt = performance.now();
    this.st.rebuilds++;
    this.st.lastRebuildMs = performance.now() - t0;
    return true;
  }

  // ---- terrain (§5.6 "Engine API", H6) ----------------------------------------------------------

  /** The mesh of the field set last, once uploaded (H7's pick and camera bounds). */
  get terrainMesh(): TerrainMesh | null {
    return this.mesh;
  }

  /** The field `terrainMesh` was built from (null: none); a `setTerrain` in flight replaces both when its mesh is in. */
  get terrainField(): HeightField | null {
    return this.field;
  }

  /**
   * Sets the height field 3D frames draw (`null` drops it, its textures and the drape). The no-data
   * fill, chunk ranges and normals run in the worker (§5.6 "Worker"); resolves with the mesh once
   * uploaded. A later call supersedes one in flight, which then rejects.
   */
  setTerrain(field: HeightField | null): Promise<TerrainMesh | null> {
    this.terrainWaiter?.reject(new Error("superseded by a later setTerrain"));
    this.terrainWaiter = undefined;
    const generation = ++this.terrainGeneration;
    this.pendingField = field;
    if (!field) {
      this.field = null;
      this.dropTerrain();
      return Promise.resolve(null);
    }
    return new Promise((resolve, reject) => {
      this.terrainWaiter = { generation, resolve, reject };
      const z = field.z.slice();
      this.transport.post({ type: "terrain", generation, header: field.header, z }, [z.buffer]);
    });
  }

  private dropTerrain(): void {
    if (this.mesh) this.renderer.terrain.clearField();
    this.mesh = null;
    this.renderer.releaseDrapes();
    this.drapeLayersDrawn = [];
    this.drapeKey = "";
    this.drapeStale = true;
    this.terrainPrepareMs = undefined;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    if (this.arrivalTimer) clearTimeout(this.arrivalTimer);
    this.settleTimer = this.arrivalTimer = undefined;
    this.updateFixedBytes();
    this.evict();
    if (this.selection !== "2d" && this.view) this.setView(this.view);
  }

  private acceptTerrain(m: TerrainReply | (WorkerReply & { type: "error" })): void {
    const w = this.terrainWaiter;
    const generation = m.type === "terrain" ? m.generation : m.terrain;
    const field = this.pendingField;
    if (!w || generation !== w.generation || !field) return;
    this.terrainWaiter = undefined;
    if (m.type === "error") {
      w.reject(new Error(m.message));
      return;
    }
    try {
      const origin = this.summary ? { x: this.summary.originX, y: this.summary.originY } : { x: 0, y: 0 };
      this.renderer.releaseDrapes();
      const t0 = performance.now();
      this.mesh = this.renderer.terrain.setField(field, origin, { terrain: m.terrain, normals: m.normals });
      this.field = field;
      this.terrainUploadMs = performance.now() - t0;
      this.terrainPrepareMs = m.ms;
      this.drapeLayersDrawn = [];
      this.drapeKey = "";
      this.drapeStale = true;
      this.updateFixedBytes();
      this.evict();
      w.resolve(this.mesh);
      this.onChange?.();
    } catch (e) {
      w.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private fieldBytes(): number {
    return this.mesh ? fieldTextureBytes(this.mesh.width, this.mesh.height) : 0;
  }

  /** The drape's texel limits: a third of the budget (mip chains included), `DRAPE_MAX_SIDE` per side (§5.6 decision 5). */
  drapeLimits(): { maxSide: number; maxPixels: number } {
    return {
      maxSide: Math.min(DRAPE_MAX_SIDE, this.renderer.maxTextureSize),
      maxPixels: Math.floor((this.opts.budgetBytes * DRAPE_BUDGET_SHARE) / DRAPE_TEXEL_BYTES),
    };
  }

  /** Re-renders the drape at the next 3D frame (the host changed what `opts` draw, e.g. the colours). */
  invalidateDrape(): void {
    this.drapeStale = true;
  }

  /**
   * One 3D frame (§5.6 "Settling"): while the camera moves only the mesh is drawn, over the drape
   * last rendered; once it has settled for `DRAPE_SETTLE_MS` the drape layers are re-selected for
   * the camera's footprint. Whenever the layers or the visible set changed (content, arrivals), the
   * map is rendered into them first — one frame = map-to-texture + mesh. `opts` are the 2D frame's.
   */
  renderTerrain(frame: EngineTerrainFrame, opts: DocumentRenderOptions, target?: RenderTarget): TerrainFrameStats {
    const t0 = performance.now();
    const mesh = this.mesh, s = this.summary;
    if (!mesh || !s) return { mesh: null, cpuMs: 0 };
    const e = frame.exaggeration, cam = frame.camera;
    const c = cam.target;
    const ck = `${c.x},${c.y},${c.z},${cam.distanceUm},${cam.bearingDeg},${cam.pitchDeg},${cam.fovYDeg ?? ""},${cam.widthPx},${cam.heightPx},${e}`;
    if (ck !== this.cameraKey) {
      this.cameraKey = ck;
      this.lastMoveAt = t0;
      if (this.settleTimer) clearTimeout(this.settleTimer);
      this.settleTimer = setTimeout(() => {
        this.settleTimer = undefined;
        this.onChange?.();
      }, DRAPE_SETTLE_MS);
    }
    // `drapeKey` is "" until layers are selected for this field and document ("none" when the camera sees no mesh).
    const first = this.selection !== "3d" || this.drapeKey === "";
    let layers = this.drapeLayersDrawn;
    if (first || t0 - this.lastMoveAt >= DRAPE_SETTLE_MS) {
      const next = drapeLayers(cam, meshBox(mesh, e), mesh.originUm, this.drapeLimits());
      const key = next.map((l) => viewKey(l.view)).join(";") || "none";
      if (first || key !== this.drapeKey) {
        layers = next;
        this.drapeKey = key;
        this.selection = "3d";
        this.selectViews(layers.map((l) => l.view), DRAW_MARGIN_CELLS);
        this.drapeStale = true;
      }
    }
    let drape: TerrainFrameStats["drape"];
    const hopts = this.withHighlight(opts);
    // Arrivals alone, more detail still to come: re-render at a rate the drape's cost allows.
    const wait = Math.max(DRAPE_ARRIVAL_MS, DRAPE_ARRIVAL_FACTOR * this.drapeSt.lastMs) - (t0 - this.lastDrapeAt);
    const holdArrivals = !this.drapeStale && this.dirty && this.arrivalOnly && !this.isComplete() && wait > 0;
    if (holdArrivals) {
      this.arrivalTimer ??= setTimeout(() => {
        this.arrivalTimer = undefined;
        this.onChange?.();
      }, wait);
    } else if (this.rebuild(t0)) this.drapeStale = true;
    if (this.drapeStale && !(this.dirty && this.arrivalOnly)) {
      const d = { drawCalls: 0, tiles: 0, cpuMs: 0, layers: layers.length };
      layers.forEach((l, i) => {
        const r = this.renderer.renderDrape(i, l.view, hopts);
        d.drawCalls += r.drawCalls;
        d.tiles += r.tiles;
      });
      this.renderer.releaseDrapes(layers.length);
      d.cpuMs = performance.now() - t0;
      drape = d;
      this.drapeLayersDrawn = layers;
      this.drapeStale = false;
      this.lastDrapeAt = performance.now();
      this.drapeSt = { renders: this.drapeSt.renders + 1, lastMs: d.cpuMs, lastDraws: d.drawCalls, lastTiles: d.tiles };
      this.updateFixedBytes();
      this.evict();
    }
    const drawnLayers = this.drapeLayersDrawn;
    const drapes = drawnLayers.flatMap((l, i) => {
      const texture = this.renderer.drape(i);
      return texture ? [{ texture, matrix: viewMatrix(l.view, s.originX, s.originY) }] : [];
    });
    const meshStats = this.renderer.drawTerrain(
      { camera: cam, exaggeration: e, drapes, background: opts.background ?? [1, 1, 1], lodPx: frame.lodPx, level: frame.level },
      target,
      frame.lines ? { lines: frame.lines, pxRatio: frame.pxRatio ?? 1 } : undefined,
    );
    const pending = this.graphics?.pending ?? 0;
    return { mesh: meshStats, drape, cpuMs: performance.now() - t0, ...(pending ? { imagesPending: pending } : {}) };
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
    const stats = this.renderer.renderDocument(view, this.withHighlight(opts), target);
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
      drawnDetail: this.drawn.filter((id) => this.detailDrawn.has(id) && this.detail.has(id)).length,
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
      graphicBytes: this.graphics?.bytes ?? 0,
      graphicsPending: this.graphics?.pending ?? 0,
      ...(this.mesh ? { terrain: this.terrainStats() } : {}),
    };
  }

  private terrainStats(): TerrainStats {
    return {
      fieldBytes: this.fieldBytes(),
      drapeBytes: this.renderer.drapeBytes,
      scratchBytes: this.renderer.drapeScratchBytes,
      layers: this.drapeLayersDrawn.map((l) => ({ role: l.role, widthPx: l.view.widthPx, heightPx: l.view.heightPx, pxPerUm: l.view.pxPerUm, ratio: l.view.pxPerUm / l.needPxPerUm })),
      drapeRenders: this.drapeSt.renders,
      lastDrapeMs: this.drapeSt.lastMs,
      lastDrapeDraws: this.drapeSt.lastDraws,
      lastDrapeTiles: this.drapeSt.lastTiles,
      prepareMs: this.terrainPrepareMs,
      uploadMs: this.terrainUploadMs,
    };
  }

  dispose(): void {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    if (this.settleTimer) clearTimeout(this.settleTimer);
    if (this.arrivalTimer) clearTimeout(this.arrivalTimer);
    this.terrainWaiter?.reject(new Error("map engine disposed"));
    this.terrainWaiter = undefined;
    // A hit-test in flight is never answered now: its caller hears so.
    for (const w of this.hits.values()) w.reject(new Error("map engine disposed"));
    this.hits.clear();
    this.graphics?.dispose();
    this.graphics = null;
    this.transport.terminate();
  }
}
