/**
 * The vector base map: a map document drawn by the WebGL2 arena path
 * (docs/map-rendering.md §5.2) on a canvas the size of the viewer's
 * container: `MapViewer`'s only base layer (§5.4 "Layer"). With `course` set it also draws the course layer
 * through the engine's dynamic bucket (§5.2 "Dynamic bucket", §5.4
 * "Overlay"); the React SVG on top keeps the UI layer.
 *
 * With `loupe` set the same frame also draws the editor's loupe (§5.5
 * "Loupe"): the resident map once more, magnified, into a circle of the
 * canvas.
 *
 * With `patch` set it draws the effective document (§5.2 "Patch",
 * docs/map-patches.md §2): the patch goes with the load, and a change is
 * sent to the engine without reloading the document.
 *
 * The canvas is not rotated by CSS: the viewport rotation is part of the
 * GL view (`glView`), so nothing is resampled. The engine and its worker
 * live as long as the layer; `view` changes only redraw (one per frame).
 *
 * No WebGL2, or a context lost a second time, shows the layer's "cannot
 * draw the map" message (`data-status="webgl"`); the first lost context
 * remounts the canvas (a fresh context) and loads again (§5.4 "Layer").
 * There is no other renderer to fall back to.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ViewRect } from "../map-gl/buckets";
import { MapGlEngine, workerTransport, type CourseInfo } from "../map-gl/engine";
import type { CourseLayerRequest } from "../map-gl/worker";
import type { mapDocument, render } from "@oxygen/shared";
import { MapGlRenderer } from "../map-gl/renderer";
import { loupeView } from "../map-gl/view";
import type { LoadedMapDocument } from "../lib/map-document-cache";
import { loadMapFonts, loadTextAtlas } from "../lib/map-fonts";
import { textAtlasPagesFor } from "../map-gl/text-atlas";
import { budgetBytes, documentColours, documentProxyColours, type MapBudget } from "../lib/vector-map";

/** The editor's loupe: the magnified point in paper µm, the circle's centre and diameter in container CSS px. */
export interface VectorLoupe {
  xUm: number;
  yUm: number;
  cx: number;
  cy: number;
  diameterPx: number;
  scale: number;
}

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
  /** The course layer to draw (§5.2 "Dynamic bucket"); `null` none. */
  course?: CourseLayerRequest | null;
  /** Each current course reply: the derivation and sizes the UI layer is drawn from. */
  onCourse?: (info: CourseInfo) => void;
  /** After the load: whether this document can draw a course layer (an unaligned stack cannot). */
  onCourseSupport?: (supported: boolean) => void;
  /** Draw the editor's loupe this frame (§5.5 "Loupe"); `null` none. */
  loupe?: VectorLoupe | null;
  /** The event's patch over `doc` (already paired by hash, `patchForDocument`); `null` none. */
  patch?: mapDocument.MapPatch | null;
  /** Its delivery version: the canvas's `data-patch-version` once drawn. */
  patchVersion?: string;
}

export function VectorMapLayer({ doc, view, width, height, budget, zIndex = 1, course = null, onCourse, onCourseSupport, loupe = null, patch = null, patchVersion = "0" }: Props) {
  const { t } = useTranslation("dashboard");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<MapGlEngine | null>(null);
  const loadedRef = useRef(false);
  const viewRef = useRef(view);
  viewRef.current = view;
  const frameRef = useRef<number | null>(null);
  const [status, setStatus] = useState<VectorLayerStatus>("loading");
  // Each attempt is a fresh canvas (`key`): a lost context cannot be had
  // again from the same element. `lostRef` counts lost contexts.
  const [attempt, setAttempt] = useState(0);
  const lostRef = useRef(0);

  const loupeRef = useRef(loupe);
  loupeRef.current = loupe;
  const insetRef = useRef(false);

  const courseRef = useRef(course);
  courseRef.current = course;
  const patchRef = useRef({ patch, version: patchVersion });
  patchRef.current = { patch, version: patchVersion };
  /** The patch version the canvas shows (`data-patch-version`): set once the engine drew it. */
  const [drawnPatch, setDrawnPatch] = useState<string | null>(null);
  const onCourseRef = useRef(onCourse);
  onCourseRef.current = onCourse;
  const onCourseSupportRef = useRef(onCourseSupport);
  onCourseSupportRef.current = onCourseSupport;
  // The stack the engine draws with (the course-completed one, §5.2 "Dynamic bucket"), as RGB per index.
  const colourRef = useRef<{ stack: render.ColourStack; rgb: (i: number) => [number, number, number] } | null>(null);
  const coloursOf = (stack: render.ColourStack) => {
    if (colourRef.current?.stack !== stack) colourRef.current = { stack, rgb: documentColours(stack) };
    return colourRef.current.rgb;
  };

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
      const opts = { colour: coloursOf(engine.colours) };
      engine.render(opts);
      const l = loupeRef.current;
      if (l) {
        // CSS → device px with the ratio the view was built with.
        const k = v.widthPx / (canvas.clientWidth || v.widthPx);
        const size = Math.round(l.diameterPx * k);
        engine.renderInset(loupeView(v, { x: l.xUm, y: l.yUm }, l.scale, size), opts, { x: Math.round(l.cx * k - size / 2), y: Math.round(l.cy * k - size / 2), size });
        insetRef.current = true;
      } else if (insetRef.current) {
        engine.releaseInset();
        insetRef.current = false;
      }
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
      return;
    }
    // A lost context: remount once on a fresh canvas, then the message.
    const onContextLost = () => {
      lostRef.current += 1;
      if (lostRef.current === 1) setAttempt((a) => a + 1);
      else setStatus("webgl");
    };
    canvas.addEventListener("webglcontextlost", onContextLost);
    // The worker starts with the layer, before the fonts and the document reach it.
    const engine = new MapGlEngine(renderer, workerTransport(), { budgetBytes: budgetBytes(budget) });
    engineRef.current = engine;
    loadedRef.current = false;
    engine.onChange = requestDraw;
    engine.onCourse = (info) => onCourseRef.current?.(info);
    // Sent right after the load reaches the worker.
    engine.setCourse(courseRef.current);
    // The patch goes with the load (§5.2 "Patch").
    const first = patchRef.current;
    setDrawnPatch(null);
    engine.setPatch(first.patch).then(() => { if (engineRef.current === engine) setDrawnPatch(first.version); }, () => undefined);
    let cancelled = false;
    setStatus("loading");
    (async () => {
      // Text atlas pages the document's strings need (Cyrillic only on demand). A page that fails
      // costs its text, not the map: fall back to the Latin page, then to no text.
      const [fonts, textAtlas] = await Promise.all([
        loadMapFonts(),
        loadTextAtlas(textAtlasPagesFor(doc.header.strings)).catch((err: unknown) => {
          console.warn("[vector-map] text atlas failed:", err);
          return loadTextAtlas(["latin"]).catch((err2: unknown) => {
            console.warn("[vector-map] text atlas (Latin page) failed, drawing without text:", err2);
            return [];
          });
        }),
      ]);
      if (cancelled) return;
      const first = viewRef.current;
      await engine.load({
        source: {
          kind: "document",
          bytes: doc.bytes.slice(0),
          options: { unmatched: "proxy", proxyColours: documentProxyColours(doc.header.colours) },
        },
        fonts: fonts.map((f) => ({ family: f.family, bytes: f.bytes.slice(0) })),
        textAtlas,
        firstView: first ? { kind: "view", view: first } : undefined,
        courseLayer: true,
      }).then((summary) => {
        if (!cancelled) onCourseSupportRef.current?.(summary.courseLayer?.supported === true);
        return summary;
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

  // Every course change goes to the engine, which keeps one worker request in flight (latest wins);
  // each reply it draws asks for the redraw (`onChange`).
  useEffect(() => {
    engineRef.current?.setCourse(course);
  }, [course]);

  // A patch change redraws without reloading (§5.2 "Patch"): the engine re-prepares the touched buckets.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.setPatch(patch).then(() => { if (engineRef.current === engine) setDrawnPatch(patchVersion); }, (err: unknown) => {
      console.warn("[vector-map] patch failed:", err);
    });
  }, [patch, patchVersion]);

  // Every view change is one redraw; detail requests and evictions follow from `setView`.
  useEffect(() => {
    if (view) requestDraw();
  }, [view, requestDraw]);

  // The loupe follows the finger: a redraw per change, and one more when it goes (the canvas without it).
  const lk = loupe && `${loupe.xUm},${loupe.yUm},${loupe.cx},${loupe.cy},${loupe.diameterPx},${loupe.scale}`;
  useEffect(() => {
    requestDraw();
  }, [lk, requestDraw]);

  return (
    <>
      <canvas
        key={attempt}
        ref={canvasRef}
        data-testid="map-vector-layer"
        data-attempt={attempt}
        data-document-hash={doc.hash}
        data-patch-version={drawnPatch ?? undefined}
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
