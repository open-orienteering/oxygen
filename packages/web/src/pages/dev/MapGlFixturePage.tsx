/**
 * Dev-only fixture page for the WebGL2 map backend
 * (`/dev/map-gl?fixture=<golden scene>`). Draws one golden scene into a
 * canvas sized exactly like the reference raster, so Playwright can
 * screenshot the canvas and compare it with the committed golden PNG
 * (docs/map-rendering.md §6.2). `path=arena` draws the scene through the
 * arena path instead (inline worker, MSDF text from the atlas) — the
 * golden spec's MSDF text tier. Not routed in production builds.
 */

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { render } from "@oxygen/shared";
import { prepareStream } from "../../map-gl/prepare";
import { MapGlRenderer, hexToRgb, type View } from "../../map-gl/renderer";
import { MapGlEngine, inlineTransport } from "../../map-gl/engine";
import { loadMapFonts, loadTextAtlas } from "../../lib/map-fonts";
import liberationSansUrl from "../../../../shared/fonts/LiberationSans-Regular.ttf?url";
import liberationSansBoldUrl from "../../../../shared/fonts/LiberationSans-Bold.ttf?url";
import liberationSansNarrowUrl from "../../../../shared/fonts/LiberationSansNarrow-Regular.ttf?url";

const FONT_URLS: [render.FontFamily, string][] = [
  ["liberation-sans", liberationSansUrl],
  ["liberation-sans-narrow", liberationSansNarrowUrl],
  ["liberation-sans", liberationSansBoldUrl],
];

let fontsPromise: Promise<render.TrueTypeFont[]> | undefined;
function loadFonts(): Promise<render.TrueTypeFont[]> {
  fontsPromise ??= Promise.all(
    FONT_URLS.map(async ([family, url]) => {
      const buf = await (await fetch(url)).arrayBuffer();
      return render.parseTrueType(buf, family);
    }),
  );
  return fontsPromise;
}

export function MapGlFixturePage() {
  const [params] = useSearchParams();
  const name = (params.get("fixture") ?? "pilot-scene") as render.GoldenSceneName;
  const arena = params.get("path") === "arena";
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  const [stats, setStats] = useState("");

  useEffect(() => {
    let cancelled = false;
    let renderer: MapGlRenderer | undefined;
    let engine: MapGlEngine | undefined;
    (async () => {
      try {
        if (!render.goldenSceneNames.includes(name)) throw new Error(`unknown fixture ${name}`);
        const fonts = await loadFonts();
        if (cancelled) return;
        const scene = render.goldenScene(name, fonts);
        if (arena) {
          const { bounds, width, height } = render.goldenFrame(scene.stream);
          const canvas = canvasRef.current;
          if (!canvas) return;
          canvas.width = width;
          canvas.height = height;
          canvas.style.width = `${width}px`;
          canvas.style.height = `${height}px`;
          const [fontBytes, textAtlas] = await Promise.all([loadMapFonts(), loadTextAtlas(["latin"])]);
          if (cancelled) return;
          renderer = new MapGlRenderer(canvas, { preserveDrawingBuffer: true });
          engine = new MapGlEngine(renderer, inlineTransport(), { gate: false });
          const view: View = {
            centreX: (bounds.minX + bounds.maxX) / 2, centreY: (bounds.minY + bounds.maxY) / 2,
            pxPerUm: render.GOLDEN_PX_PER_MM / 1000, widthPx: width, heightPx: height,
          };
          const t0 = performance.now();
          const summary = await engine.load({
            source: { kind: "stream", stream: scene.stream },
            fonts: fontBytes.map((f) => ({ family: f.family, bytes: f.bytes.slice(0) })),
            textAtlas,
            firstView: { kind: "view", view },
          });
          engine.setView(view);
          await engine.whenComplete();
          const frame = engine.render({ colour: (i) => hexToRgb(scene.colour(i)) });
          renderer.gl.finish();
          if (cancelled) return;
          setStats(`arena · ${summary.passes} passes · ${frame.drawCalls} draws · text ${summary.text.glyphs} glyphs (${summary.text.missing} missing) · ${(performance.now() - t0).toFixed(1)} ms`);
          setStatus("ready");
          return;
        }
        const t0 = performance.now();
        const prepared = prepareStream(scene.stream, { fonts });
        const t1 = performance.now();
        const { bounds, width, height } = render.goldenFrame(scene.stream);
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = width;
        canvas.height = height;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        renderer = new MapGlRenderer(canvas, { preserveDrawingBuffer: true });
        renderer.setStream(prepared);
        const t2 = performance.now();
        renderer.render(
          {
            centreX: (bounds.minX + bounds.maxX) / 2,
            centreY: (bounds.minY + bounds.maxY) / 2,
            pxPerUm: render.GOLDEN_PX_PER_MM / 1000,
            widthPx: width,
            heightPx: height,
          },
          { colour: (i) => hexToRgb(scene.colour(i)), supersample: 2 },
        );
        renderer.gl.finish();
        const t3 = performance.now();
        setStats(
          `${prepared.items.length} items · prepare ${(t1 - t0).toFixed(1)} ms · upload ${(t2 - t1).toFixed(1)} ms · draw ${(t3 - t2).toFixed(1)} ms`,
        );
        setStatus("ready");
      } catch (e) {
        console.error(e);
        setMessage(e instanceof Error ? e.message : String(e));
        setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
      engine?.dispose();
      renderer?.dispose();
    };
  }, [name, arena]);

  return (
    <div className="min-h-screen bg-slate-100 p-4 font-mono text-xs text-slate-700">
      <div className="mb-2 flex flex-wrap gap-3">
        {render.goldenSceneNames.map((n) => (
          <a key={n} href={`/dev/map-gl?fixture=${n}${arena ? "&path=arena" : ""}`} className={n === name ? "font-bold underline" : "underline"}>
            {n}
          </a>
        ))}
      </div>
      <div className="mb-2" data-testid="map-gl-stats">{status === "error" ? `error: ${message}` : stats}</div>
      <canvas
        ref={canvasRef}
        data-testid="map-gl-canvas"
        data-fixture={name}
        data-path={arena ? "arena" : "pass"}
        data-ready={status === "ready" ? "true" : undefined}
        className="block bg-white shadow"
      />
    </div>
  );
}
