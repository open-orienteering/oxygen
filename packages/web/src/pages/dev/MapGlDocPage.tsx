/**
 * Dev-only measurement page for the WebGL2 map backend on real documents
 * (`/dev/map-gl-doc`; docs/map-rendering.md §5.2 "Dev pages").
 *
 * Loads an `.ocd`, `.omap` / `.xmap` or `.oxvm` (file picker, or `?url=` — in dev Vite serves any file
 * under the repo as `/@fs/<abs path>`). On the main thread: `readOcad` / `readOmap → …ToDocumentInput →
 * matchDocument (source mode) → encode`; an `.oxvm` skips that. Then the arena path (B2): the
 * document bytes go to the worker (`map-gl/worker.ts`: decode → bridge → symbolise → mesh atlas →
 * bucket assignment → always-resident layers → the first view's detail), the engine
 * (`map-gl/engine.ts`) uploads them and draws the visible set. `via=reader` uses the S1 converter
 * (`ocadObjectsToRender`) instead of the document.
 *
 * Reports every stage's time, bucket and residency figures, GPU bytes and the per-frame cost. "Bench"
 * runs two 240-frame scenarios — `fit` (zoom 1→4→1 with a pan across a third of the map) and `paper1x`
 * (a dense viewport at 1× paper, panning across the densest cell) — and reports frame-time,
 * draw-call and residency figures; `?bench=1` runs it after loading. Results are published as
 * `window.__mapGlDoc` for Playwright.
 *
 * Query: `mode=source|pilot|envelope` (default source), `via=document|reader`,
 * `worker=0` (worker handler inline on this thread), `gate=0` (no zoom gate), `budget=<MB>` (default
 * 150), `kinds=fill,stroke,…` (draw only these kinds; profiling), `lod=0` (no glyph skip / hatch
 * tint), `url=`, `bench=1`, `compare=1` (also draw the stream through the per-pass golden path into
 * a second canvas and publish the pixel difference). Not routed in production builds.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Buffer } from "buffer";
import { mapDocument, mapImport, render } from "@oxygen/shared";
import { prepareStream } from "../../map-gl/prepare";
import { MapGlRenderer, hexToRgb, type FrameStats, type View } from "../../map-gl/renderer";
import { MapGlEngine, inlineTransport, workerTransport, type EngineStats, type Transport } from "../../map-gl/engine";
import type { LoadSummary } from "../../map-gl/worker";
import { fitView } from "../../map-gl/buckets";
import liberationSansUrl from "../../../../shared/fonts/LiberationSans-Regular.ttf?url";
import liberationSansNarrowUrl from "../../../../shared/fonts/LiberationSansNarrow-Regular.ttf?url";

type Mode = render.OcadConvertMode | "source";

/** The 02 document path: what the codec did in the browser. */
interface DocumentReport {
  /** Encoded document size. */
  bytes: number;
  headerBytes: number;
  sections: { attrs: number; bboxes: number; geometry: number };
  ms: { hash: number; normalise: number; match: number; encode: number; decode: number };
  hash: string;
  objects: number;
  symbols: number;
  /** Source symbols drawn from the canonical library (applied matches), per the bridge. */
  canonicalSymbols: number;
  colours: number;
  warnings: Record<string, number>;
  /** True when the input was already a document (`.oxvm`) and no OCAD reader ran. */
  native: boolean;
}

/** Bucket layer figures (arena path). */
interface ArenaReport {
  worker: boolean;
  gate: boolean;
  budgetMB: number;
  grid: LoadSummary["grid"];
  detailCells: number;
  largeObjects: number;
  /** Worker stage times, ms. */
  ms: LoadSummary["ms"];
  /** Bytes of the always-resident layers. */
  bytes: LoadSummary["bytes"];
  /** Renderer GPU bytes after the complete frame. */
  gpu: MapGlRenderer["documentBytes"];
  engine: EngineStats;
  /** Detail-part preparation in the worker, ms. */
  prepareMs: { n: number; p50: number; p95: number; max: number };
}

interface LoadReport {
  file: string;
  bytes: number;
  mode: Mode;
  /** `document`: reader → normalise → encode → (worker) decode → bridge; `reader`: the S1 step-4 converter. */
  via: "document" | "reader";
  document?: DocumentReport;
  objects: render.OcadConvertResult["stats"];
  /**
   * Main-thread view, ms. `read` = file → document bytes (or render objects); `load` = posted to
   * the worker → always-resident layers uploaded; `firstFrame` = first draw (base layers + large
   * bucket); `complete` = the first view's detail arrived and drawn; `total` = start → complete.
   * `convert` / `symbolise` / `prepare` are the worker's stage times (decode + bridge; symbolise;
   * atlas + assign + base + large).
   */
  ms: { read: number; convert: number; symbolise: number; prepare: number; load: number; firstFrame: number; complete: number; total: number };
  passes: number;
  passKinds: Record<string, number>;
  colours: number;
  arena: ArenaReport;
  /** Resident GPU bytes after the complete frame. */
  gpuBytes: number;
  firstFrame: FrameStats;
  completeFrame: FrameStats;
  dpr: number;
  canvasPx: { w: number; h: number };
  gpuTimer: boolean;
  warnings: Record<string, number>;
  /** Main-thread long tasks (> 50 ms) from start to the complete frame, including reading the file. */
  mainThread?: { longTasks: number; longestMs: number; totalMs: number };
}

interface Summary { avg: number; p50: number; p95: number; max: number }

interface ScenarioReport {
  frames: number;
  seconds: number;
  fps: number;
  cpuMs: Summary;
  gpuMs?: Summary;
  frameMs: { avg: number; p95: number; max: number };
  /** Draw calls of the last frame and the most of any frame. */
  drawCalls: number;
  maxDrawCalls: number;
  /** The most resident bytes seen, visible-set rebuilds, frames drawn with detail missing, evictions. */
  maxResidentBytes?: number;
  rebuilds?: number;
  incompleteFrames?: number;
  evictions?: number;
  overBudgetFrames?: number;
}

interface BenchReport extends ScenarioReport {
  /** The dense 1× paper viewport. */
  paper1x?: ScenarioReport;
}

interface CompareReport {
  pxPerUm: number;
  total: number;
  differing: number;
  fraction: number;
}

declare global {
  interface Window {
    __mapGlDoc?: { load?: LoadReport; bench?: BenchReport; compare?: CompareReport; error?: string; documentBytes?: Uint8Array };
  }
}

/** Proxy colours in the pilot stack. */
const PILOT_PROXY_COLOURS = { line: 8, area: 3, point: 8, text: 8 };

/** Proxy colours for a document's own stack: lines / points / text in its darkest colour, areas in its lightest non-white one. */
function documentProxyColours(colours: render.ColourStack): { line: number; area: number; point: number; text: number } {
  if (!colours.length) return { line: 0, area: 0, point: 0, text: 0 };
  const lum = (i: number) => {
    const [c, m, y, k] = colours[i].cmyk;
    return (1 - Math.min(1, k)) * (3 - Math.min(1, c) - Math.min(1, m) - Math.min(1, y));
  };
  let dark = 0, light = 0;
  for (let i = 1; i < colours.length; i++) {
    if (lum(i) < lum(dark)) dark = i;
    if (lum(i) > lum(light) && lum(i) < 2.9) light = i;
  }
  return { line: dark, area: light, point: dark, text: dark };
}

const FONT_FILES: [render.FontFamily, string][] = [
  ["liberation-sans", liberationSansUrl],
  ["liberation-sans-narrow", liberationSansNarrowUrl],
];
let fontBytesPromise: Promise<{ family: render.FontFamily; bytes: ArrayBuffer }[]> | undefined;
function loadFontBytes(): Promise<{ family: render.FontFamily; bytes: ArrayBuffer }[]> {
  fontBytesPromise ??= Promise.all(FONT_FILES.map(async ([family, url]) => ({ family, bytes: await (await fetch(url)).arrayBuffer() })));
  return fontBytesPromise;
}
async function loadFonts(): Promise<render.TrueTypeFont[]> {
  return (await loadFontBytes()).map((f) => render.parseTrueType(f.bytes, f.family));
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}
function summarise(xs: number[]): Summary {
  const s = [...xs].sort((a, b) => a - b);
  const avg = s.reduce((a, b) => a + b, 0) / (s.length || 1);
  return { avg: r(avg), p50: r(pct(s, 0.5)), p95: r(pct(s, 0.95)), max: r(s[s.length - 1] ?? 0) };
}
const r = (x: number) => Math.round(x * 100) / 100;
const nextFrame = () => new Promise<void>((res) => requestAnimationFrame(() => res()));

export function MapGlDocPage() {
  const [params] = useSearchParams();
  const modeParam = params.get("mode");
  const mode: Mode = modeParam === "envelope" || modeParam === "pilot" ? modeParam : "source";
  const url = params.get("url");
  const via: LoadReport["via"] = params.get("via") === "reader" && mode !== "source" ? "reader" : "document";
  const useWorker = params.get("worker") !== "0";
  const gate = params.get("gate") !== "0";
  const budgetMB = Number(params.get("budget") ?? 150) || 150;
  const autoBench = params.get("bench") === "1";
  const compare = params.get("compare") === "1";
  const kindsParam = params.get("kinds");
  const lod = params.get("lod") !== "0";

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const compareRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<MapGlRenderer>(null);
  const engineRef = useRef<MapGlEngine | null>(null);
  const viewRef = useRef<View | null>(null);
  const fitRef = useRef<View | null>(null);
  const denseRef = useRef<View | null>(null);
  const colourRef = useRef<(i: number) => [number, number, number]>(() => [0, 0, 0]);
  const kindsRef = useRef<NonNullable<Parameters<MapGlEngine["render"]>[0]["kinds"]> | undefined>(
    kindsParam ? new Set(kindsParam.split(",") as ("fill" | "hatch" | "stroke" | "glyph" | "clip" | "text")[]) : undefined,
  );
  const transportRef = useRef<Transport | null>(null);
  const lodRef = useRef(lod);
  const dirtyRef = useRef(false);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [message, setMessage] = useState("");
  const [load, setLoad] = useState<LoadReport | null>(null);
  const [bench, setBench] = useState<BenchReport | null>(null);
  const [frame, setFrame] = useState<FrameStats | null>(null);
  const [engineStats, setEngineStats] = useState<EngineStats | null>(null);
  const [benchRunning, setBenchRunning] = useState(false);

  const draw = useCallback((): FrameStats | null => {
    const renderer = rendererRef.current;
    const view = viewRef.current;
    if (!renderer || !view) return null;
    const engine = engineRef.current;
    if (!engine) return null;
    {
      const t0 = performance.now();
      engine.setView(view);
      const stats = engine.render({
        colour: colourRef.current,
        ...(kindsRef.current ? { kinds: kindsRef.current } : {}),
        // lod=0: no screen-only skips (glyph < 2 px, hatch tint) — for attributing their effect.
        ...(lodRef.current ? {} : { minGlyphPx: 0, hatchTintPx: 0 }),
      });
      stats.cpuMs = performance.now() - t0;
      return stats;
    }
  }, []);

  const requestDraw = useCallback(() => {
    if (dirtyRef.current) return;
    dirtyRef.current = true;
    requestAnimationFrame(() => {
      dirtyRef.current = false;
      const s = draw();
      if (s) setFrame(s);
      if (engineRef.current) setEngineStats(engineRef.current.stats());
    });
  }, [draw]);

  // Canvas sized to the window in device pixels.
  const sizeCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return { w: 1, h: 1 };
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || window.innerWidth;
    const cssH = canvas.clientHeight || Math.max(200, window.innerHeight - 160);
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    if (viewRef.current) {
      viewRef.current.widthPx = w;
      viewRef.current.heightPx = h;
    }
    return { w, h };
  }, []);

  const loadDocument = useCallback(
    async (bytes: ArrayBuffer, name: string) => {
      setStatus("loading");
      setBench(null);
      window.__mapGlDoc = {};
      try {
        const canvas = canvasRef.current!;
        const { w, h } = sizeCanvas();
        rendererRef.current ??= new MapGlRenderer(canvas, { preserveDrawingBuffer: true });
        const renderer = rendererRef.current;
        engineRef.current?.dispose();
        engineRef.current = null;
        const fontBytes = await loadFontBytes();

        // Main-thread long tasks during the load: what the worker keeps off this thread.
        const longTasks: number[] = [];
        let observer: PerformanceObserver | undefined;
        try {
          observer = new PerformanceObserver((list) => { for (const e of list.getEntries()) longTasks.push(e.duration); });
          observer.observe({ type: "longtask", buffered: false });
        } catch { /* longtask timing unsupported */ }
        const tStart = performance.now();
        let documentReport: DocumentReport | undefined;
        let encodedDocument: Uint8Array | undefined;
        let readerInput: { objects: render.RenderObject[]; symbols: render.RenderSymbol[]; stats: render.OcadConvertResult["stats"] } | undefined;
        let header: mapDocument.MapDocumentHeader | undefined;
        let colourHex: (i: number) => string = (i) => render.pilotColours[i]?.hex ?? "#ff00ff";
        const isDocument = bytes.byteLength >= 4 && new TextDecoder().decode(new Uint8Array(bytes, 0, 4)) === mapDocument.MAP_DOCUMENT_MAGIC;
        let msHash = 0, msNormalise = 0, msMatch = 0, msEncode = 0;
        if (via === "document" || isDocument) {
          const pilotByCode = new Map(render.pilotSymbols.map((sym) => [sym.code, sym]));
          if (isDocument) {
            encodedDocument = new Uint8Array(bytes);
          } else {
            // Mapper files are XML and need no reader dependency; OCAD goes through ocad2geojson.
            const isOmap = mapImport.looksLikeOmap(new TextDecoder().decode(new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 1024))));
            let normalise: (fileHash: string) => mapDocument.MapDocumentInput;
            if (isOmap) {
              const omap = mapImport.readOmap(new TextDecoder().decode(bytes));
              normalise = (fileHash) => mapImport.omapToDocumentInput(omap, { fileName: name, fileHash, fileBytes: bytes.byteLength }).input;
            } else {
              const ocadMod = await import("ocad2geojson");
              const readOcad = (ocadMod as Record<string, unknown>).readOcad as (buf: Buffer, opts?: Record<string, unknown>) => Promise<mapImport.OcadFileLike>;
              const ocad = await readOcad(Buffer.from(bytes), { quietWarnings: true });
              normalise = (fileHash) => mapImport.ocadToDocumentInput(ocad, {
                fileName: name, fileHash, fileBytes: bytes.byteLength,
                renderFor: mode === "source" ? undefined : (sym) => pilotByCode.get(String(Math.floor(sym.symNum / 1000))) ?? null,
              }).input;
            }
            const tRead = performance.now();
            const fileHash = await mapDocument.mapDocumentHash(new Uint8Array(bytes));
            const tHash = performance.now();
            const input = normalise(fileHash);
            const tNorm = performance.now();
            // Stages 6–7 only for source renders: the pilot renders carry their own palette.
            const document = mode === "source" ? mapImport.matchDocument(input).input : input;
            const tMatch = performance.now();
            encodedDocument = mapDocument.encodeMapDocument(document);
            msHash = tHash - tRead;
            msNormalise = tNorm - tHash;
            msMatch = tMatch - tNorm;
            msEncode = performance.now() - tMatch;
          }
          const h0 = mapDocument.readMapDocumentHeader(encodedDocument);
          header = h0.header;
          const hdr = h0.header;
          if (mode === "source") {
            const hex = hdr.colours.map((c) => render.cmykToHex(c.cmyk));
            colourHex = (i) => hex[i] ?? "#ff00ff";
          }
          const sec = hdr.objects.sections;
          const docWarnings: Record<string, number> = {};
          for (const wn of hdr.warnings) docWarnings[wn.code] = wn.count;
          documentReport = {
            bytes: encodedDocument.byteLength, headerBytes: h0.bodyOffset,
            sections: { attrs: sec.attrs.length, bboxes: sec.bboxes.length, geometry: sec.geometry.length },
            ms: { hash: r(msHash), normalise: r(msNormalise), match: r(msMatch), encode: r(msEncode), decode: 0 },
            hash: await mapDocument.mapDocumentHash(encodedDocument),
            objects: hdr.objects.count, symbols: hdr.symbols.length, canonicalSymbols: 0, colours: hdr.colours.length,
            warnings: docWarnings,
            native: isDocument,
          };
        } else {
          const ocadMod = await import("ocad2geojson");
          const readOcad = (ocadMod as Record<string, unknown>).readOcad as (buf: Buffer, opts?: Record<string, unknown>) => Promise<{ objects: render.OcadObjectLike[] }>;
          const ocad = await readOcad(Buffer.from(bytes), { quietWarnings: true });
          readerInput = render.ocadObjectsToRender(ocad.objects, render.pilotSymbols, { mode: mode === "source" ? "envelope" : mode, proxyColours: PILOT_PROXY_COLOURS });
        }
        const bridgeOptions: mapDocument.DocumentRenderOptions = {
          unmatched: mode === "pilot" ? "drop" : "proxy",
          proxyColours: mode === "source" && header ? documentProxyColours(header.colours) : PILOT_PROXY_COLOURS,
        };
        const t1 = performance.now();
        colourRef.current = (i) => hexToRgb(colourHex(i));
        const fitFor = (b: render.Bounds | undefined): View => fitView(b, w, h, 0.95);
        const paper1x = (window.devicePixelRatio || 1) * (96 / 25.4) / 1000;

        let report: LoadReport;
        {
          // The worker is started when the page mounts (B4: when the viewer mounts), not on load.
          const transport = transportRef.current ?? (useWorker ? workerTransport() : inlineTransport());
          transportRef.current = null;
          const engine = new MapGlEngine(renderer, transport, { budgetBytes: budgetMB * 1024 * 1024, gate });
          engineRef.current = engine;
          engine.onChange = requestDraw;
          const source = encodedDocument
            ? { kind: "document" as const, bytes: encodedDocument.slice().buffer as ArrayBuffer, options: bridgeOptions }
            : { kind: "objects" as const, objects: readerInput!.objects, symbols: readerInput!.symbols };
          const tPost = performance.now();
          const summary = await engine.load({
            source, fonts: fontBytes.map((f) => ({ family: f.family, bytes: f.bytes.slice(0) })),
            firstView: { kind: "fit", widthPx: w, heightPx: h, fill: 0.95 },
          });
          renderer.gl.finish();
          const tLoaded = performance.now();
          const fit: View = { ...(summary.view ?? fitFor(summary.bounds)) };
          fitRef.current = { ...fit };
          viewRef.current = { ...fit };
          const g = summary.grid;
          const dc = summary.densestCell;
          denseRef.current = {
            ...fit, pxPerUm: paper1x,
            centreX: dc >= 0 ? (g.minCol + (dc % g.cols) + 0.5) * g.cellUm : fit.centreX,
            centreY: dc >= 0 ? (g.minRow + Math.floor(dc / g.cols) + 0.5) * g.cellUm : fit.centreY,
          };
          const first = draw()!;
          renderer.gl.finish();
          const tFirst = performance.now();
          await engine.whenComplete();
          const complete = draw()!;
          renderer.gl.finish();
          const tComplete = performance.now();
          const es = engine.stats();
          const gpu = renderer.documentBytes;
          const b = summary.bridge;
          const objects: render.OcadConvertResult["stats"] = b
            ? { total: b.total, matched: b.rendered, proxied: b.proxied, dropped: b.dropped + b.hidden, coordinates: b.coordinates, unmatched: [] }
            : readerInput!.stats;
          if (documentReport && b) {
            documentReport.ms.decode = summary.ms.decode;
            documentReport.canonicalSymbols = b.canonicalSymbols;
          }
          const prep = [...es.prepareMs].sort((x, y) => x - y);
          report = {
            file: name, bytes: bytes.byteLength, mode, via: documentReport ? "document" : "reader", document: documentReport, objects,
            ms: {
              read: r(t1 - tStart), convert: r(summary.ms.decode + summary.ms.bridge), symbolise: summary.ms.symbolise,
              prepare: r(summary.ms.atlas + summary.ms.assign + summary.ms.base + summary.ms.large),
              load: r(tLoaded - tPost), firstFrame: r(tFirst - tLoaded), complete: r(tComplete - tFirst), total: r(tComplete - tStart),
            },
            passes: summary.passes, passKinds: summary.passKinds, colours: summary.colours,
            arena: {
              worker: useWorker, gate, budgetMB, grid: summary.grid, detailCells: summary.detailCells.length, largeObjects: summary.objects.large,
              ms: summary.ms, bytes: summary.bytes, gpu, engine: es,
              prepareMs: { n: prep.length, p50: r(pct(prep, 0.5)), p95: r(pct(prep, 0.95)), max: r(prep[prep.length - 1] ?? 0) },
            },
            gpuBytes: gpu.total,
            firstFrame: first, completeFrame: complete,
            dpr: window.devicePixelRatio || 1, canvasPx: { w, h }, gpuTimer: renderer.hasGpuTimer, warnings: summary.warnings,
          };
          setEngineStats(es);
        }
        observer?.disconnect();
        report.mainThread = { longTasks: longTasks.length, longestMs: r(Math.max(0, ...longTasks)), totalMs: r(longTasks.reduce((a, b) => a + b, 0)) };
        setLoad(report);
        setFrame(report.completeFrame);
        window.__mapGlDoc = { load: report, documentBytes: encodedDocument };

        if (compare) {
          // The same stream through the per-pass golden path (§5.2 Drawing; checked against the reference raster by the golden spec).
          const fonts = await loadFonts();
          let objs = readerInput;
          if (encodedDocument) {
            const bridge = mapDocument.documentRenderInput(mapDocument.decodeMapDocument(encodedDocument), bridgeOptions);
            objs = { objects: bridge.objects, symbols: bridge.symbols, stats: readerInput?.stats ?? report.objects };
          }
          const s = render.symbolise({ objects: objs!.objects, symbols: objs!.symbols, fonts }).stream;
          const fit = fitRef.current!;
          // Zoomed so a 0.14 mm line is ≥ 1.5 px: the two paths' hairline floors (§5.2) do not differ there.
          const view: View = { ...fit, pxPerUm: Math.max(fit.pxPerUm, 1.5 / 140) };
          viewRef.current = { ...view };
          draw();
          renderer.gl.finish();
          const c2 = compareRef.current!;
          c2.width = w;
          c2.height = h;
          const other = new MapGlRenderer(c2, { preserveDrawingBuffer: true });
          other.setStream(prepareStream(s, { fonts }));
          other.render(view, { colour: colourRef.current });
          other.gl.finish();
          const read = (gl: WebGL2RenderingContext) => {
            const px = new Uint8Array(w * h * 4);
            gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
            return px;
          };
          const a = read(renderer.gl), bpx = read(other.gl);
          let differing = 0;
          for (let i = 0; i < a.length; i += 4) {
            const d = Math.max(Math.abs(a[i] - bpx[i]), Math.abs(a[i + 1] - bpx[i + 1]), Math.abs(a[i + 2] - bpx[i + 2]));
            if (d > 64) differing++;
          }
          other.dispose();
          const cmp: CompareReport = { pxPerUm: view.pxPerUm, total: w * h, differing, fraction: differing / (w * h) };
          window.__mapGlDoc = { ...window.__mapGlDoc, compare: cmp };
          viewRef.current = { ...fit };
          requestDraw();
        }
        setStatus("ready");
      } catch (e) {
        console.error(e);
        const msg = e instanceof Error ? e.message : String(e);
        setMessage(msg);
        window.__mapGlDoc = { error: msg };
        setStatus("error");
      }
    },
    [draw, mode, via, useWorker, gate, budgetMB, compare, sizeCanvas, requestDraw],
  );

  const runScenario = useCallback(
    async (viewAt: (u: number) => View): Promise<ScenarioReport> => {
      const frames = 240;
      const cpu: number[] = [], gpu: number[] = [], dt: number[] = [];
      let draws = 0, maxDraws = 0, maxResident = 0, incomplete = 0, overBudget = 0;
      const engine = engineRef.current;
      const s0 = engine?.stats();
      const t0 = performance.now();
      let last = t0;
      for (let i = 0; i < frames; i++) {
        await nextFrame();
        const now = performance.now();
        if (i > 0) dt.push(now - last);
        last = now;
        viewRef.current = viewAt(i / (frames - 1));
        const s = draw();
        if (s) {
          cpu.push(s.cpuMs);
          if (s.gpuMs !== undefined) gpu.push(s.gpuMs);
          draws = s.drawCalls;
          maxDraws = Math.max(maxDraws, s.drawCalls);
        }
        if (engine) {
          const es = engine.stats();
          maxResident = Math.max(maxResident, es.residentBytes);
          if (es.pending > 0 && !es.gated) incomplete++;
          if (es.overBudget) overBudget++;
        }
      }
      const seconds = (performance.now() - t0) / 1000;
      const s1 = engine?.stats();
      return {
        frames, seconds: r(seconds), fps: r(frames / seconds), cpuMs: summarise(cpu),
        ...(gpu.length ? { gpuMs: summarise(gpu) } : {}),
        frameMs: { ...summarise(dt) }, drawCalls: draws, maxDrawCalls: maxDraws,
        ...(engine && s0 && s1
          ? { maxResidentBytes: maxResident, rebuilds: s1.rebuilds - s0.rebuilds, incompleteFrames: incomplete, evictions: s1.evictions - s0.evictions, overBudgetFrames: overBudget }
          : {}),
      };
    },
    [draw],
  );

  const runBench = useCallback(async () => {
    const fit = fitRef.current;
    const dense = denseRef.current;
    if (!fit || !dense || !viewRef.current) return;
    setBenchRunning(true);
    // Zoom in to 4× and back while panning across a third of the document.
    const fitReport = await runScenario((u) => {
      const zoom = 1 + 3 * Math.sin(u * Math.PI);
      const pan = Math.sin(u * 2 * Math.PI);
      return { ...fit, pxPerUm: fit.pxPerUm * zoom, centreX: fit.centreX + (pan * fit.widthPx) / fit.pxPerUm / 6, centreY: fit.centreY + (pan * fit.heightPx) / fit.pxPerUm / 8 };
    });
    // 1× paper at the device pixel ratio, panning one cell either side of the densest cell.
    const paper = await runScenario((u) => ({ ...dense, centreX: dense.centreX + 50_000 * Math.sin(u * 2 * Math.PI), centreY: dense.centreY + 25_000 * Math.sin(u * 4 * Math.PI) }));
    const report: BenchReport = { ...fitReport, paper1x: paper };
    setBench(report);
    window.__mapGlDoc = { ...(window.__mapGlDoc ?? {}), bench: report };
    viewRef.current = { ...fit };
    requestDraw();
    setBenchRunning(false);
  }, [runScenario, requestDraw]);

  // ?url= autoload
  useEffect(() => {
    if (!url) return;
    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
        await loadDocument(await res.arrayBuffer(), url.split("/").pop() ?? url);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setMessage(msg);
        window.__mapGlDoc = { error: msg };
        setStatus("error");
      }
    })();
  }, [url, loadDocument]);

  useEffect(() => {
    if (status === "ready" && autoBench && !bench && !benchRunning) void runBench();
  }, [status, autoBench, bench, benchRunning, runBench]);

  // Resize + gestures.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onResize = () => {
      sizeCanvas();
      requestDraw();
    };
    window.addEventListener("resize", onResize);
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch: { dist: number; pxPerUm: number } | null = null;
    const dpr = () => window.devicePixelRatio || 1;
    const onDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2 && viewRef.current) {
        const [a, b] = [...pointers.values()];
        pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), pxPerUm: viewRef.current.pxPerUm };
      }
    };
    const onMove = (e: PointerEvent) => {
      const prev = pointers.get(e.pointerId);
      const view = viewRef.current;
      if (!prev || !view) return;
      if (pointers.size === 1) {
        view.centreX -= ((e.clientX - prev.x) * dpr()) / view.pxPerUm;
        view.centreY += ((e.clientY - prev.y) * dpr()) / view.pxPerUm;
      }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2 && pinch) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        view.pxPerUm = pinch.pxPerUm * (d / pinch.dist);
      }
      requestDraw();
    };
    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
    };
    const onWheel = (e: WheelEvent) => {
      const view = viewRef.current;
      if (!view) return;
      e.preventDefault();
      const f = Math.exp(-e.deltaY * 0.0015);
      const rect = canvas.getBoundingClientRect();
      const px = (e.clientX - rect.left) * dpr() - view.widthPx / 2;
      const py = view.heightPx / 2 - (e.clientY - rect.top) * dpr();
      // Keep the paper point under the cursor fixed.
      view.centreX += px / view.pxPerUm - px / (view.pxPerUm * f);
      view.centreY += py / view.pxPerUm - py / (view.pxPerUm * f);
      view.pxPerUm *= f;
      requestDraw();
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [requestDraw, sizeCanvas]);

  useEffect(() => {
    transportRef.current ??= useWorker ? workerTransport() : inlineTransport();
    return () => {
      engineRef.current?.dispose();
      engineRef.current = null;
      transportRef.current?.terminate();
      transportRef.current = null;
    };
  }, [useWorker]);
  useEffect(() => () => rendererRef.current?.dispose(), []);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) await loadDocument(await f.arrayBuffer(), f.name);
  };

  const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
  const query = (m: string) => {
    const q = new URLSearchParams(params);
    q.set("mode", m);
    return `/dev/map-gl-doc?${q.toString()}`;
  };

  return (
    <div className="h-screen flex flex-col bg-slate-100 font-mono text-xs text-slate-800">
      <div className="p-2 flex flex-wrap items-center gap-3 border-b border-slate-300 bg-white">
        <input type="file" accept=".ocd,.omap,.xmap,.oxvm" onChange={onFile} data-testid="map-gl-doc-file" />
        <span>mode: <b>{mode}</b> · worker {useWorker ? "on" : "off"} · gate {gate ? "on" : "off"} · budget {budgetMB} MB</span>
        {(["source", "pilot", "envelope"] as Mode[]).filter((m) => m !== mode).map((m) => (
          <a key={m} className="underline" href={query(m)}>
            switch to {m}
          </a>
        ))}
        <button
          className="px-2 py-0.5 rounded border border-slate-400 bg-slate-50 disabled:opacity-50"
          onClick={() => void runBench()}
          disabled={status !== "ready" || benchRunning}
          data-testid="map-gl-doc-bench"
        >
          {benchRunning ? "benchmarking…" : "bench (2 × 240 frames)"}
        </button>
        <button className="px-2 py-0.5 rounded border border-slate-400 bg-slate-50" onClick={() => { if (fitRef.current) { viewRef.current = { ...fitRef.current }; requestDraw(); } }}>
          fit
        </button>
        <button className="px-2 py-0.5 rounded border border-slate-400 bg-slate-50" onClick={() => { if (denseRef.current) { viewRef.current = { ...denseRef.current }; requestDraw(); } }}>
          1× paper
        </button>
        {status === "loading" && <span>loading…</span>}
        {status === "error" && <span className="text-red-700" data-testid="map-gl-doc-error">error: {message}</span>}
      </div>
      <div className="p-2 grid grid-cols-1 md:grid-cols-3 gap-x-6 gap-y-1 bg-white border-b border-slate-300" data-testid="map-gl-doc-stats">
        {load && (
          <>
            <div>
              <b>{load.file}</b> {mb(load.bytes)} · objects {load.objects.total} (matched {load.objects.matched}, proxied {load.objects.proxied}, dropped {load.objects.dropped}) · coords {load.objects.coordinates}
              <br />
              read {load.ms.read} · convert {load.ms.convert} · symbolise {load.ms.symbolise} · prepare {load.ms.prepare} · load {load.ms.load} · first frame {load.ms.firstFrame}
              {" "}· complete {load.ms.complete} · <b>total {load.ms.total} ms</b>
              {load.arena && (
                <span data-testid="map-gl-doc-arena">
                  <br />
                  cells {load.arena.grid.cols}×{load.arena.grid.rows} ({load.arena.detailCells} with detail) · large objects {load.arena.largeObjects} · resident: base {mb(load.arena.bytes.base)}, large {mb(load.arena.bytes.large)}, atlas {mb(load.arena.bytes.atlas)} · bucket prepare p95 {load.arena.prepareMs.p95} ms (n {load.arena.prepareMs.n})
                </span>
              )}
            </div>
            <div>
              passes {load.passes} ({Object.entries(load.passKinds).map(([k, v]) => `${k} ${v}`).join(", ")}) · colours {load.colours}
              <br />
              GPU <b>{mb(load.gpuBytes)}</b>
              {load.arena && <> (arenas {mb(load.arena.gpu.arenas)}, visible set {mb(load.arena.gpu.visibleSet)})</>}
              <br />
              canvas {load.canvasPx.w}×{load.canvasPx.h} @ {load.dpr}× · GPU timer {load.gpuTimer ? "yes" : "no"}
              {Object.keys(load.warnings).length > 0 && <> · warnings {JSON.stringify(load.warnings)}</>}
              <br />
              via <b>{load.via}</b>
              {load.document && (
                <span data-testid="map-gl-doc-document">
                  {" "}· document {mb(load.document.bytes)} (header {(load.document.headerBytes / 1024).toFixed(0)} KB, attrs {mb(load.document.sections.attrs)}, bboxes {mb(load.document.sections.bboxes)}, geometry {mb(load.document.sections.geometry)})
                  {" "}· {load.document.native ? "native" : `hash ${load.document.ms.hash} · normalise ${load.document.ms.normalise} · match ${load.document.ms.match} · encode ${load.document.ms.encode}`} · <b>decode {load.document.ms.decode} ms</b>
                  {" "}· {load.document.objects} objects, {load.document.symbols} symbols ({load.document.canonicalSymbols} canonical), {load.document.colours} colours · {load.document.hash.slice(0, 12)}…
                  {Object.keys(load.document.warnings).length > 0 && <> · {JSON.stringify(load.document.warnings)}</>}
                </span>
              )}
            </div>
            <div>
              frame: draws <b>{frame?.drawCalls}</b> · cpu {frame?.cpuMs.toFixed(2)} ms{frame?.gpuMs !== undefined && <> · gpu {frame.gpuMs.toFixed(2)} ms</>}
              {engineStats && <> · cells {engineStats.drawnDetail}/{engineStats.drawnCells}{engineStats.gated ? " (gated)" : ""} · pending {engineStats.pending} · resident {mb(engineStats.residentBytes)}{engineStats.overBudget ? " OVER BUDGET" : ""} · evictions {engineStats.evictions}</>}
              <br />
              {bench && (
                <span data-testid="map-gl-doc-bench-result">
                  bench fit: {bench.fps} fps · frame avg {bench.frameMs.avg} p95 {bench.frameMs.p95} · cpu avg {bench.cpuMs.avg} p95 {bench.cpuMs.p95} max {bench.cpuMs.max}
                  {bench.gpuMs && <> · gpu avg {bench.gpuMs.avg} p95 {bench.gpuMs.p95} max {bench.gpuMs.max}</>} · draws max {bench.maxDrawCalls}
                  {bench.paper1x && (
                    <>
                      <br />
                      bench 1× paper: {bench.paper1x.fps} fps · cpu avg {bench.paper1x.cpuMs.avg} p95 {bench.paper1x.cpuMs.p95}
                      {bench.paper1x.gpuMs && <> · gpu avg {bench.paper1x.gpuMs.avg} p95 {bench.paper1x.gpuMs.p95}</>} · draws max {bench.paper1x.maxDrawCalls}
                      {bench.paper1x.maxResidentBytes !== undefined && <> · resident max {mb(bench.paper1x.maxResidentBytes)} · incomplete frames {bench.paper1x.incompleteFrames}</>}
                    </>
                  )}
                </span>
              )}
            </div>
          </>
        )}
      </div>
      <canvas
        ref={canvasRef}
        className="flex-1 w-full touch-none bg-white"
        data-testid="map-gl-doc-canvas"
        data-ready={status === "ready" ? "true" : undefined}
        data-bench={bench ? "done" : undefined}
      />
      {compare && <canvas ref={compareRef} className="hidden" data-testid="map-gl-doc-compare" />}
    </div>
  );
}
