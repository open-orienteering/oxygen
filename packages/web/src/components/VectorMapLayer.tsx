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
 * With `mapObjects` set (Map mode, §5.5 "Document objects") the engine's
 * edit part draws the selected document objects highlighted and a draft
 * in their own colours, and `onHitTest` hands the page the hit-test over
 * the effective document.
 *
 * The canvas is not rotated by CSS: the viewport rotation is part of the
 * GL view (`glView`), so nothing is resampled. The engine and its worker
 * live as long as the layer; `view` changes only redraw (one per frame).
 *
 * No WebGL2, or a context lost a second time, shows the layer's "cannot
 * draw the map" message (`data-status="webgl"`); the first lost context
 * remounts the canvas (a fresh context) and loads again (§5.4 "Layer").
 * There is no other renderer to fall back to.
 *
 * With `nameId` set the engine draws image passes (J6, §5.2 "Images") from
 * the event's `print.png` graphics (`GraphicTextures`), an outline until
 * a texture is in; the canvas's `data-graphics` is `pending` while one is
 * drawn as that outline, else `ready`.
 *
 * With `heightField` and `terrain` set (the viewer's 3D mode, §5.4 "3D
 * mode") the engine gets the field and every frame is a 3D one — the map
 * draped over the mesh under `terrain.camera`; without them the frame is
 * the 2D view again.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ViewRect } from "../map-gl/buckets";
import { MapGlEngine, workerTransport, type CourseInfo } from "../map-gl/engine";
import type { CourseLayerRequest, DocumentHit, EditInput, MapObjectRef } from "../map-gl/worker";
import type { mapDocument, render } from "@oxygen/shared";
import { MapGlRenderer } from "../map-gl/renderer";
import { loupeView } from "../map-gl/view";
import { createFrameReader, offscreenTarget, type FrameReader, type FrameReaderHandle } from "../map-gl/readback";
import type { LoadedMapDocument } from "../lib/map-document-cache";
import { loadMapFonts, loadTextAtlas } from "../lib/map-fonts";
import { textAtlasPagesFor } from "../map-gl/text-atlas";
import { budgetBytes, documentColours, documentProxyColours, type MapBudget } from "../lib/vector-map";
import type { HeightField } from "@oxygen/shared/src/terrain/field/read.js";
import type { TerrainCamera } from "../map-gl/terrain/camera";
import type { TerrainMesh } from "../map-gl/terrain/mesh";
import type { TerrainLine } from "../map-gl/terrain/lines";
import { GraphicTextures } from "../lib/graphic-textures";
import { venueAwareFetch } from "../lib/node-discovery";
import { kioskKeyFromUrl } from "../lib/kiosk-key";
import { offlinePrintStore } from "../print/offline-store";

/** The editor's loupe: the magnified point in paper µm, the circle's centre and diameter in container CSS px. */
export interface VectorLoupe {
  xUm: number;
  yUm: number;
  cx: number;
  cy: number;
  diameterPx: number;
  scale: number;
}

/** The document hit-test as the page calls it: paper mm in, the hits topmost first (§5.5 "Document objects"). */
export type DocumentHitTest = (pt: { x: number; y: number }, toleranceMm: number) => Promise<readonly DocumentHit[]>;

/** Map mode's document objects (§5.5 "Document objects"). */
export interface VectorMapObjects {
  /** Drawn highlighted (the edit part, in the highlight colour). */
  selected?: readonly MapObjectRef[];
  /** Patch ops being edited, not written: drawn from the edit part, their static copies hidden. */
  draft?: EditInput["draft"];
  /** The hit-test once the layer has loaded; `null` when it goes. */
  onHitTest?: ((hit: DocumentHitTest | null) => void) | null;
  /**
   * The patch version the canvas now shows (`data-patch-version`), each time it changes: Map mode keeps a committed
   * draft until the patch that carries it is drawn (§5.5 "Committing is the host's"; docs/course-editor.md §13).
   */
  onPatchDrawn?: ((version: string) => void) | null;
}

export type VectorLayerStatus = "loading" | "drawn" | "complete" | "error" | "webgl";

/** A 3D frame's camera and exaggeration (§5.6 "Engine API"). */
export interface VectorTerrainFrame {
  camera: TerrainCamera;
  exaggeration: number;
}

/** The field the engine draws, once its mesh is up (§5.4 "3D mode" "Drawing"). */
export interface VectorTerrainInfo {
  mesh: TerrainMesh;
  field: HeightField;
}

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
  /** Map mode's document objects; absent: nothing is posted. */
  mapObjects?: VectorMapObjects | null;
  /** The height field 3D frames draw (§5.4 "3D mode"); `null` none (the engine drops it). */
  heightField?: HeightField | null;
  /** Draw 3D frames under this camera; `null` 2D. Needs `heightField`'s mesh. */
  terrain?: VectorTerrainFrame | null;
  /** The field's mesh once up (`null` when it goes). */
  onTerrain?: (info: VectorTerrainInfo | null) => void;
  /** The engine could not take the field (too large for the GPU, a lost context). */
  onTerrainError?: (err: Error) => void;
  /** The renderer's texture limit, once it exists. */
  onMaxTextureSize?: (size: number) => void;
  /** Lines 3D frames draw on the terrain (§5.4 "3D mode" "Tracks on the terrain", H8); ignored in 2D. */
  terrainLines?: readonly TerrainLine[] | null;
  /**
   * The frame reader once the layer has drawn (§5.4 "Layer", row I8b): draws a view complete offscreen and reads it
   * back, top row first; `null` on a reload, a remount and unmount. 2D only (it rejects while `terrain` is set).
   */
  onFrameReader?: ((read: FrameReader | null) => void) | null;
  /** Drawn but not shown (the compare view's diff reads it, row I8b); its messages still show. */
  hidden?: boolean;
  /** The event the graphics of image passes are fetched through (J6); without it images draw as outlines. */
  nameId?: string | null;
  /** Keep a failed image's outline (the editor); the viewer and kiosk draw nothing for it. */
  outlineMissingImages?: boolean;
}

export function VectorMapLayer({ doc, view, width, height, budget, zIndex = 1, course = null, onCourse, onCourseSupport, loupe = null, patch = null, patchVersion = "0", mapObjects = null, heightField = null, terrain = null, onTerrain, onTerrainError, onMaxTextureSize, terrainLines = null, onFrameReader = null, hidden = false, nameId = null, outlineMissingImages = false }: Props) {
  const { t } = useTranslation("dashboard");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<MapGlEngine | null>(null);
  const loadedRef = useRef(false);
  const viewRef = useRef(view);
  viewRef.current = view;
  const frameRef = useRef<number | null>(null);
  /** The frame reader of the current engine (row I8b): its reads hold the layer's own draws. */
  const readerRef = useRef<FrameReaderHandle | null>(null);
  const [status, setStatus] = useState<VectorLayerStatus>("loading");
  const [graphics, setGraphicsState] = useState<"pending" | "ready">("ready");
  const outlineRef = useRef(outlineMissingImages);
  outlineRef.current = outlineMissingImages;
  // Each attempt is a fresh canvas (`key`): a lost context cannot be had
  // again from the same element. `lostRef` counts lost contexts.
  const [attempt, setAttempt] = useState(0);
  const lostRef = useRef(0);

  const loupeRef = useRef(loupe);
  loupeRef.current = loupe;
  const insetRef = useRef(false);

  // 3D (§5.4 "3D mode"): the frame drawn last, and whether its drape is complete and settled.
  const terrainRef = useRef(terrain);
  terrainRef.current = terrain;
  const linesRef = useRef(terrainLines);
  linesRef.current = terrainLines;
  /** Lines the last 3D frame drew (`data-terrain-lines`). */
  const [drawnLines, setDrawnLines] = useState(0);
  const onTerrainRef = useRef(onTerrain);
  onTerrainRef.current = onTerrain;
  const onTerrainErrorRef = useRef(onTerrainError);
  onTerrainErrorRef.current = onTerrainError;
  const [mode, setMode] = useState<"2d" | "3d">("2d");
  const [terrainReady, setTerrainReady] = useState(false);
  const readyRef = useRef<{ key: string; complete: boolean; timer: ReturnType<typeof setTimeout> | null }>({ key: "", complete: false, timer: null });
  /** Whether this engine was given a field (a later `null` must reach it, even while it is in flight). */
  const fieldSentRef = useRef(false);
  /** The attempt whose load finished (the field goes to that engine). */
  const [loadedAttempt, setLoadedAttempt] = useState<number | null>(null);

  const courseRef = useRef(course);
  courseRef.current = course;
  const patchRef = useRef({ patch, version: patchVersion });
  patchRef.current = { patch, version: patchVersion };
  /** The patch version the canvas shows (`data-patch-version`): set once the engine drew it. */
  const [drawnPatch, setDrawnPatch] = useState<string | null>(null);
  const onPatchDrawnRef = useRef(mapObjects?.onPatchDrawn);
  onPatchDrawnRef.current = mapObjects?.onPatchDrawn;
  useEffect(() => {
    if (drawnPatch !== null) onPatchDrawnRef.current?.(drawnPatch);
  }, [drawnPatch]);
  const onCourseRef = useRef(onCourse);
  onCourseRef.current = onCourse;
  const onCourseSupportRef = useRef(onCourseSupport);
  onCourseSupportRef.current = onCourseSupport;
  const onMaxTextureSizeRef = useRef(onMaxTextureSize);
  onMaxTextureSizeRef.current = onMaxTextureSize;
  // The edit input (§5.5 "Document objects"): rebuilt only when the selection or the draft changes.
  const selected = mapObjects?.selected;
  const draft = mapObjects?.draft;
  const hasObjects = !!mapObjects;
  const edit = useMemo<EditInput | null>(() => (hasObjects ? { selected: selected ?? [], draft: draft ?? null } : null), [hasObjects, selected, draft]);
  const editRef = useRef(edit);
  editRef.current = edit;
  /** Whether an edit input reached the engine (a null after one clears it; none before posts nothing). */
  const editSentRef = useRef(false);
  /** Selected refs drawn highlighted (`data-selected-objects`). */
  const [highlighted, setHighlighted] = useState<number | null>(null);
  // The stack the engine draws with (the course-completed one, §5.2 "Dynamic bucket"), as RGB per index.
  const colourRef = useRef<{ stack: render.ColourStack; rgb: (i: number) => [number, number, number] } | null>(null);
  const coloursOf = (stack: render.ColourStack) => {
    if (colourRef.current?.stack !== stack) colourRef.current = { stack, rgb: documentColours(stack) };
    return colourRef.current.rgb;
  };

  /**
   * `data-terrain-ready`: the camera has not moved for a settle and the engine's detail is complete, and
   * a 3D frame was drawn after that (the drape it rendered is the complete one).
   */
  const trackTerrainReady = (engine: MapGlEngine, tf: VectorTerrainFrame) => {
    const c = tf.camera, r = readyRef.current;
    const key = `${c.target.x},${c.target.y},${c.target.z},${c.distanceUm},${c.bearingDeg},${c.pitchDeg},${c.widthPx},${c.heightPx},${tf.exaggeration}`;
    if (key === r.key) {
      if (r.complete) setTerrainReady(true);
      return;
    }
    r.key = key;
    r.complete = false;
    setTerrainReady(false);
    if (r.timer) clearTimeout(r.timer);
    r.timer = setTimeout(() => {
      r.timer = null;
      void engine.whenComplete().then(() => {
        if (readyRef.current.key !== key || engineRef.current !== engine) return;
        readyRef.current.complete = true;
        requestDrawRef.current();
      });
    }, 250);
  };

  /** Draws the current view on the next animation frame (coalesced). */
  const requestDraw = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const engine = engineRef.current, v = viewRef.current, canvas = canvasRef.current;
      if (!engine || !v || !canvas || !loadedRef.current) return;
      // A frame read is in flight (it moved the engine's view): its end asks for this draw again.
      if (readerRef.current?.busy()) return;
      // Resizing the drawing buffer clears it; this frame redraws it.
      if (canvas.width !== v.widthPx) canvas.width = v.widthPx;
      if (canvas.height !== v.heightPx) canvas.height = v.heightPx;
      const opts = { colour: coloursOf(engine.colours), outlineMissingImages: outlineRef.current };
      const tf = terrainRef.current;
      if (tf && engine.terrainMesh) {
        // A 3D frame: the camera's canvas size, the drape re-rendered when it has settled (§5.6 "Settling").
        if (canvas.width !== tf.camera.widthPx) canvas.width = tf.camera.widthPx;
        if (canvas.height !== tf.camera.heightPx) canvas.height = tf.camera.heightPx;
        const lines = linesRef.current;
        const st = engine.renderTerrain(lines?.length ? { ...tf, lines, pxRatio: tf.camera.widthPx / (canvas.clientWidth || tf.camera.widthPx) } : tf, opts);
        setDrawnLines(st.mesh?.lines?.lines ?? 0);
        setGraphicsState(st.imagesPending ? "pending" : "ready");
        setMode("3d");
        trackTerrainReady(engine, tf);
        return;
      }
      setMode("2d");
      // A 2D frame forgets the 3D readiness: a re-entry waits for its own drape.
      if (readyRef.current.key) {
        if (readyRef.current.timer) clearTimeout(readyRef.current.timer);
        readyRef.current = { key: "", complete: false, timer: null };
        setTerrainReady(false);
      }
      engine.setView(v);
      const st = engine.render(opts);
      setGraphicsState(st.imagesPending ? "pending" : "ready");
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

  const requestDrawRef = useRef(requestDraw);
  requestDrawRef.current = requestDraw;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let renderer: MapGlRenderer;
    try {
      // Depth for the 3D mode's mesh (§5.6 "Drawing"); the 2D frame does not use it.
      renderer = new MapGlRenderer(canvas, { depth: true });
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
    const reader = createFrameReader({
      engine,
      makeTarget: (w, h) => offscreenTarget(renderer.gl, w, h),
      renderOptions: () => ({ colour: coloursOf(engine.colours) }),
      restoreView: () => viewRef.current,
      onIdle: requestDraw,
    });
    readerRef.current = reader;
    engine.onChange = requestDraw;
    engine.onCourse = (info) => onCourseRef.current?.(info);
    engine.onEdit = (info) => setHighlighted(info.highlighted);
    if (nameId) {
      engine.setGraphics(new GraphicTextures(nameId, {
        fetch: venueAwareFetch,
        decode: (blob, o) => createImageBitmap(blob, o),
        store: offlinePrintStore,
        kioskKey: kioskKeyFromUrl(),
      }));
    }
    // Sent right after the load reaches the worker.
    engine.setCourse(courseRef.current);
    setHighlighted(null);
    editSentRef.current = !!editRef.current;
    if (editRef.current) engine.setEdit(editRef.current);
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
      setLoadedAttempt(attempt);
      onMaxTextureSizeRef.current?.(renderer.maxTextureSize);
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
      if (readerRef.current === reader) readerRef.current = null;
      reader.dispose();
      setLoadedAttempt(null);
      // The mesh goes with the engine: the host is 2D until the next engine has the field again.
      if (fieldSentRef.current) onTerrainRef.current?.(null);
      fieldSentRef.current = false;
      if (readyRef.current.timer) clearTimeout(readyRef.current.timer);
      readyRef.current = { key: "", complete: false, timer: null };
      engine.dispose();
      renderer.dispose();
    };
  }, [doc, budget, attempt, requestDraw, nameId]);

  // The field goes to the loaded engine (again after a remount); `null` drops it (§5.4 "3D mode" "Drawing").
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || loadedAttempt === null) return;
    let current = true;
    // Nothing sent to this engine yet and nothing to send: no request.
    if (!heightField && !fieldSentRef.current) return;
    fieldSentRef.current = !!heightField;
    engine.setTerrain(heightField).then(
      (mesh) => {
        if (!current || engineRef.current !== engine) return;
        const field = engine.terrainField;
        onTerrainRef.current?.(mesh && field ? { mesh, field } : null);
        requestDraw();
      },
      (err: unknown) => {
        // A later field superseded this one: nothing to report.
        if (!current || engineRef.current !== engine) return;
        console.warn("[vector-map] height field failed:", err);
        onTerrainErrorRef.current?.(err instanceof Error ? err : new Error(String(err)));
      },
    );
    return () => {
      current = false;
    };
  }, [heightField, loadedAttempt, requestDraw]);

  // New lines are one redraw (and one upload); 2D draws none.
  useEffect(() => {
    if (terrainRef.current) requestDraw();
  }, [terrainLines, requestDraw]);

  // A camera or exaggeration change is one redraw.
  useEffect(() => {
    if (terrain) requestDraw();
    else if (mode === "3d") requestDraw();
  }, [terrain, mode, requestDraw]);

  // Every course change goes to the engine, which keeps one worker request in flight (latest wins);
  // each reply it draws asks for the redraw (`onChange`).
  useEffect(() => {
    engineRef.current?.setCourse(course);
  }, [course]);

  // The selection or the draft changed: one edit request (one in flight, latest wins).
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || (!edit && !editSentRef.current)) return;
    engine.setEdit(edit);
    editSentRef.current = !!edit;
  }, [edit]);

  // The hit-test goes to the page once the layer has loaded — also when `mapObjects` arrives later —
  // and `null` to a callback that goes, or when the layer reloads or unmounts.
  const onHitTest = mapObjects?.onHitTest ?? null;
  const hitReady = status === "drawn" || status === "complete";
  useEffect(() => {
    const engine = engineRef.current;
    if (!onHitTest || !hitReady || !engine) return;
    onHitTest((pt, toleranceMm) => engine.hitDocument(pt.x * 1000, pt.y * 1000, toleranceMm * 1000));
    return () => onHitTest(null);
  }, [onHitTest, hitReady]);

  // A patch change redraws without reloading (§5.2 "Patch"): the engine re-prepares the touched buckets.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.setPatch(patch).then(() => { if (engineRef.current === engine) setDrawnPatch(patchVersion); }, (err: unknown) => {
      console.warn("[vector-map] patch failed:", err);
    });
  }, [patch, patchVersion]);

  // The frame reader goes to the host once drawn, like the hit-test (row I8b); 2D frames only.
  useEffect(() => {
    const reader = readerRef.current;
    if (!onFrameReader || !hitReady || !reader) return;
    onFrameReader((v, opts) => (terrainRef.current ? Promise.reject(new Error("frame reads are 2D only")) : reader.read(v, opts)));
    return () => onFrameReader(null);
  }, [onFrameReader, hitReady]);

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
        data-selected-objects={highlighted ?? undefined}
        data-status={status}
        data-graphics={graphics}
        data-ready={status === "complete" ? "true" : "false"}
        data-mode={mode}
        data-terrain-ready={mode === "3d" && terrainReady ? "true" : undefined}
        data-terrain-lines={mode === "3d" ? drawnLines : undefined}
        style={{ position: "absolute", left: 0, top: 0, width, height, zIndex, pointerEvents: "none", opacity: hidden ? 0 : undefined }}
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
