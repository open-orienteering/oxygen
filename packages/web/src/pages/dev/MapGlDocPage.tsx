/**
 * Dev-only measurement page for the WebGL2 map backend on real documents
 * (`/dev/map-gl-doc`, spike S1 step 4; docs/map-rendering.md §5.2).
 *
 * Loads an `.ocd`, `.omap` / `.xmap` or `.oxvm` (file picker, or `?url=` — in dev Vite serves any file
 * under the repo as `/@fs/<abs path>`), runs it through
 * `readOcad → ocadToDocumentInput → matchDocument (source mode) → encode → decode → documentRenderInput
 * → symbolise → prepareStream → buildBatches → GPU` (`via=document`,
 * the default; an `.oxvm` skips straight to decode) or through the S1
 * step-4 converter (`via=reader`), draws it full-window at the device pixel ratio
 * and reports every stage's time, the batch counts, GPU bytes and the
 * per-frame cost. "Bench" animates a zoom + pan for 240 frames and
 * reports frame-time percentiles; `?bench=1` runs it after loading.
 * Results are also published as `window.__mapGlDoc` for Playwright.
 *
 * Query: `mode=source|pilot|envelope` (default source), `via=document|reader`,
 * `url=`, `bench=1`. `source` draws the document's own symbol definitions
 * (the OCAD → IR conversion, docs/map-import.md §3.3) in the document's
 * colours; `pilot` / `envelope` swap in the S1 pilot family by code.
 * `source` always goes via the document.
 * Not routed in production builds.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Buffer } from "buffer";
import { mapDocument, mapImport, render } from "@oxygen/shared";
import { prepareStream, type PreparedStream } from "../../map-gl/prepare";
import { buildBatches, type Batch, type BatchStats } from "../../map-gl/batch";
import { MapGlRenderer, hexToRgb, type FrameStats, type View } from "../../map-gl/renderer";
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

interface LoadReport {
  file: string;
  bytes: number;
  mode: Mode;
  /** `document`: reader → normalise → encode → decode → bridge; `reader`: the S1 step-4 converter. */
  via: "document" | "reader";
  document?: DocumentReport;
  objects: render.OcadConvertResult["stats"];
  ms: { read: number; convert: number; symbolise: number; prepare: number; batch: number; upload: number; firstFrame: number; total: number };
  passes: number;
  passKinds: Record<string, number>;
  colours: number;
  batch: BatchStats;
  gpuBytes: number;
  firstFrame: FrameStats;
  dpr: number;
  canvasPx: { w: number; h: number };
  gpuTimer: boolean;
  warnings: Record<string, number>;
}

interface BenchReport {
  frames: number;
  seconds: number;
  fps: number;
  cpuMs: { avg: number; p50: number; p95: number; max: number };
  gpuMs?: { avg: number; p50: number; p95: number; max: number };
  frameMs: { avg: number; p95: number; max: number };
  drawCalls: number;
}

declare global {
  interface Window {
    __mapGlDoc?: { load?: LoadReport; bench?: BenchReport; error?: string; documentBytes?: Uint8Array };
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

let fontsPromise: Promise<render.TrueTypeFont[]> | undefined;
function loadFonts(): Promise<render.TrueTypeFont[]> {
  fontsPromise ??= Promise.all(
    (
      [
        ["liberation-sans", liberationSansUrl],
        ["liberation-sans-narrow", liberationSansNarrowUrl],
      ] as [render.FontFamily, string][]
    ).map(async ([family, url]) => render.parseTrueType(await (await fetch(url)).arrayBuffer(), family)),
  );
  return fontsPromise;
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}
function summarise(xs: number[]): { avg: number; p50: number; p95: number; max: number } {
  const s = [...xs].sort((a, b) => a - b);
  const avg = s.reduce((a, b) => a + b, 0) / (s.length || 1);
  return { avg: r(avg), p50: r(pct(s, 0.5)), p95: r(pct(s, 0.95)), max: r(s[s.length - 1] ?? 0) };
}
const r = (x: number) => Math.round(x * 100) / 100;

export function MapGlDocPage() {
  const [params] = useSearchParams();
  const modeParam = params.get("mode");
  const mode: Mode = modeParam === "envelope" || modeParam === "pilot" ? modeParam : "source";
  const url = params.get("url");
  const via: LoadReport["via"] = params.get("via") === "reader" && mode !== "source" ? "reader" : "document";
  const autoBench = params.get("bench") === "1";

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<MapGlRenderer>(null);
  const viewRef = useRef<View | null>(null);
  const fitRef = useRef<View | null>(null);
  const colourRef = useRef<(i: number) => [number, number, number]>(() => [0, 0, 0]);
  const lastFrameRef = useRef<FrameStats | null>(null);
  const dirtyRef = useRef(false);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [message, setMessage] = useState("");
  const [load, setLoad] = useState<LoadReport | null>(null);
  const [bench, setBench] = useState<BenchReport | null>(null);
  const [frame, setFrame] = useState<FrameStats | null>(null);
  const [benchRunning, setBenchRunning] = useState(false);

  const draw = useCallback((): FrameStats | null => {
    const renderer = rendererRef.current;
    const view = viewRef.current;
    if (!renderer || !view) return null;
    const stats = renderer.renderBatches(view, { colour: colourRef.current });
    lastFrameRef.current = stats;
    return stats;
  }, []);

  const requestDraw = useCallback(() => {
    if (dirtyRef.current) return;
    dirtyRef.current = true;
    requestAnimationFrame(() => {
      dirtyRef.current = false;
      const s = draw();
      if (s) setFrame(s);
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
        const fonts = await loadFonts();
        const canvas = canvasRef.current!;
        const { w, h } = sizeCanvas();
        rendererRef.current ??= new MapGlRenderer(canvas, { preserveDrawingBuffer: true });
        const renderer = rendererRef.current;

        const tStart = performance.now();
        let conv: { objects: render.RenderObject[]; symbols: render.RenderSymbol[]; stats: render.OcadConvertResult["stats"] };
        let documentReport: DocumentReport | undefined;
        let encodedDocument: Uint8Array | undefined;
        let t1: number;
        let colourHex: (i: number) => string = (i) => render.pilotColours[i]?.hex ?? "#ff00ff";
        const isDocument = bytes.byteLength >= 4 && new TextDecoder().decode(new Uint8Array(bytes, 0, 4)) === mapDocument.MAP_DOCUMENT_MAGIC;
        if (via === "document" || isDocument) {
          const pilotByCode = new Map(render.pilotSymbols.map((sym) => [sym.code, sym]));
          let encoded: Uint8Array;
          let msHash = 0, msNormalise = 0, msMatch = 0, msEncode = 0;
          if (isDocument) {
            encoded = new Uint8Array(bytes);
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
            encoded = mapDocument.encodeMapDocument(document);
            msHash = tHash - tRead;
            msNormalise = tNorm - tHash;
            msMatch = tMatch - tNorm;
            msEncode = performance.now() - tMatch;
          }
          encodedDocument = encoded;
          const tDec = performance.now();
          const doc = mapDocument.decodeMapDocument(encoded);
          const tDecEnd = performance.now();
          const bridge = mapDocument.documentRenderInput(doc, {
            unmatched: mode === "pilot" ? "drop" : "proxy",
            proxyColours: mode === "source" ? documentProxyColours(doc.header.colours) : PILOT_PROXY_COLOURS,
          });
          if (mode === "source") {
            const hex = doc.header.colours.map((c) => render.cmykToHex(c.cmyk));
            colourHex = (i) => hex[i] ?? "#ff00ff";
          }
          t1 = performance.now();
          conv = {
            objects: bridge.objects,
            symbols: bridge.symbols,
            stats: { total: bridge.stats.total, matched: bridge.stats.rendered, proxied: bridge.stats.proxied, dropped: bridge.stats.dropped + bridge.stats.hidden, coordinates: bridge.stats.coordinates, unmatched: [] },
          };
          const { bodyOffset } = mapDocument.readMapDocumentHeader(encoded);
          const sec = doc.header.objects.sections;
          const docWarnings: Record<string, number> = {};
          for (const wn of doc.header.warnings) docWarnings[wn.code] = wn.count;
          documentReport = {
            bytes: encoded.byteLength, headerBytes: bodyOffset,
            sections: { attrs: sec.attrs.length, bboxes: sec.bboxes.length, geometry: sec.geometry.length },
            ms: { hash: r(msHash), normalise: r(msNormalise), match: r(msMatch), encode: r(msEncode), decode: r(tDecEnd - tDec) },
            hash: await mapDocument.mapDocumentHash(encoded),
            objects: doc.header.objects.count, symbols: doc.header.symbols.length, canonicalSymbols: bridge.stats.canonicalSymbols, colours: doc.header.colours.length,
            warnings: docWarnings,
            native: isDocument,
          };
        } else {
          const ocadMod = await import("ocad2geojson");
          const readOcad = (ocadMod as Record<string, unknown>).readOcad as (
            buf: Buffer,
            opts?: Record<string, unknown>,
          ) => Promise<{ objects: render.OcadObjectLike[] }>;
          const ocad = await readOcad(Buffer.from(bytes), { quietWarnings: true });
          t1 = performance.now();
          conv = render.ocadObjectsToRender(ocad.objects, render.pilotSymbols, { mode: mode === "source" ? "envelope" : mode, proxyColours: PILOT_PROXY_COLOURS });
        }
        const t2 = performance.now();
        const { stream, warnings } = render.symbolise({ objects: conv.objects, symbols: conv.symbols, fonts });
        const t3 = performance.now();
        const prepared: PreparedStream = prepareStream(stream, { fonts });
        const t4 = performance.now();
        const { batches, stats: batchStats } = buildBatches(prepared);
        const t5 = performance.now();
        renderer.setBatches(batches as Batch[]);
        renderer.gl.finish();
        const t6 = performance.now();

        const b = prepared.bounds ?? { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
        const pxPerUm = Math.min(w / (b.maxX - b.minX), h / (b.maxY - b.minY)) * 0.95;
        const fit: View = { centreX: (b.minX + b.maxX) / 2, centreY: (b.minY + b.maxY) / 2, pxPerUm, widthPx: w, heightPx: h };
        fitRef.current = { ...fit };
        viewRef.current = { ...fit };
        colourRef.current = (i) => hexToRgb(colourHex(i));
        const first = draw()!;
        renderer.gl.finish();
        const t7 = performance.now();

        const passKinds: Record<string, number> = {};
        for (const p of stream.passes) passKinds[p.kind] = (passKinds[p.kind] ?? 0) + 1;
        const warn: Record<string, number> = {};
        for (const wn of warnings) warn[wn.code] = (warn[wn.code] ?? 0) + 1;
        const report: LoadReport = {
          file: name,
          bytes: bytes.byteLength,
          mode,
          via: documentReport ? "document" : "reader",
          document: documentReport,
          objects: conv.stats,
          ms: {
            read: r(t1 - tStart), convert: r(t2 - t1), symbolise: r(t3 - t2), prepare: r(t4 - t3), batch: r(t5 - t4), upload: r(t6 - t5),
            firstFrame: r(t7 - t6), total: r(t7 - tStart),
          },
          passes: stream.passes.length,
          passKinds,
          colours: new Set(stream.passes.map((p) => p.colour)).size,
          batch: batchStats,
          gpuBytes: renderer.gpuBytes,
          firstFrame: first,
          dpr: window.devicePixelRatio || 1,
          canvasPx: { w, h },
          gpuTimer: renderer.hasGpuTimer,
          warnings: warn,
        };
        setLoad(report);
        setFrame(first);
        window.__mapGlDoc = { load: report, documentBytes: encodedDocument };
        setStatus("ready");
      } catch (e) {
        console.error(e);
        const msg = e instanceof Error ? e.message : String(e);
        setMessage(msg);
        window.__mapGlDoc = { error: msg };
        setStatus("error");
      }
    },
    [draw, mode, via, sizeCanvas],
  );

  const runBench = useCallback(async () => {
    const fit = fitRef.current;
    if (!fit || !viewRef.current) return;
    setBenchRunning(true);
    const frames = 240;
    const cpu: number[] = [], gpu: number[] = [], dt: number[] = [];
    let draws = 0;
    const t0 = performance.now();
    let last = t0;
    await new Promise<void>((resolve) => {
      let i = 0;
      const step = () => {
        const now = performance.now();
        if (i > 0) dt.push(now - last);
        last = now;
        // Zoom in to 4× and back while panning across a third of the document.
        const u = i / (frames - 1);
        const zoom = 1 + 3 * Math.sin(u * Math.PI);
        const pan = Math.sin(u * 2 * Math.PI);
        viewRef.current = {
          ...fit,
          pxPerUm: fit.pxPerUm * zoom,
          centreX: fit.centreX + (pan * fit.widthPx) / fit.pxPerUm / 6,
          centreY: fit.centreY + (pan * fit.heightPx) / fit.pxPerUm / 8,
        };
        const s = draw();
        if (s) {
          cpu.push(s.cpuMs);
          if (s.gpuMs !== undefined) gpu.push(s.gpuMs);
          draws = s.drawCalls;
        }
        if (++i < frames) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
    const seconds = (performance.now() - t0) / 1000;
    const report: BenchReport = {
      frames,
      seconds: r(seconds),
      fps: r(frames / seconds),
      cpuMs: summarise(cpu),
      ...(gpu.length ? { gpuMs: summarise(gpu) } : {}),
      frameMs: { ...summarise(dt) },
      drawCalls: draws,
    };
    setBench(report);
    window.__mapGlDoc = { ...(window.__mapGlDoc ?? {}), bench: report };
    viewRef.current = { ...fit };
    requestDraw();
    setBenchRunning(false);
  }, [draw, requestDraw]);

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

  useEffect(() => () => rendererRef.current?.dispose(), []);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) await loadDocument(await f.arrayBuffer(), f.name);
  };

  const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;

  return (
    <div className="h-screen flex flex-col bg-slate-100 font-mono text-xs text-slate-800">
      <div className="p-2 flex flex-wrap items-center gap-3 border-b border-slate-300 bg-white">
        <input type="file" accept=".ocd,.omap,.xmap,.oxvm" onChange={onFile} data-testid="map-gl-doc-file" />
        <span>mode: <b>{mode}</b></span>
        {(["source", "pilot", "envelope"] as Mode[]).filter((m) => m !== mode).map((m) => (
          <a key={m} className="underline" href={`/dev/map-gl-doc?mode=${m}${url ? `&url=${encodeURIComponent(url)}` : ""}`}>
            switch to {m}
          </a>
        ))}
        <button
          className="px-2 py-0.5 rounded border border-slate-400 bg-slate-50 disabled:opacity-50"
          onClick={() => void runBench()}
          disabled={status !== "ready" || benchRunning}
          data-testid="map-gl-doc-bench"
        >
          {benchRunning ? "benchmarking…" : "bench (240 frames)"}
        </button>
        <button className="px-2 py-0.5 rounded border border-slate-400 bg-slate-50" onClick={() => { if (fitRef.current) { viewRef.current = { ...fitRef.current }; requestDraw(); } }}>
          fit
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
              read {load.ms.read} · convert {load.ms.convert} · symbolise {load.ms.symbolise} · prepare {load.ms.prepare} · batch {load.ms.batch} · upload {load.ms.upload} · first frame {load.ms.firstFrame} · <b>total {load.ms.total} ms</b>
            </div>
            <div>
              passes {load.passes} ({Object.entries(load.passKinds).map(([k, v]) => `${k} ${v}`).join(", ")}) · colours {load.colours}
              <br />
              batches <b>{load.batch.batches}</b> · fill tris {load.batch.fillTriangles} · stroke tris {load.batch.strokeTriangles} · instances {load.batch.instances} · GPU <b>{mb(load.gpuBytes)}</b>
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
              <br />
              {bench && (
                <span data-testid="map-gl-doc-bench-result">
                  bench: {bench.fps} fps · frame avg {bench.frameMs.avg} p95 {bench.frameMs.p95} · cpu avg {bench.cpuMs.avg} p95 {bench.cpuMs.p95} max {bench.cpuMs.max}
                  {bench.gpuMs && <> · gpu avg {bench.gpuMs.avg} p95 {bench.gpuMs.p95} max {bench.gpuMs.max}</>} · draws {bench.drawCalls}
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
    </div>
  );
}
