import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render } from "@oxygen/shared";
import { MapGlEngine, type Transport } from "../engine";
import { createMapGlWorker, type WorkerReply, type WorkerRequest } from "../worker";
import { CELL_UM, type PreparedPart, type ResidentPart, type VisibleSet, type ViewRect } from "../buckets";
import type { MapGlRenderer, TextAtlasImage } from "../renderer";
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
  renderDocument() {
    return { drawCalls: 1, cpuMs: 0 };
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
  });

  it("drops a reply a newer request overtook; null releases the part", async () => {
    const { engine, transport, renderer, infos } = await courseEngine();
    engine.setCourse(request());
    engine.setCourse(request({ structure: null }));
    transport.flush();
    expect(infos).toHaveLength(1);
    expect((infos[0] as { derivation: { courses: unknown[] } }).derivation.courses).toHaveLength(0);
    engine.setCourse(null);
    transport.flush();
    expect(renderer.parts.has("C")).toBe(false);
    expect(renderer.released).toContain("C");
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

  it("a request before the load waits for it; the course counts as fixed bytes", async () => {
    const renderer = new FakeRenderer();
    const transport = manualTransport();
    const engine = new MapGlEngine(renderer as unknown as MapGlRenderer, transport, {});
    engine.setCourse(request());
    expect(transport.posted).toHaveLength(0);
    const p = engine.load({ source: { kind: "document", bytes: documentBytes(), options: { unmatched: "proxy" } }, fonts: [{ family: "liberation-sans", bytes: fontBytes() }], courseLayer: true });
    expect(transport.posted.map((m) => m.type)).toEqual(["load", "course"]);
    transport.flush();
    await p;
    expect(renderer.parts.has("C")).toBe(true);
    const fixed = engine.stats().residentBytes;
    engine.setCourse(null);
    transport.flush();
    expect(engine.stats().residentBytes).toBeLessThan(fixed);
  });
});

