import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render } from "@oxygen/shared";
import { MapGlEngine, type Transport } from "../engine";
import { createMapGlWorker, type WorkerReply, type WorkerRequest } from "../worker";
import { CELL_UM, type PreparedPart, type ResidentPart, type VisibleSet, type ViewRect } from "../buckets";
import type { DocumentRenderOptions, InsetBox, MapGlRenderer, TextAtlasImage } from "../renderer";
import { loupeView, type RenderTarget } from "../view";
import { parseTextAtlasPage } from "../text-atlas";
import type { MeshAtlas } from "../mesh-atlas";
import { documentBytes, indexOf, request } from "./course-fixture";

const fontsDir = resolve(import.meta.dirname, "../../../../shared/fonts");
const fontBytes = () => {
  const b = readFileSync(resolve(fontsDir, "LiberationSans-Regular.ttf"));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

/** The pilot scene tiled over a 5 × 5 block of cells. */
function objects(): render.RenderObject[] {
  const out: render.RenderObject[] = [];
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      for (const o of render.pilotScene) {
        const c = Int32Array.from(o.path.coords);
        for (let k = 0; k < c.length; k += 2) { c[k] = Math.round(c[k] * 0.6) + i * CELL_UM; c[k + 1] = Math.round(c[k + 1] * 0.6) + j * CELL_UM; }
        out.push({ ...o, path: { ...o.path, coords: c } });
      }
    }
  }
  return out;
}

/** A renderer that records what the engine asks of it. */
class FakeRenderer {
  parts = new Map<string, PreparedPart>();
  released: string[] = [];
  visibleSets: VisibleSet[] = [];
  textAtlas: TextAtlasImage[][] = [];
  private next = 0;
  atlases: MeshAtlas[] = [];
  setDocument(): void {
    this.parts.clear();
  }
  setAtlas(atlas: MeshAtlas): void {
    this.atlases.push(atlas);
  }
  setTextAtlas(pages: TextAtlasImage[]): void {
    this.textAtlas.push(pages);
  }
  get textAtlasBytes() {
    return this.textAtlas.at(-1)?.reduce((n, p) => n + p.page.width * p.page.height * 4, 0) ?? 0;
  }
  uploadPart(key: string, part: PreparedPart): ResidentPart {
    this.parts.set(key, part);
    const base = { fill: this.next, hatch: this.next, stroke: this.next };
    this.next += 1000;
    return { part, base };
  }
  releasePart(key: string): void {
    this.parts.delete(key);
    this.released.push(key);
  }
  setVisibleSet(vs: VisibleSet): void {
    this.visibleSets.push(vs);
  }
  renderOpts: DocumentRenderOptions[] = [];
  renderViews: ViewRect[] = [];
  renderTargets: (RenderTarget | undefined)[] = [];
  renderDocument(view: ViewRect, opts: DocumentRenderOptions, target?: RenderTarget) {
    this.renderOpts.push(opts);
    this.renderViews.push(view);
    this.renderTargets.push(target);
    return { drawCalls: 1, cpuMs: 0 };
  }
  readonly inset: RenderTarget = { framebuffer: {} as WebGLFramebuffer, width: 0, height: 0 };
  composites: InsetBox[] = [];
  insetReleases = 0;
  insetTarget(size: number): RenderTarget {
    this.inset.width = this.inset.height = size;
    return this.inset;
  }
  compositeInset(box: InsetBox): void {
    this.composites.push(box);
  }
  releaseInset(): void {
    this.insetReleases++;
  }
  get documentBytes() {
    return { arenas: 0, arenasUsed: 0, atlas: 0, text: 0, visibleSet: 0, total: 0 };
  }
}

/** The worker's handler behind a transport whose messages are delivered only when `flush()` runs. */
function manualTransport() {
  const tasks: (() => void)[] = [];
  const posted: WorkerRequest[] = [];
  const t: Transport & { flush(): void; posted: WorkerRequest[] } = {
    posted,
    onMessage: undefined,
    terminate: () => undefined,
    post: (msg) => {
      posted.push(msg);
      tasks.push(() => handler.handle(msg));
    },
    flush: () => {
      for (let guard = 0; tasks.length && guard < 10_000; guard++) tasks.shift()!();
    },
  };
  const handler = createMapGlWorker((msg: WorkerReply) => tasks.push(() => t.onMessage?.(msg)), (fn) => tasks.push(fn), 1e9);
  return t;
}

const latin = parseTextAtlasPage(JSON.parse(readFileSync(resolve(fontsDir, "msdf/text-atlas.latin.json"), "utf8")));

async function loaded(budgetBytes: number, textAtlas?: TextAtlasImage[]) {
  const renderer = new FakeRenderer();
  const transport = manualTransport();
  const engine = new MapGlEngine(renderer as unknown as MapGlRenderer, transport, { budgetBytes });
  const p = engine.load({ source: { kind: "objects", objects: objects(), symbols: render.pilotSymbols }, fonts: [{ family: "liberation-sans", bytes: fontBytes() }], textAtlas });
  transport.flush();
  const summary = await p;
  return { renderer, transport, engine, summary };
}

/** A view of one cell's neighbourhood: 0.02 px/µm (above the gate), 500 px ≈ 25 mm. */
const cellView = (col: number, row: number): ViewRect => ({ centreX: (col + 0.5) * CELL_UM, centreY: (row + 0.5) * CELL_UM, pxPerUm: 0.02, widthPx: 500, heightPx: 500 });
const prepares = (t: { posted: WorkerRequest[] }) => t.posted.filter((m) => m.type === "prepare") as Extract<WorkerRequest, { type: "prepare" }>[];

describe("MapGlEngine residency (docs/map-rendering.md §5.2)", () => {
  it("requests the drawn + prefetch cells' detail, uploads it and draws the drawn cells", async () => {
    const { engine, transport, renderer, summary } = await loaded(1 << 30);
    expect(summary.detailCells.length).toBe(25);
    engine.setView(cellView(2, 2));
    expect(prepares(transport).at(-1)!.ids.length).toBe(25); // prefetch margin 2 covers the 5 × 5 block
    transport.flush();
    engine.render({ colour: () => [0, 0, 0] });
    const st = engine.stats();
    expect(st.pending).toBe(0);
    expect(st.drawnCells).toBe(9); // draw margin 1
    expect(st.drawnDetail).toBe(9);
    expect(st.residentDetail).toBe(25);
    expect([...renderer.parts.keys()].filter((k) => k.startsWith("d"))).toHaveLength(25);
  });

  it("never evicts a drawn part: over budget is reported instead", async () => {
    const { engine, transport } = await loaded(1);
    engine.setView(cellView(2, 2));
    transport.flush();
    const st = engine.stats();
    expect(st.overBudget).toBe(true);
    expect(st.drawnDetail).toBe(9);
    expect(st.residentDetail).toBe(9); // the prefetch ring was evicted, the drawn set kept
    expect(st.evictions).toBe(16);
  });

  it("does not re-request the ring the budget just refused while the view stays put", async () => {
    const { engine, transport } = await loaded(1);
    for (let i = 0; i < 5; i++) {
      engine.setView(cellView(2, 2));
      transport.flush();
    }
    expect(prepares(transport)).toHaveLength(1);
    expect(engine.stats().prepareMs).toHaveLength(25); // each cell prepared once
    // A new view sends a new want list.
    engine.setView(cellView(3, 3));
    expect(prepares(transport)).toHaveLength(2);
  });

  it("rebuilds the visible set when the drawn cells change, not when zooming within them", async () => {
    const { engine, transport, renderer } = await loaded(1 << 30);
    engine.setView(cellView(2, 2));
    transport.flush();
    engine.render({ colour: () => [0, 0, 0] });
    const n = renderer.visibleSets.length;
    engine.setView({ ...cellView(2, 2), pxPerUm: 0.021 });
    engine.render({ colour: () => [0, 0, 0] });
    expect(renderer.visibleSets.length).toBe(n);
    engine.setView(cellView(0, 0));
    engine.render({ colour: () => [0, 0, 0] });
    expect(renderer.visibleSets.length).toBe(n + 1);
  });

  it("below the zoom gate draws base parts + large only and cancels the queue", async () => {
    const { engine, transport, renderer } = await loaded(1 << 30);
    engine.setView(cellView(2, 2));
    // Zoom out past the gate before anything arrived: pending cleared, an empty prepare replaces the queue.
    engine.setView({ ...cellView(2, 2), pxPerUm: 1e-4 });
    expect(prepares(transport).at(-1)!.ids).toEqual([]);
    expect(engine.stats().gated).toBe(true);
    expect(engine.stats().pending).toBe(0);
    transport.flush();
    engine.render({ colour: () => [0, 0, 0] });
    const vs = renderer.visibleSets.at(-1)!;
    expect(vs.stroke.draws).toHaveLength(0);
    expect(vs.glyph.draws.length + vs.clips.groups.length).toBe(0);
    expect(vs.fill.draws.length).toBeGreaterThan(0);
  });

  it("skips hidden objects and rebuilds when the hidden set changes", async () => {
    const { engine, transport, renderer } = await loaded(1 << 30);
    engine.setView(cellView(2, 2));
    transport.flush();
    engine.render({ colour: () => [0, 0, 0] });
    const before = renderer.visibleSets.at(-1)!.fill.indices.length;
    engine.setHidden(new Set(Array.from({ length: 5000 }, (_, i) => i)));
    engine.render({ colour: () => [0, 0, 0] });
    const after = renderer.visibleSets.at(-1)!;
    expect(after.fill.indices.length).toBeLessThan(before);
    expect(after.fill.indices.length).toBe(0);
  });

  it("hands the text atlas images to the renderer and the same pages to the worker; their bytes are resident", async () => {
    const image = {} as TexImageSource;
    const { engine, transport, renderer, summary } = await loaded(1 << 30, [{ page: latin, image }]);
    expect(renderer.textAtlas.at(-1)).toEqual([{ page: latin, image }]);
    const load = transport.posted[0] as Extract<WorkerRequest, { type: "load" }>;
    expect(load.textAtlas).toEqual([latin]);
    expect(summary.text.pages).toEqual(["latin"]);
    expect(engine.stats().residentBytes).toBeGreaterThanOrEqual(latin.width * latin.height * 4);
    engine.setView(cellView(2, 2));
    transport.flush();
    engine.render({ colour: () => [0, 0, 0] });
    expect(renderer.visibleSets.at(-1)!.text.draws.length).toBeGreaterThan(0);
  });

  it("without pages: the renderer's atlas is cleared and the worker gets none", async () => {
    const { transport, renderer, summary } = await loaded(1 << 30);
    expect(renderer.textAtlas.at(-1)).toEqual([]);
    expect((transport.posted[0] as Extract<WorkerRequest, { type: "load" }>).textAtlas).toBeUndefined();
    expect(summary.warnings.TEXT_ATLAS_MISSING).toBeGreaterThan(0);
  });
});

describe("MapGlEngine dynamic bucket (docs/map-rendering.md §5.2 Dynamic bucket)", () => {
  async function courseEngine(budgetBytes = 1 << 30) {
    const renderer = new FakeRenderer();
    const transport = manualTransport();
    const engine = new MapGlEngine(renderer as unknown as MapGlRenderer, transport, { budgetBytes });
    const infos: unknown[] = [];
    engine.onCourse = (i) => infos.push(i);
    let changes = 0;
    engine.onChange = () => changes++;
    const p = engine.load({
      source: { kind: "document", bytes: documentBytes(), options: { unmatched: "proxy" } },
      fonts: [{ family: "liberation-sans", bytes: fontBytes() }],
      textAtlas: [{ page: latin, image: {} as ImageBitmap }],
      courseLayer: true,
    });
    transport.flush();
    const summary = await p;
    return { renderer, transport, engine, summary, infos, changes: () => changes };
  }
  const courseParts = (vs: VisibleSet, colour: number) => vs.stroke.draws.filter((d) => d.colour === colour);

  it("uploads the course part, draws it in every visible set (also below the zoom gate) and rebuilds at once", async () => {
    const { engine, transport, renderer, summary, infos, changes } = await courseEngine();
    // Far below the gate: no detail, but the course is always resident.
    engine.setView({ centreX: 30_000, centreY: 30_000, pxPerUm: 0.0001, widthPx: 500, heightPx: 500 });
    engine.render({ colour: () => [0, 0, 0] });
    const before = renderer.visibleSets.length;
    engine.setCourse(request());
    transport.flush();
    expect(renderer.parts.has("C")).toBe(true);
    expect(infos).toHaveLength(1);
    expect(changes()).toBeGreaterThan(0);
    engine.render({ colour: () => [0, 0, 0] });
    expect(renderer.visibleSets.length).toBe(before + 1);
    const lower = indexOf(summary.colourStack!, "purple-lower");
    expect(courseParts(renderer.visibleSets.at(-1)!, lower).length).toBe(1);
    expect(renderer.atlases).toHaveLength(1);
    expect(engine.colours).toBe((infos[0] as { colours: unknown }).colours);
    // The editor's hit index reaches the host with the derivation (§5.5).
    expect((infos[0] as { hit: { refs: unknown[] } | null }).hit?.refs.length).toBeGreaterThan(0);
  });

  const courses = (t: { posted: WorkerRequest[] }) => t.posted.filter((m) => m.type === "course") as Extract<WorkerRequest, { type: "course" }>[];
  const derivedCourses = (info: unknown) => (info as { derivation: { courses: unknown[] } | null }).derivation?.courses.length;

  it("one request in flight, latest wins: the inputs made meanwhile wait, only the last is sent once the reply is in (docs/bugfix-course-drag-redraw.md)", async () => {
    const { engine, transport, infos } = await courseEngine();
    const before = courses(transport).length;
    const a = request(), b = request({ viewOptions: { labelMode: "code" } }), c = request({ structure: null });
    engine.setCourse(a);
    engine.setCourse(b);
    engine.setCourse(c);
    // A drag's pointer moves: one request reaches the worker, the others only replace the waiting input.
    expect(courses(transport).slice(before).map((m) => m.input)).toEqual([a]);
    transport.flush();
    // A's reply is the latest posted generation, so it is drawn; then C (not B) is sent and drawn.
    expect(courses(transport).slice(before).map((m) => m.input)).toEqual([a, c]);
    expect(infos.map(derivedCourses)).toEqual([1, 0]);
    transport.flush();
    expect(courses(transport).slice(before)).toHaveLength(2);
    // Nothing in flight: the next input goes at once.
    engine.setCourse(a);
    expect(courses(transport).slice(before)).toHaveLength(3);
  });

  it("null counts as an input: it waits like any, and releases the part", async () => {
    const { engine, transport, renderer, infos } = await courseEngine();
    engine.setCourse(request());
    engine.setCourse(null);
    transport.flush();
    expect(courses(transport).at(-1)!.input).toBeNull();
    expect(infos).toHaveLength(2);
    expect((infos[1] as { derivation: unknown }).derivation).toBeNull();
    expect(renderer.parts.has("C")).toBe(false);
    expect(renderer.released).toContain("C");
  });

  it("a stale reply is dropped: a load re-sends the course at once, the reply of the one in flight before it is ignored", async () => {
    const { engine, transport, infos } = await courseEngine();
    engine.setCourse(request());
    const p = engine.load({ source: { kind: "document", bytes: documentBytes(), options: { unmatched: "proxy" } }, fonts: [{ family: "liberation-sans", bytes: fontBytes() }], courseLayer: true });
    expect(transport.posted.slice(-3).map((m) => m.type)).toEqual(["course", "load", "course"]);
    const [stale, current] = courses(transport).slice(-2).map((m) => m.generation);
    expect(current).toBe(stale + 1);
    transport.flush();
    await p;
    // The first reply answered the document the load replaced: only the re-sent one is drawn.
    expect(infos).toHaveLength(1);
    expect(courses(transport).at(-1)!.generation).toBe(current);
  });

  it("an error reply ends the request in flight, so a waiting input is not stuck behind it", async () => {
    const { engine, transport, infos } = await courseEngine();
    const before = courses(transport).length;
    engine.setCourse(request());
    engine.setCourse(request({ structure: null }));
    expect(courses(transport).length).toBe(before + 1);
    transport.onMessage!({ type: "error", message: "course failed" });
    expect(courses(transport).length).toBe(before + 2);
    transport.flush();
    // The first request's reply is now stale; the waiting input's is drawn.
    expect(infos.map(derivedCourses)).toEqual([0]);
  });

  it("a course error names its generation (F20b): it ends that request only, and leaves a load in flight alone", async () => {
    const { engine, transport, infos } = await courseEngine();
    const before = courses(transport).length;
    engine.setCourse(request());
    engine.setCourse(request({ structure: null }));
    const g = courses(transport).at(-1)!.generation;
    let failed: unknown;
    const p = engine.load({ source: { kind: "document", bytes: documentBytes(), options: { unmatched: "proxy" } }, fonts: [{ family: "liberation-sans", bytes: fontBytes() }], courseLayer: true });
    p.catch((e) => (failed = e));
    // The load re-sent the course at g + 1; an error of the overtaken request g ends nothing.
    const current = courses(transport).at(-1)!.generation;
    expect(current).toBe(g + 1);
    transport.onMessage!({ type: "error", message: "course failed", generation: g });
    expect(courses(transport).length).toBe(before + 2);
    // The load re-sent the latest input: nothing waits. Still in flight, a new input waits behind it.
    engine.setCourse(request({ viewOptions: { labelMode: "code" } }));
    expect(courses(transport).length).toBe(before + 2);
    // The matching error ends the request in flight: the waiting input goes, the load still stands.
    transport.onMessage!({ type: "error", message: "course failed", generation: current });
    expect(courses(transport).length).toBe(before + 3);
    transport.flush();
    await p;
    expect(failed).toBeUndefined();
    // The ended request's late reply is stale; only the waiting input's is drawn.
    expect(infos.map(derivedCourses)).toEqual([1]);
  });

  it("a course error of a request no longer in flight is ignored: the one in flight is still drawn", async () => {
    const { engine, transport, infos } = await courseEngine();
    engine.setCourse(request());
    const g = courses(transport).at(-1)!.generation;
    transport.onMessage!({ type: "error", message: "old", generation: g - 1 });
    engine.setCourse(request({ structure: null }));
    // Still one in flight: the second input waits behind it.
    expect(courses(transport).at(-1)!.generation).toBe(g);
    transport.flush();
    expect(infos.map(derivedCourses)).toEqual([1, 0]);
  });

  it("filter regions: the reply's hidden objects join setHidden's, masks reach the visible set, null clears both", async () => {
    const { engine, transport, renderer, summary } = await courseEngine();
    engine.setView({ centreX: 30_000, centreY: 30_000, pxPerUm: 0.02, widthPx: 2000, heightPx: 2000 });
    transport.flush();
    const square = [{ x: 20, y: 5 }, { x: 30, y: 5 }, { x: 30, y: 15 }, { x: 20, y: 15 }];
    const black = indexOf(summary.colourStack!, "black100");
    const draw = () => { engine.render({ colour: () => [0, 0, 0] }); return renderer.visibleSets.at(-1)!; };
    const blackDraws = (vs: VisibleSet) => vs.stroke.draws.filter((d) => d.colour === black);
    expect(blackDraws(draw()).map((d) => d.mask)).toEqual([undefined]);

    engine.setCourse(request({ regions: [{ rings: [square], mode: "clip", symbols: "all" }] }));
    transport.flush();
    const clipped = draw();
    expect(blackDraws(clipped).map((d) => d.mask)).toEqual([0]);
    expect(clipped.filter?.masks).toHaveLength(1);

    engine.setCourse(request({ regions: [{ rings: [square], mode: "hide", symbols: "all" }] }));
    transport.flush();
    expect(blackDraws(draw())).toEqual([]);
    engine.setHidden(new Set([1]));
    expect(draw().stroke.draws.filter((d) => d.colour !== black && d.mask === undefined).length).toBeGreaterThan(0);

    engine.setHidden(new Set());
    engine.setCourse(null);
    transport.flush();
    const cleared = draw();
    expect(blackDraws(cleared).map((d) => d.mask)).toEqual([undefined]);
    expect(cleared.filter).toBeUndefined();
  });

  it("a page: its part drawn after the course part, the map clipped to the frame, both released on clear (docs/course-layout.md §1)", async () => {
    const { engine, transport, renderer } = await courseEngine();
    engine.setView({ centreX: 30_000, centreY: 30_000, pxPerUm: 0.002, widthPx: 800, heightPx: 800 });
    const frame = { x: 10, y: 10, width: 190, height: 277 };
    const window = { minX: -65, minY: -128.5, width: 190, height: 277 };
    engine.setCourse(request({
      page: { paper: { heightMm: 297 }, frame, window, objects: [
        { id: "t", kind: "text", anchor: "page", x: 105, y: 20, text: "Bana", fontSizeMm: 6, color: "#000000" },
        { id: "w", kind: "rectangle", anchor: "page", x: 150, y: 250, width: 30, height: 20, fillMode: "whiteout" },
      ],
      description: null,
    },
    }));
    transport.flush();
    expect(renderer.parts.has("P")).toBe(true);
    const fixed = engine.stats().residentBytes;
    engine.render({ colour: () => [0, 0, 0] });
    const opts = renderer.renderOpts.at(-1)!;
    const base = opts.pageClip!.fromColour;
    expect(base * 2).toBe(engine.colours.length);
    expect(opts.pageClip!.ringUm).toHaveLength(4);
    const vs = renderer.visibleSets.at(-1)!;
    expect(vs.text.draws.some((d) => d.colour >= base)).toBe(true);
    expect(vs.layers.at(-1)!.colour).toBeGreaterThanOrEqual(base);

    engine.setCourse(request());
    transport.flush();
    expect(renderer.released).toContain("P");
    expect(renderer.parts.has("P")).toBe(false);
    expect(engine.stats().residentBytes).toBeLessThan(fixed);
    engine.render({ colour: () => [0, 0, 0] });
    expect(renderer.renderOpts.at(-1)!.pageClip).toBeUndefined();
  });

  it("the loupe: one more draw of the visible set render built, into the inset target, composited at the box (docs/map-rendering.md §5.5)", async () => {
    const { engine, transport, renderer } = await courseEngine();
    const view = { centreX: 30_000, centreY: 30_000, pxPerUm: 0.002, widthPx: 800, heightPx: 800 };
    engine.setView(view);
    engine.setCourse(request({ page: { paper: { heightMm: 297 }, frame: { x: 10, y: 10, width: 190, height: 277 }, window: { minX: -65, minY: -128.5, width: 190, height: 277 }, objects: [], description: null } }));
    transport.flush();
    const opts = { colour: () => [0, 0, 0] as [number, number, number] };
    engine.render(opts);
    const { rebuilds } = engine.stats();
    const posted = transport.posted.length;
    const draws = renderer.renderViews.length;
    const lv = loupeView(view, { x: 31_000, y: 29_500 }, 2.5, 300);
    engine.renderInset(lv, opts, { x: 250, y: 100, size: 300 });
    expect(renderer.renderViews.length).toBe(draws + 1);
    expect(renderer.renderViews.at(-1)).toEqual(lv);
    expect(renderer.renderTargets.at(-1)).toBe(renderer.inset);
    expect(renderer.inset.width).toBe(300);
    expect(renderer.renderOpts.at(-1)!.pageClip).toEqual(renderer.renderOpts.at(-2)!.pageClip);
    expect(renderer.renderOpts.at(-1)!.pageClip).toBeDefined();
    expect(renderer.composites).toEqual([{ x: 250, y: 100, size: 300 }]);
    // Over the resident visible set: no rebuild, no request to the worker.
    expect(engine.stats().rebuilds).toBe(rebuilds);
    expect(transport.posted.length).toBe(posted);
    engine.releaseInset();
    expect(renderer.insetReleases).toBe(1);
  });

  it("the loupe before the load draws nothing", () => {
    const renderer = new FakeRenderer();
    const engine = new MapGlEngine(renderer as unknown as MapGlRenderer, manualTransport(), {});
    const v = { centreX: 0, centreY: 0, pxPerUm: 0.01, widthPx: 100, heightPx: 100 };
    expect(engine.renderInset(v, { colour: () => [0, 0, 0] }, { x: 0, y: 0, size: 100 })).toEqual({ drawCalls: 0, cpuMs: 0 });
    expect(renderer.renderViews).toHaveLength(0);
    expect(renderer.composites).toHaveLength(0);
  });

  it("a request before the load waits for it; the course counts as fixed bytes", async () => {
    const renderer = new FakeRenderer();
    const transport = manualTransport();
    const engine = new MapGlEngine(renderer as unknown as MapGlRenderer, transport, {});
    engine.setCourse(request({ structure: null }));
    const latest = request();
    engine.setCourse(latest);
    expect(transport.posted).toHaveLength(0);
    const p = engine.load({ source: { kind: "document", bytes: documentBytes(), options: { unmatched: "proxy" } }, fonts: [{ family: "liberation-sans", bytes: fontBytes() }], courseLayer: true });
    // Only the last input made before the load, right after the load message.
    expect(transport.posted.map((m) => m.type)).toEqual(["load", "course"]);
    expect((transport.posted[1] as Extract<WorkerRequest, { type: "course" }>).input).toBe(latest);
    transport.flush();
    await p;
    expect(renderer.parts.has("C")).toBe(true);
    const fixed = engine.stats().residentBytes;
    engine.setCourse(null);
    transport.flush();
    expect(engine.stats().residentBytes).toBeLessThan(fixed);
  });
});

