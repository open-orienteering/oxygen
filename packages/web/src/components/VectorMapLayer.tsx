/**
 * The vector base map: a map document drawn by the WebGL2 arena path
 * (docs/map-rendering.md §5.2) on a canvas the size of the viewer's
 * container. The alternative to `TileLayer` inside `MapViewer`
 * (§5.4 "Layer"); the course overlay stays React SVG on top.
 *
 * The canvas is not rotated by CSS: the viewport rotation is part of the
 * GL view (`glView`), so nothing is resampled. The engine and its worker
 * live as long as the layer; `view` changes only redraw (one per frame).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ViewRect } from "../map-gl/buckets";
import { MapGlEngine, workerTransport } from "../map-gl/engine";
import { MapGlRenderer } from "../map-gl/renderer";
import type { LoadedMapDocument } from "../lib/map-document-cache";
import { loadMapFonts } from "../lib/map-fonts";
import { budgetBytes, documentColours, documentProxyColours, type MapBudget } from "../lib/vector-map";

export type VectorLayerStatus = "loading" | "drawn" | "complete" | "error" | "webgl";

interface Props {
  doc: LoadedMapDocument;
  /** The GL view (device px, rotation folded in); null until the viewer has one. */
  view: ViewRect | null;
  /** Container size, CSS px. */
  width: number;
  height: number;
  budget: MapBudget;
  zIndex?: number;
  /**
   * The browser cannot draw this layer: no WebGL2 context, or the context
   * was lost. The host decides the fallback (docs/map-pipeline-switch.md §3).
   */
  onUnavailable?: () => void;
}

export function VectorMapLayer({ doc, view, width, height, budget, zIndex = 1, onUnavailable }: Props) {
  const { t } = useTranslation("dashboard");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<MapGlEngine | null>(null);
  const loadedRef = useRef(false);
  const viewRef = useRef(view);
  viewRef.current = view;
  const frameRef = useRef<number | null>(null);
  const [status, setStatus] = useState<VectorLayerStatus>("loading");
  const [attempt, setAttempt] = useState(0);
  const unavailableRef = useRef(onUnavailable);
  unavailableRef.current = onUnavailable;

  const colours = useMemo(() => documentColours(doc.header.colours), [doc.header.colours]);
  const colourRef = useRef(colours);
  colourRef.current = colours;

  /** Draws the current view on the next animation frame (coalesced). */
  const requestDraw = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const engine = engineRef.current, v = viewRef.current, canvas = canvasRef.current;
      if (!engine || !v || !canvas || !loadedRef.current) return;
      // Resizing the drawing buffer clears it; this frame redraws it.
      if (canvas.width !== v.widthPx) canvas.width = v.widthPx;
      if (canvas.height !== v.heightPx) canvas.height = v.heightPx;
      engine.setView(v);
      engine.render({ colour: colourRef.current });
    });
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let renderer: MapGlRenderer;
    try {
      renderer = new MapGlRenderer(canvas);
    } catch {
      setStatus("webgl");
      unavailableRef.current?.();
      return;
    }
    // A lost context is not restored here; the host falls back or shows the message.
    const onContextLost = () => {
      setStatus("webgl");
      unavailableRef.current?.();
    };
    canvas.addEventListener("webglcontextlost", onContextLost);
    // The worker starts with the layer, before the fonts and the document reach it.
    const engine = new MapGlEngine(renderer, workerTransport(), { budgetBytes: budgetBytes(budget) });
    engineRef.current = engine;
    loadedRef.current = false;
    engine.onChange = requestDraw;
    let cancelled = false;
    setStatus("loading");
    (async () => {
      const fonts = await loadMapFonts();
      if (cancelled) return;
      const first = viewRef.current;
      await engine.load({
        source: {
          kind: "document",
          bytes: doc.bytes.slice(0),
          options: { unmatched: "proxy", proxyColours: documentProxyColours(doc.header.colours) },
        },
        fonts: fonts.map((f) => ({ family: f.family, bytes: f.bytes.slice(0) })),
        firstView: first ? { kind: "view", view: first } : undefined,
      });
      if (cancelled) return;
      loadedRef.current = true;
      setStatus("drawn");
      requestDraw();
      await engine.whenComplete();
      if (!cancelled) setStatus("complete");
    })().catch((err: unknown) => {
      if (cancelled) return;
      console.warn("[vector-map] load failed:", err);
      setStatus("error");
    });
    return () => {
      cancelled = true;
      canvas.removeEventListener("webglcontextlost", onContextLost);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      engineRef.current = null;
      loadedRef.current = false;
      engine.dispose();
      renderer.dispose();
    };
  }, [doc, budget, attempt, requestDraw]);

  // Every view change is one redraw; detail requests and evictions follow from `setView`.
  useEffect(() => {
    if (view) requestDraw();
  }, [view, requestDraw]);

  return (
    <>
      <canvas
        ref={canvasRef}
        data-testid="map-vector-layer"
        data-document-hash={doc.hash}
        data-status={status}
        data-ready={status === "complete" ? "true" : "false"}
        style={{ position: "absolute", left: 0, top: 0, width, height, zIndex, pointerEvents: "none" }}
      />
      {(status === "error" || status === "webgl") && (
        <MapLayerMessage
          message={t(status === "webgl" ? "mapWebglUnsupported" : "mapDocumentFailed")}
          onRetry={status === "error" ? () => setAttempt((a) => a + 1) : undefined}
          retryLabel={t("mapRetry")}
        />
      )}
    </>
  );
}

/** A centred message over the map area (document or layer failure), with an optional retry. */
export function MapLayerMessage({ message, onRetry, retryLabel }: { message: string; onRetry?: () => void; retryLabel?: string }) {
  return (
    <div
      data-testid="map-layer-message"
      className="absolute inset-0 z-[5] flex items-center justify-center p-4"
      onMouseDown={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
    >
      <div className="max-w-xs rounded-lg bg-white/95 px-4 py-3 text-center text-sm text-slate-600 shadow">
        <p>{message}</p>
        {onRetry && (
          <button type="button" onClick={onRetry} className="mt-2 rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700">
            {retryLabel}
          </button>
        )}
      </div>
    </div>
  );
}
