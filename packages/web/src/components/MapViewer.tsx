import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import type { ControlDescription } from "@oxygen/shared";
import { getDescriptionSymbols } from "../iof-symbols";
import { TileLayer } from "./TileLayer";
import { kioskKeyFromUrl } from "../lib/kiosk-key";
import {
  type TileViewport,
  type WGS84Bounds,
  type AffineTransform,
  latlngToPixel,
  pixelToLatlng,
  fitBounds,
  metersPerPixel,
  buildAffineTransform,
} from "../lib/geo-utils";
import { rotatedBoundingBox } from "../lib/map-rotation";
import { useGeolocationWatch } from "../hooks/useGeolocationWatch";
import {
  accuracyRadiusPx,
  nextLocateMode,
  type LocateMode,
} from "../lib/locate-mode";
import {
  buildCourseLegLabels,
  courseLegLabelText,
  pillHalfWidth,
} from "../lib/course-leg-labels";
import {
  placeControlLabels,
  type PlacementCircle,
  type PlacementSeg,
} from "../lib/control-label-placement";
import { useMediaQuery } from "../hooks/useMediaQuery";

// ─── Types ──────────────────────────────────────────────────

export interface ControlOverlay {
  id: string;
  code: string;
  x: number; // map position x (mm on map)
  y: number; // map position y (mm on map)
  lat: number;
  lng: number;
  type: "Start" | "Control" | "Finish";
  highlight?: boolean;
  visible?: boolean;
  punchCount?: number;
  /** Completion percentage 0–1 (undefined = no data / not enabled) */
  completionPct?: number;
  /** Punch status for mispunch visualization */
  punchStatus?: "ok" | "missing" | "extra";
  /**
   * IOF control description from the control row (canonical source since
   * descriptions moved to `controls.description`). The sheet renderer
   * falls back to legacy geometry-embedded descriptions when absent.
   */
  description?: ControlDescription | null;
}

/** A manual or automatic slit in a control circle. */
interface SlitGap {
  start: number; // degrees CW from North
  end: number;   // degrees CW from North
}

export interface CourseOverlay {
  name: string;
  controls: string[]; // ordered control IDs (including start/finish)
  highlight?: boolean;
  /**
   * Classes assigned to this course (all of them — several classes can
   * share a course). Drives the per-leg labels in multi-course display.
   */
  classNames?: string[];
}

/**
 * Course-editor hooks. When set, the viewer grows editing gestures on top
 * of the normal pan/zoom behaviour. The editor is tool-less — every click
 * resolves to a selection and the page supplies contextual actions:
 *
 * - *Empty-map click* fires `onMapClick` with the position in map mm
 *   (paper millimetres, the `xpos`/`ypos` coordinate space of
 *   `controls`). The page typically anchors a `phantom` there.
 * - *Drag-to-move*: mouse-down on a control symbol starts a local drag
 *   (rendered without network round-trips); mouse-up fires `onMoveEnd`
 *   once. The viewer keeps rendering the dragged position until the
 *   `controls` prop catches up, so no snap-back while the mutation and
 *   refetch are in flight. Touch and mouse share the same drag path.
 * - *Select*: clicking a control fires `onSelect(id)` (replacing
 *   `onControlClick`). The control matching `selectedControlId` gets a
 *   selection ring.
 * - *Leg click*: every drawn leg of a highlighted course gets an
 *   invisible fat hit-line; a click on it fires `onLegClick` with the
 *   course name, the 0-based leg index and the clicked point. Only
 *   rendered when `onLegClick` is provided.
 * - *Phantom*: a dashed ring drawn at the given map-mm point — the
 *   page's marker for "the user clicked here" (empty map or leg).
 * - *Context actions*: a floating HTML menu anchored next to the
 *   selected control or the phantom; the page decides the entries
 *   (add / add to course / insert / delete) and an optional info line
 *   (`contextInfo`, e.g. "Also in: Lång, Kort") shown above them.
 * - *Description suggestions*: rows in the same menu, above the actions,
 *   listing what the base map says the control sits on. Labels and
 *   symbol SVG come pre-resolved from the page.
 * - *Course fading*: with `fadeNonCourse` set, regular controls whose
 *   id is NOT in `courseControlIds` render at reduced opacity (Purple
 *   Pen style) so the edited course stands out. Start/finish stay at
 *   full strength; faded controls remain clickable.
 * - *Move warnings*: while a control with an entry in `moveWarnings`
 *   is being dragged, a small chip with that pre-formatted text (e.g.
 *   "Affects: Lång, Kort") follows the drag.
 *
 * Keyboard shortcuts (Delete, Escape) are the owning page's concern —
 * the viewer stays gesture-only.
 *
 * All callbacks must be stabilized (`useCallback`) and the object itself
 * memoized (`useMemo`) by the caller — it flows through `MapPanel`'s
 * shallow-equality `memo`.
 */
export interface EditorContextAction {
  /** Stable id — rendered as `data-testid="editor-action-<id>"`. */
  id: string;
  label: string;
  onClick: () => void;
  variant?: "default" | "danger";
}

/**
 * A description the base map suggests for the selected control. Labels
 * and SVG fragments are resolved by the page (the viewer stays i18n-free
 * and symbol-table-free, same contract as `moveWarnings`).
 */
export interface EditorDescriptionSuggestion {
  /** Stable id — rendered as `data-testid="editor-suggestion-<id>"`. */
  id: string;
  label: string;
  /** Inline SVG fragment for the column-D symbol, in a -100..100 box. */
  symbolSvg?: string | null;
  /** Same for the optional column-G side-of symbol. */
  sideSvg?: string | null;
  onApply: () => void;
}

export interface MapViewerEditorProps {
  /** Control overlay id (public control id as string) to mark selected. */
  selectedControlId?: string | null;
  /** Dashed-ring anchor (map mm) from an empty-map or leg click. */
  phantom?: { x: number; y: number } | null;
  /** Floating action menu at the selection/phantom anchor. */
  contextActions?: EditorContextAction[];
  /** Info line rendered above the context actions (no interaction). */
  contextInfo?: string | null;
  /** Optional badge in the placed-control popover (e.g. SRR from club series). */
  contextBadge?: { label: string; title?: string } | null;
  /** Radio-state badge in the placed-control popover. */
  contextRadioBadge?: { label: string; title?: string } | null;
  /** Base-map description suggestions, rendered above the actions. */
  suggestions?: EditorDescriptionSuggestion[];
  /** Heading for the suggestion block (the page localizes it). */
  suggestionsHeading?: string;
  /** Ids of controls on the edited course (full strength when fading). */
  courseControlIds?: ReadonlySet<string>;
  /** Fade regular controls not in `courseControlIds` (course selected). */
  fadeNonCourse?: boolean;
  /** Pre-formatted warning per control id, shown as a chip during drag. */
  moveWarnings?: ReadonlyMap<string, string>;
  /**
   * Bump to discard all in-flight anti-snap-back move bridges. The page
   * increments this on undo/redo: an undone move returns the control to
   * exactly the position a bridge treats as "stale data", so without the
   * reset the control would keep rendering at the dragged position.
   */
  moveEpoch?: number;
  onMapClick?: (pt: { x: number; y: number }) => void;
  onMoveEnd?: (id: string, pt: { x: number; y: number }) => void;
  onSelect?: (id: string | null) => void;
  onLegClick?: (courseName: string, legIndex: number, pt: { x: number; y: number }) => void;
  /** Touch-friendly dismiss (mirrors Escape cascade on the owning page). */
  onDismiss?: () => void;
}

interface Props {
  mapBounds?: WGS84Bounds | null;
  mapScale?: number | null;
  /** Map north offset in degrees (bearing from true north to map north). Applied as CSS rotation. */
  northOffset?: number | null;
  /** Map upload timestamp for cache busting tile URLs */
  mapVersion?: number;
  /**
   * Map-mm ↔ WGS84 anchor points from the map's georeference
   * (course.mapMetadata). Preferred source for the affine transform —
   * without them a map with fewer than two placed controls has no
   * mm↔latlng mapping and editor clicks go nowhere.
   */
  calibration?: Array<{
    mapX: number;
    mapY: number;
    lat: number;
    lng: number;
  }> | null;
  controls?: ControlOverlay[];
  courses?: CourseOverlay[];
  highlightControlId?: string;
  highlightCourseName?: string;
  onControlClick?: (controlId: string) => void;
  className?: string;
  style?: React.CSSProperties;
  initialFitControls?: boolean;
  focusControlIds?: string[] | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped GeoJSON JSONB straight from the API; traversed dynamically
  courseGeometry?: any;
  /**
   * Names of highlighted courses for which high-fidelity geometry is already
   * included in `courseGeometry` (i.e. imported as OCD/XML). Any highlighted
   * course NOT in this set gets fallback straight-line legs between its
   * controls so the user still sees a route for it. When omitted, falls back
   * to the legacy "draw legs only when no geometry at all" behaviour.
   */
  coursesWithGeometry?: Set<string>;
  showDescriptions?: boolean;
  /**
   * When no course is highlighted, list every positioned control in the
   * description sheet instead of rendering nothing. Used by the course
   * editor, where descriptions are useful before a course is picked.
   */
  descriptionsAllControls?: boolean;
  /** Localized sheet title for the all-controls listing ("All controls"). */
  allControlsTitle?: string;
  onToggleFullscreen?: () => void;
  isFullscreen?: boolean;
  /** Hide all interactive controls (zoom, measure, reset, fullscreen) */
  hideControls?: boolean;
  /** GPS route traces to overlay on the map (lat/lng points, already in WGS84). */
  gpsRoutes?: Array<{ color: string; points: Array<{ lat: number; lng: number }> }>;
  /** Course-editor gesture hooks. Editing is enabled iff this is set. */
  editor?: MapViewerEditorProps;
}

// ─── Helpers ────────────────────────────────────────────────

interface Pt { x: number; y: number }

/** Editor hit-target metadata computed inside the overlay memo; the JSX
 *  (with ref-writing handlers) is materialized outside it. */
interface EditorControlHit {
  id: string; code: string;
  px: number; py: number; r: number;
  /** Position in map mm at render time — the drag's `from` anchor. */
  mmX: number; mmY: number;
}
interface EditorLegHit { key: string; d: string; course: string; index: number }

/**
 * Clip a line segment (a→b) around ALL nearby control circles.
 * Returns visible sub-segments that don't pass through any clearance zone.
 */
function clipLine(
  a: Pt, b: Pt,
  obstacles: Pt[],
  clearance: number,
): { x1: number; y1: number; x2: number; y2: number }[] {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) return [];
  const ux = dx / len, uy = dy / len;

  const blocks: [number, number][] = [];
  for (const obs of obstacles) {
    const vx = obs.x - a.x, vy = obs.y - a.y;
    const t = vx * ux + vy * uy;
    const px = a.x + t * ux - obs.x;
    const py = a.y + t * uy - obs.y;
    const perpDist = Math.sqrt(px * px + py * py);
    if (perpDist < clearance) {
      const half = Math.sqrt(clearance * clearance - perpDist * perpDist);
      blocks.push([t - half, t + half]);
    }
  }

  blocks.sort((ba, bb) => ba[0] - bb[0]);
  const merged: [number, number][] = [];
  for (const bl of blocks) {
    if (merged.length > 0 && bl[0] <= merged[merged.length - 1][1]) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], bl[1]);
    } else {
      merged.push([bl[0], bl[1]]);
    }
  }

  const segs: { x1: number; y1: number; x2: number; y2: number }[] = [];
  let cursor = 0;
  for (const [bs, be] of merged) {
    const s0 = Math.max(cursor, 0);
    const s1 = Math.min(bs, len);
    if (s1 - s0 > 1) {
      segs.push({ x1: a.x + s0 * ux, y1: a.y + s0 * uy, x2: a.x + s1 * ux, y2: a.y + s1 * uy });
    }
    cursor = be;
  }
  const s0 = Math.max(cursor, 0);
  if (len - s0 > 1) {
    segs.push({ x1: a.x + s0 * ux, y1: a.y + s0 * uy, x2: a.x + len * ux, y2: a.y + len * uy });
  }
  return segs;
}

// ─── Component ──────────────────────────────────────────────

export function MapViewer({
  mapBounds,
  mapScale,
  northOffset,
  mapVersion,
  calibration,
  controls = [],
  courses = [],
  highlightControlId,
  highlightCourseName,
  onControlClick,
  className = "",
  style,
  initialFitControls = false,
  focusControlIds = null,
  courseGeometry,
  coursesWithGeometry,
  showDescriptions = false,
  descriptionsAllControls = false,
  allControlsTitle,
  onToggleFullscreen,
  isFullscreen = false,
  hideControls = false,
  gpsRoutes,
  editor,
}: Props) {
  const { nameId } = useParams<{ nameId: string }>();
  const { t } = useTranslation("dashboard");
  const isCoarsePointer = useMediaQuery("(pointer: coarse)");
  const allowOneFingerMapPan = isFullscreen || !isCoarsePointer;
  const [showTwoFingerHint, setShowTwoFingerHint] = useState(false);
  const tileUrlBase = nameId ? `/api/map-tile/${nameId}` : "/api/map-tile";

  const containerRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<TileViewport | null>(null);
  const viewportRef = useRef<TileViewport | null>(null);
  viewportRef.current = viewport;

  const isPanningRef = useRef(false);
  const lastPosRef = useRef({ x: 0, y: 0 });
  const hasInitialFitRef = useRef(false);
  const lastFocusKeyRef = useRef<string>("");

  // ─── Tile progress polling (while loading) ────────────────
  const [tileProgress, setTileProgress] = useState<{ total: number; done: number; rendering: boolean } | null>(null);
  useEffect(() => {
    if (viewport) return; // already loaded, stop polling
    if (!mapBounds) return; // no map
    const interval = setInterval(async () => {
      try {
        const headers: Record<string, string> = {};
        if (nameId) headers["x-competition-id"] = nameId;
        const kioskKey = kioskKeyFromUrl();
        if (kioskKey) headers["x-kiosk-key"] = kioskKey;
        const res = await fetch("/api/map-tile-progress", { headers });
        if (res.ok) setTileProgress(await res.json());
      } catch { /* ignore */ }
    }, 2000);
    return () => clearInterval(interval);
  }, [viewport, mapBounds]);

  // ─── Measure tool state ──────────────────────────────────
  const [measuring, setMeasuring] = useState(false);
  const [measurePoints, setMeasurePoints] = useState<Pt[]>([]);
  const [measureCursor, setMeasureCursor] = useState<Pt | null>(null);

  // ─── My-location (GPS) ───────────────────────────────────
  const [locateMode, setLocateMode] = useState<LocateMode>("off");
  const locateModeRef = useRef<LocateMode>("off");
  locateModeRef.current = locateMode;
  const geo = useGeolocationWatch();
  const [locateErrorFlash, setLocateErrorFlash] = useState<string | null>(null);
  const breakLocateFollow = useCallback(() => {
    setLocateMode((mode) => nextLocateMode(mode, "userGesture"));
  }, []);
  const breakLocateFollowRef = useRef(breakLocateFollow);
  breakLocateFollowRef.current = breakLocateFollow;

  // Recenter while following GPS.
  useEffect(() => {
    if (locateMode !== "following" || !geo.position) return;
    const { lat, lng } = geo.position;
    setViewport((prev) =>
      prev ? { ...prev, centerLat: lat, centerLng: lng } : prev,
    );
  }, [locateMode, geo.position]);

  // Surface geolocation errors and drop back to off.
  useEffect(() => {
    if (!geo.error) return;
    setLocateMode("off");
    const key =
      geo.error === "denied"
        ? "locateErrorDenied"
        : geo.error === "insecure" || geo.error === "unsupported"
          ? "locateErrorUnsupported"
          : "locateErrorUnavailable";
    setLocateErrorFlash(t(key));
    const id = window.setTimeout(() => setLocateErrorFlash(null), 3500);
    return () => window.clearTimeout(id);
  }, [geo.error, t]);

  const handleLocateClick = useCallback(() => {
    const next = nextLocateMode(locateMode, "toggle");
    if (next === "off") {
      geo.stop();
      setLocateMode("off");
      return;
    }
    setLocateMode(next);
    setLocateErrorFlash(null);
    if (!geo.watching) geo.start();
    if (geo.position) {
      setViewport((prev) =>
        prev
          ? { ...prev, centerLat: geo.position!.lat, centerLng: geo.position!.lng }
          : prev,
      );
    }
  }, [locateMode, geo]);

  const mouseDownPosRef = useRef<Pt | null>(null);
  const lastClickTimeRef = useRef(0);
  const lastTouchRef = useRef<{ x: number; y: number; dist?: number } | null>(null);
  const touchGestureBaseRef = useRef<{
    x: number;
    y: number;
    dist: number;
    viewport: TileViewport;
  } | null>(null);
  const touchGestureFrameRef = useRef<number | null>(null);
  const pendingTouchGestureRef = useRef<{ x: number; y: number; dist: number } | null>(null);
  const touchStartPosRef = useRef<Pt | null>(null);
  const hadMultiTouchRef = useRef(false);
  const touchOnEditorTargetRef = useRef(false);
  const suppressEditorSelectionUntilRef = useRef(0);

  // ─── Editor gesture state ────────────────────────────────
  // Drag-in-progress: candidate is armed on control mouse-down; it becomes
  // a real drag once movement exceeds the click threshold. `editorDragPos`
  // (map mm) drives the local render of the dragged control. `origX/Y` is
  // the control's position when the drag started — the matching pending
  // move stays active only while the `controls` prop still reports that
  // stale position.
  const editorDragRef = useRef<{
    id: string; startX: number; startY: number; moved: boolean; origX: number; origY: number;
  } | null>(null);
  const [editorDragPos, setEditorDragPos] = useState<{ id: string; x: number; y: number } | null>(null);
  // Moves already sent via onMoveEnd but not yet reflected in the
  // `controls` prop (mutation + refetch in flight). Rendering `to`
  // prevents the control snapping back to its stale position. An entry
  // only applies while the control is still at `from`; it is deleted as
  // soon as the data catches up to `to` (effect below) so that a later
  // genuine return to `from` — an undone move — renders truthfully.
  const [pendingMoves, setPendingMoves] = useState<Map<string, { from: Pt; to: Pt }>>(new Map());
  // Mouse-down bookkeeping for the leg-insert hit lines.
  const legDownRef = useRef<{ course: string; index: number; x: number; y: number } | null>(null);

  // Expire move bridges once the refetched data reports the drop
  // position (or the control disappeared). Without this, undoing a move
  // puts the data back at exactly `from`, which a live bridge would
  // misread as "stale, keep showing `to`" — undo would look like a no-op.
  useEffect(() => {
    setPendingMoves((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Map(prev);
      for (const [id, m] of prev) {
        const c = controls.find((k) => k.id === id);
        if (!c || (Math.abs(c.x - m.to.x) < 1e-9 && Math.abs(c.y - m.to.y) < 1e-9)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [controls]);

  // Undo/redo ran on the page: drop every bridge immediately, even ones
  // whose move round-trip hasn't refetched yet — the user asked for the
  // authoritative (restored) positions.
  const moveEpoch = editor?.moveEpoch;
  useEffect(() => {
    setPendingMoves((prev) => (prev.size === 0 ? prev : new Map()));
  }, [moveEpoch]);

  // Track container size
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  const prevSizeRef = useRef({ w: 0, h: 0 });
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      const rw = Math.round(width);
      const rh = Math.round(height);
      if (rw !== prevSizeRef.current.w || rh !== prevSizeRef.current.h) {
        prevSizeRef.current = { w: rw, h: rh };
        setContainerSize({ w: rw, h: rh });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Map rotation: negate northOffset so map north points up on screen
  const rotDeg = northOffset ? -northOffset : 0;
  const rotRad = (rotDeg * Math.PI) / 180;
  // Effective render dimensions: minimum bounding box of a rectangle that
  // fully covers the outer container after rotation. See rotatedBoundingBox
  // for the math — the previous single-factor formula was only correct for
  // square containers and produced visible wedges at corners otherwise.
  const { width: renderW, height: renderH } = rotatedBoundingBox(
    containerSize.w, containerSize.h, rotDeg,
  );

  // Build affine transform (mm ↔ lat/lng). The map's own calibration
  // corners are exact and always well-conditioned, so they win when
  // available; control-derived points remain the fallback for maps
  // whose metadata predates calibration support.
  const affine: AffineTransform | null = useMemo(() => {
    if (calibration && calibration.length >= 3) {
      const fromCalibration = buildAffineTransform(calibration);
      if (fromCalibration) return fromCalibration;
    }
    const pts = controls
      .filter((c) => c.lat !== 0 && c.lng !== 0 && c.x !== 0 && c.y !== 0)
      .map((c) => ({ mapX: c.x, mapY: c.y, lat: c.lat, lng: c.lng }));
    return buildAffineTransform(pts);
  }, [controls, calibration]);

  // ─── Viewport initialization from map bounds ────────────

  useEffect(() => {
    if (viewport) return; // already initialized
    if (!mapBounds || containerSize.w === 0 || containerSize.h === 0) return;
    setViewport(fitBounds(mapBounds, containerSize.w, containerSize.h, 0.05));
    hasInitialFitRef.current = false;
    lastFocusKeyRef.current = "";
  }, [mapBounds, containerSize, viewport]);

  // ─── Helper: compute bounds from controls in lat/lng ─────

  const fitToControlBounds = useCallback(
    (ctrls: ControlOverlay[], padding: number) => {
      if (ctrls.length === 0 || containerSize.w === 0 || containerSize.h === 0) return;
      let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
      for (const c of ctrls) {
        if (c.lat === 0 && c.lng === 0) continue;
        minLat = Math.min(minLat, c.lat); maxLat = Math.max(maxLat, c.lat);
        minLng = Math.min(minLng, c.lng); maxLng = Math.max(maxLng, c.lng);
      }
      if (minLat === Infinity) return;
      // Expand bounds by ring radius so control rings aren't clipped at the edge.
      // Ring radius = 2.5 mm on map × mapScale/1000 metres/mm.
      if (mapScale) {
        const ringM = 2.5 * mapScale / 1000;
        const midLat = (minLat + maxLat) / 2;
        const latMargin = ringM / 111320;
        const lngMargin = ringM / (111320 * Math.cos(midLat * Math.PI / 180));
        minLat -= latMargin; maxLat += latMargin;
        minLng -= lngMargin; maxLng += lngMargin;
      }
      const bounds: WGS84Bounds = { north: maxLat, south: minLat, east: maxLng, west: minLng };
      setViewport(fitBounds(bounds, containerSize.w, containerSize.h, padding));
    },
    [containerSize, mapScale],
  );

  // Re-fit when container size changes (e.g. fullscreen toggle).
  useEffect(() => {
    if (!viewport || containerSize.w === 0 || containerSize.h === 0) return;
    // Course editing is spatial work: opening a selection menu or wrapping
    // the editor toolbar may resize the map by a few pixels, but must never
    // replace the user's current pan/zoom with an automatic fit.
    if (editor) return;
    if (!hasInitialFitRef.current) return;
    const visibleControls = controls.filter((c) => c.visible !== false);
    if (visibleControls.length < 2) {
      if (mapBounds) setViewport(fitBounds(mapBounds, containerSize.w, containerSize.h, 0.05));
      return;
    }
    fitToControlBounds(visibleControls, hideControls ? 0.02 : 0.05);
  }, [containerSize]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Initial fit ──────────────────────────────────────────

  useEffect(() => {
    if (!viewport || !containerRef.current || hasInitialFitRef.current) return;
    if (!initialFitControls) { hasInitialFitRef.current = true; return; }
    const visibleControls = controls.filter((c) => c.visible !== false);
    if (visibleControls.length < 2) return;
    fitToControlBounds(visibleControls, hideControls ? 0.02 : 0.05);
    hasInitialFitRef.current = true;
  }, [viewport, controls, initialFitControls, hideControls, fitToControlBounds]);

  // ─── Focus on selection change ────────────────────────────

  useEffect(() => {
    if (!viewport || !containerRef.current || !focusControlIds || focusControlIds.length === 0) return;
    const key = [...focusControlIds].sort().join(",");
    if (key === lastFocusKeyRef.current) return;
    lastFocusKeyRef.current = key;
    const focusSet = new Set(focusControlIds);
    const focusControls = controls.filter((c) => focusSet.has(c.id));
    if (focusControls.length === 0) return;
    const cw = containerSize.w || containerRef.current.clientWidth;
    const ch = containerSize.h || containerRef.current.clientHeight;
    if (cw === 0 || ch === 0) return;

    if (focusControls.length === 1) {
      const fc = focusControls[0];
      const allCtrls = controls.filter((c) => c.type === "Control" && c.lat !== 0);
      if (allCtrls.length >= 2) {
        let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
        for (const c of allCtrls) {
          minLat = Math.min(minLat, c.lat); maxLat = Math.max(maxLat, c.lat);
          minLng = Math.min(minLng, c.lng); maxLng = Math.max(maxLng, c.lng);
        }
        const ext = Math.max(maxLat - minLat, maxLng - minLng) * 0.167;
        const bounds: WGS84Bounds = {
          north: fc.lat + ext, south: fc.lat - ext,
          east: fc.lng + ext, west: fc.lng - ext,
        };
        setViewport(fitBounds(bounds, cw, ch, 0.05));
      } else {
        setViewport((prev) => prev ? { ...prev, centerLat: fc.lat, centerLng: fc.lng } : prev);
      }
    } else {
      fitToControlBounds(focusControls, hideControls ? 0.02 : 0.05);
    }
  }, [viewport, focusControlIds, controls, containerSize, hideControls, fitToControlBounds]);

  // ─── Coordinate helpers ───────────────────────────────────

  /** Rotate a screen-relative point to the rotated inner coordinate system. */
  const screenToInner = useCallback(
    (sx: number, sy: number): { ix: number; iy: number } => {
      if (rotRad === 0) return { ix: sx, iy: sy };
      // Rotate around container center by -rotDeg to undo visual rotation
      const cx = containerSize.w / 2;
      const cy = containerSize.h / 2;
      const dx = sx - cx;
      const dy = sy - cy;
      const cos = Math.cos(-rotRad);
      const sin = Math.sin(-rotRad);
      return {
        ix: dx * cos - dy * sin + renderW / 2,
        iy: dx * sin + dy * cos + renderH / 2,
      };
    },
    [rotRad, containerSize, renderW, renderH],
  );

  /** Convert screen pixel to map mm via affine. */
  const screenToMapMm = useCallback(
    (clientX: number, clientY: number): Pt | null => {
      if (!viewport || !affine || !containerRef.current) return null;
      const rect = containerRef.current.getBoundingClientRect();
      const { ix, iy } = screenToInner(clientX - rect.left, clientY - rect.top);
      const { lat, lng } = pixelToLatlng(ix, iy, viewport, renderW, renderH);
      const mm = affine.toMapMm(lat, lng);
      return { x: mm.mapX, y: mm.mapY };
    },
    [viewport, affine, renderW, renderH, screenToInner],
  );

  /** Convert map mm coords to screen pixel (in the rotated inner space). */
  const mapMmToScreen = useCallback(
    (mapX: number, mapY: number): Pt | null => {
      if (!viewport || !affine || containerSize.w === 0) return null;
      const { lat, lng } = affine.toLatLng(mapX, mapY);
      const { px, py } = latlngToPixel(lat, lng, viewport, renderW, renderH);
      return { x: px, y: py };
    },
    [viewport, affine, renderW, renderH, containerSize],
  );

  /** Inverse of screenToInner: rotated inner coords → container coords.
   *  Used to anchor unrotated HTML (the editor context menu) at a point
   *  that lives in the rotated overlay space. */
  const innerToContainer = useCallback(
    (ix: number, iy: number): Pt => {
      if (rotRad === 0) return { x: ix, y: iy };
      const dx = ix - renderW / 2;
      const dy = iy - renderH / 2;
      const cos = Math.cos(rotRad);
      const sin = Math.sin(rotRad);
      return {
        x: dx * cos - dy * sin + containerSize.w / 2,
        y: dx * sin + dy * cos + containerSize.h / 2,
      };
    },
    [rotRad, containerSize, renderW, renderH],
  );

  // Symbol size in pixels based on zoom and map scale
  const symbolScale = useMemo(() => {
    if (!viewport || !mapScale) return 1;
    const mpp = metersPerPixel(viewport.centerLat, viewport.zoom);
    // 1mm on map = mapScale/1000 meters on ground
    return (mapScale / 1000) / mpp;
  }, [viewport, mapScale]);

  // ─── Measure helpers ────────────────────────────────────

  function mapMmDist(a: Pt, b: Pt) {
    const dx = b.x - a.x, dy = b.y - a.y;
    return Math.sqrt(dx * dx + dy * dy);
  }
  function mmToMeters(d: number) {
    return mapScale ? d * mapScale / 1000 : 0;
  }
  function formatDist(m: number) {
    return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
  }

  // ─── Event Handlers ─────────────────────────────────────

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !viewport) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = el.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      // Transform screen cursor to inner (rotated) coords
      let ix = sx, iy = sy;
      if (rotRad !== 0) {
        const cx = containerSize.w / 2, cy = containerSize.h / 2;
        const dx = sx - cx, dy = sy - cy;
        const cos = Math.cos(-rotRad), sin = Math.sin(-rotRad);
        ix = dx * cos - dy * sin + renderW / 2;
        iy = dx * sin + dy * cos + renderH / 2;
      }
      const rw = renderW || el.clientWidth;
      const rh = renderH || el.clientHeight;

      const cursorGeo = pixelToLatlng(ix, iy, viewport, rw, rh);
      const zoomDelta = e.deltaY > 0 ? -0.15 : 0.15;
      const newZoom = Math.max(1, Math.min(22, viewport.zoom + zoomDelta));

      breakLocateFollowRef.current();
      setViewport((prev) => {
        if (!prev) return prev;
        const newVp = { ...prev, zoom: newZoom };
        const afterCursor = latlngToPixel(cursorGeo.lat, cursorGeo.lng, newVp, rw, rh);
        const dxPx = ix - afterCursor.px;
        const dyPx = iy - afterCursor.py;
        const newCenter = pixelToLatlng(rw / 2 - dxPx, rh / 2 - dyPx, newVp, rw, rh);
        return { centerLat: newCenter.lat, centerLng: newCenter.lng, zoom: newZoom };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [viewport, containerSize, rotRad, renderW, renderH]);

  const finishEditorDrag = useCallback((clientX: number, clientY: number, cancelled: boolean) => {
    const drag = editorDragRef.current;
    if (!editor || !drag) return;
    editorDragRef.current = null;
    isPanningRef.current = false;
    mouseDownPosRef.current = null;
    if (cancelled) {
      setEditorDragPos(null);
      return;
    }
    if (drag.moved) {
      const pt = screenToMapMm(clientX, clientY);
      setEditorDragPos(null);
      if (pt) {
        setPendingMoves((prev) => {
          const next = new Map<string, { from: Pt; to: Pt }>();
          for (const [id, m] of prev) {
            const c = controls.find((k) => k.id === id);
            if (c && Math.abs(c.x - m.from.x) < 1e-9 && Math.abs(c.y - m.from.y) < 1e-9) {
              next.set(id, m);
            }
          }
          next.set(drag.id, { from: { x: drag.origX, y: drag.origY }, to: pt });
          return next;
        });
        editor.onMoveEnd?.(drag.id, pt);
      }
    } else {
      editor.onSelect?.(drag.id);
    }
  }, [editor, screenToMapMm, controls]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if (!measuring) isPanningRef.current = true;
    lastPosRef.current = { x: e.clientX, y: e.clientY };
    mouseDownPosRef.current = { x: e.clientX, y: e.clientY };
  }, [measuring]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    // Editor drag-to-move: once armed (mouse-down on a control), any
    // movement past the click threshold turns into a local drag. Panning
    // never starts in this state — the control's mouse-down handler
    // stopped propagation, so isPanningRef stayed false.
    const drag = editorDragRef.current;
    if (editor && drag) {
      const dx = Math.abs(e.clientX - drag.startX);
      const dy = Math.abs(e.clientY - drag.startY);
      if (drag.moved || dx + dy > 3) {
        drag.moved = true;
        const pt = screenToMapMm(e.clientX, e.clientY);
        if (pt) setEditorDragPos({ id: drag.id, x: pt.x, y: pt.y });
      }
      return;
    }
    if (isPanningRef.current && viewport) {
      let dx = e.clientX - lastPosRef.current.x;
      let dy = e.clientY - lastPosRef.current.y;
      lastPosRef.current = { x: e.clientX, y: e.clientY };
      // Rotate pixel delta to account for map rotation
      if (rotRad !== 0) {
        const cos = Math.cos(-rotRad);
        const sin = Math.sin(-rotRad);
        const rdx = dx * cos - dy * sin;
        const rdy = dx * sin + dy * cos;
        dx = rdx; dy = rdy;
      }
      const rw = renderW || 1;
      const rh = renderH || 1;
      const center = latlngToPixel(viewport.centerLat, viewport.centerLng, viewport, rw, rh);
      const newCenter = pixelToLatlng(center.px - dx, center.py - dy, viewport, rw, rh);
      breakLocateFollow();
      setViewport((prev) => prev ? { ...prev, centerLat: newCenter.lat, centerLng: newCenter.lng } : prev);
    }
    if (measuring) {
      const pt = screenToMapMm(e.clientX, e.clientY);
      if (pt) setMeasureCursor(pt);
    }
  }, [measuring, viewport, renderW, renderH, rotRad, screenToMapMm, editor, breakLocateFollow]);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    const drag = editorDragRef.current;
    if (editor && drag) {
      if (e.type === "mouseleave") {
        finishEditorDrag(e.clientX, e.clientY, true);
        return;
      }
      finishEditorDrag(e.clientX, e.clientY, false);
      return;
    }
    isPanningRef.current = false;
    if (measuring && mouseDownPosRef.current) {
      const dx = Math.abs(e.clientX - mouseDownPosRef.current.x);
      const dy = Math.abs(e.clientY - mouseDownPosRef.current.y);
      if (dx + dy < 5) {
        const now = Date.now();
        if (now - lastClickTimeRef.current < 300) {
          lastClickTimeRef.current = 0;
          setMeasureCursor(null);
        } else {
          lastClickTimeRef.current = now;
          const pt = screenToMapMm(e.clientX, e.clientY);
          if (pt) setMeasurePoints((prev) => [...prev, pt]);
        }
      }
    }
    if (editor && !measuring && mouseDownPosRef.current && e.type !== "mouseleave") {
      const dx = Math.abs(e.clientX - mouseDownPosRef.current.x);
      const dy = Math.abs(e.clientY - mouseDownPosRef.current.y);
      const onButton = (e.target as HTMLElement).closest?.("button");
      if (dx + dy < 5 && !onButton) {
        const pt = screenToMapMm(e.clientX, e.clientY);
        if (pt) editor.onMapClick?.(pt);
      }
    }
    mouseDownPosRef.current = null;
  }, [measuring, screenToMapMm, editor, finishEditorDrag]);

  // Native touch listeners — React root touch handlers are passive, so
  // preventDefault() there does not block page scroll. On coarse pointers
  // outside fullscreen, one finger scrolls the page; two fingers pan/pinch
  // the map. Fullscreen (or fine pointer) keeps one-finger map pan.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !viewportRef.current) return;

    const panByDelta = (dx: number, dy: number) => {
      if (rotRad !== 0) {
        const cos = Math.cos(-rotRad);
        const sin = Math.sin(-rotRad);
        const rdx = dx * cos - dy * sin;
        const rdy = dx * sin + dy * cos;
        dx = rdx; dy = rdy;
      }
      const rw = renderW || 1;
      const rh = renderH || 1;
      breakLocateFollowRef.current();
      setViewport((prev) => {
        if (!prev) return prev;
        const center = latlngToPixel(prev.centerLat, prev.centerLng, prev, rw, rh);
        const newCenter = pixelToLatlng(center.px - dx, center.py - dy, prev, rw, rh);
        return { ...prev, centerLat: newCenter.lat, centerLng: newCenter.lng };
      });
    };

    const maybeShowTwoFingerHint = (clientX: number, clientY: number) => {
      if (!isCoarsePointer || isFullscreen || !touchStartPosRef.current) return;
      const totalDx = Math.abs(clientX - touchStartPosRef.current.x);
      const totalDy = Math.abs(clientY - touchStartPosRef.current.y);
      if (totalDx + totalDy <= 8) return;
      try {
        if (!localStorage.getItem("oxygen.map.twoFingerHintShown")) {
          setShowTwoFingerHint(true);
          localStorage.setItem("oxygen.map.twoFingerHintShown", "1");
        }
      } catch { /* ignore quota / private mode */ }
    };

    const onTouchStart = (e: TouchEvent) => {
      // In fullscreen, one-finger map panning calls preventDefault(). Exempt
      // controls before that path so real mobile browsers can synthesize the
      // button click after touchend.
      const target = e.target;
      if (
        target instanceof Element &&
        target.closest("button, a, input, select, textarea, [role='button']")
      ) return;
      if (e.touches.length === 2) {
        hadMultiTouchRef.current = true;
        suppressEditorSelectionUntilRef.current = Date.now() + 400;
        // A first finger may have landed on a control before the second
        // finger joined. That is a map gesture, not a control drag.
        editorDragRef.current = null;
        setEditorDragPos(null);
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const midpointX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const midpointY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        const distance = Math.sqrt(dx * dx + dy * dy);
        lastTouchRef.current = {
          x: midpointX,
          y: midpointY,
          dist: distance,
        };
        const baseViewport = viewportRef.current;
        if (baseViewport) {
          touchGestureBaseRef.current = {
            x: midpointX,
            y: midpointY,
            dist: distance,
            viewport: baseViewport,
          };
        }
        touchStartPosRef.current = null;
        if (isCoarsePointer && !isFullscreen) e.preventDefault();
        return;
      }
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      lastTouchRef.current = { x: t.clientX, y: t.clientY };
      touchStartPosRef.current = { x: t.clientX, y: t.clientY };
      touchOnEditorTargetRef.current = false;
      if (allowOneFingerMapPan && !measuring) isPanningRef.current = true;
      if (measuring || allowOneFingerMapPan) e.preventDefault();
    };

    const onTouchMove = (e: TouchEvent) => {
      const drag = editorDragRef.current;
      if (drag && e.touches.length === 1) {
        e.preventDefault();
        const t = e.touches[0];
        const dx = Math.abs(t.clientX - drag.startX);
        const dy = Math.abs(t.clientY - drag.startY);
        if (drag.moved || dx + dy > 3) {
          drag.moved = true;
          const pt = screenToMapMm(t.clientX, t.clientY);
          if (pt) setEditorDragPos({ id: drag.id, x: pt.x, y: pt.y });
        }
        return;
      }

      const rw = renderW || 1;
      const rh = renderH || 1;

      if (e.touches.length === 2 && lastTouchRef.current?.dist) {
        e.preventDefault();
        hadMultiTouchRef.current = true;
        suppressEditorSelectionUntilRef.current = Date.now() + 400;
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        lastTouchRef.current = { x: midX, y: midY, dist };
        pendingTouchGestureRef.current = { x: midX, y: midY, dist };

        // Touch hardware may emit substantially more than 60 move events per
        // second. Rendering every event is especially expensive when many
        // control overlays are visible, so coalesce to one viewport update
        // per animation frame.
        if (touchGestureFrameRef.current === null) {
          touchGestureFrameRef.current = requestAnimationFrame(() => {
            touchGestureFrameRef.current = null;
            const base = touchGestureBaseRef.current;
            const current = pendingTouchGestureRef.current;
            if (!base || !current) return;

            const rect = el.getBoundingClientRect();
            const toInner = (clientX: number, clientY: number) => {
              const sx = clientX - rect.left;
              const sy = clientY - rect.top;
              if (rotRad === 0) return { x: sx, y: sy };
              const cx = containerSize.w / 2;
              const cy = containerSize.h / 2;
              const ddx = sx - cx;
              const ddy = sy - cy;
              const cos = Math.cos(-rotRad);
              const sin = Math.sin(-rotRad);
              return {
                x: ddx * cos - ddy * sin + rw / 2,
                y: ddx * sin + ddy * cos + rh / 2,
              };
            };

            // The geographical point under the gesture's original midpoint
            // must move to the current midpoint. This single transform
            // combines midpoint translation (pan) and distance change (zoom).
            const from = toInner(base.x, base.y);
            const to = toInner(current.x, current.y);
            const anchorGeo = pixelToLatlng(
              from.x,
              from.y,
              base.viewport,
              rw,
              rh,
            );
            const newZoom = Math.max(
              1,
              Math.min(
                22,
                base.viewport.zoom + Math.log2(current.dist / base.dist),
              ),
            );
            const zoomed: TileViewport = {
              ...base.viewport,
              zoom: newZoom,
            };
            const anchorAfterZoom = latlngToPixel(
              anchorGeo.lat,
              anchorGeo.lng,
              zoomed,
              rw,
              rh,
            );
            const center = pixelToLatlng(
              rw / 2 - (to.x - anchorAfterZoom.px),
              rh / 2 - (to.y - anchorAfterZoom.py),
              zoomed,
              rw,
              rh,
            );
            const next = {
              centerLat: center.lat,
              centerLng: center.lng,
              zoom: newZoom,
            };
            breakLocateFollowRef.current();
            viewportRef.current = next;
            setViewport(next);
          });
        }
        return;
      }

      if (e.touches.length === 1 && lastTouchRef.current) {
        const t = e.touches[0];
        const dx = t.clientX - lastTouchRef.current.x;
        const dy = t.clientY - lastTouchRef.current.y;
        if (allowOneFingerMapPan || measuring) {
          e.preventDefault();
          panByDelta(dx, dy);
          lastTouchRef.current = { x: t.clientX, y: t.clientY };
          if (measuring) {
            const pt = screenToMapMm(t.clientX, t.clientY);
            if (pt) setMeasureCursor(pt);
          }
        } else {
          maybeShowTwoFingerHint(t.clientX, t.clientY);
        }
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      const drag = editorDragRef.current;
      if (drag && e.changedTouches.length > 0 && e.touches.length === 0) {
        if (
          hadMultiTouchRef.current ||
          Date.now() < suppressEditorSelectionUntilRef.current
        ) {
          editorDragRef.current = null;
          setEditorDragPos(null);
          lastTouchRef.current = null;
          touchStartPosRef.current = null;
          hadMultiTouchRef.current = false;
          isPanningRef.current = false;
          return;
        }
        const t = e.changedTouches[0];
        finishEditorDrag(t.clientX, t.clientY, false);
        return;
      }

      if (e.touches.length === 0) {
        if (hadMultiTouchRef.current) {
          suppressEditorSelectionUntilRef.current = Date.now() + 400;
        }
        if (measuring && touchStartPosRef.current && e.changedTouches.length > 0) {
          const t = e.changedTouches[0];
          const dx = Math.abs(t.clientX - touchStartPosRef.current.x);
          const dy = Math.abs(t.clientY - touchStartPosRef.current.y);
          if (dx + dy < 10) {
            const now = Date.now();
            if (now - lastClickTimeRef.current < 300) {
              lastClickTimeRef.current = 0;
              setMeasureCursor(null);
            } else {
              lastClickTimeRef.current = now;
              const pt = screenToMapMm(t.clientX, t.clientY);
              if (pt) setMeasurePoints((prev) => [...prev, pt]);
            }
          }
        }
        if (
          editor && !measuring && !hadMultiTouchRef.current &&
          !touchOnEditorTargetRef.current &&
          touchStartPosRef.current && e.changedTouches.length > 0
        ) {
          const t = e.changedTouches[0];
          const dx = Math.abs(t.clientX - touchStartPosRef.current.x);
          const dy = Math.abs(t.clientY - touchStartPosRef.current.y);
          const target = e.target as HTMLElement;
          const onButton = target.closest?.("button");
          if (dx + dy < 10 && !onButton) {
            const pt = screenToMapMm(t.clientX, t.clientY);
            if (pt) editor.onMapClick?.(pt);
          }
        }
        lastTouchRef.current = null;
        touchStartPosRef.current = null;
        hadMultiTouchRef.current = false;
        isPanningRef.current = false;
      } else if (e.touches.length === 1) {
        lastTouchRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }
    };

    el.addEventListener("touchstart", onTouchStart, { passive: false });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: false });
    el.addEventListener("touchcancel", onTouchEnd, { passive: false });
    return () => {
      if (touchGestureFrameRef.current !== null) {
        cancelAnimationFrame(touchGestureFrameRef.current);
        touchGestureFrameRef.current = null;
      }
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [
    viewport !== null,
    containerSize, renderW, renderH, rotRad, measuring, editor,
    isFullscreen, isCoarsePointer, allowOneFingerMapPan, screenToMapMm,
    finishEditorDrag,
  ]);

  useEffect(() => {
    if (!showTwoFingerHint) return;
    const timer = window.setTimeout(() => setShowTwoFingerHint(false), 2500);
    return () => window.clearTimeout(timer);
  }, [showTwoFingerHint]);

  // Escape / Backspace to cancel / undo measure
  useEffect(() => {
    if (!measuring) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMeasuring(false);
        setMeasurePoints([]);
        setMeasureCursor(null);
      } else if (e.key === "Backspace") {
        setMeasurePoints((prev) => prev.slice(0, -1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [measuring]);

  // ─── Editor event handlers ──────────────────────────────
  // Hoisted out of the overlay memo (they write refs, which must not
  // happen in render scope) — the JSX inside the memo only closes over
  // these stable callbacks.

  /** Arm a control drag on pointer-down over a control hit target. */
  const beginControlDrag = useCallback(
    (id: string, origX: number, origY: number, clientX: number, clientY: number) => {
      editorDragRef.current = { id, startX: clientX, startY: clientY, moved: false, origX, origY };
    },
    [],
  );

  const beginControlDragMouse = useCallback(
    (id: string, origX: number, origY: number, e: React.MouseEvent) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      beginControlDrag(id, origX, origY, e.clientX, e.clientY);
    },
    [beginControlDrag],
  );

  const beginControlDragTouch = useCallback(
    (id: string, origX: number, origY: number, e: React.TouchEvent) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      if (!t) return;
      e.stopPropagation();
      touchOnEditorTargetRef.current = true;
      if (Date.now() < suppressEditorSelectionUntilRef.current) return;
      beginControlDrag(id, origX, origY, t.clientX, t.clientY);
    },
    [beginControlDrag],
  );

  const handleControlTouchMove = useCallback((e: React.TouchEvent) => {
    const drag = editorDragRef.current;
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();
    const t = e.touches[0];
    if (!t) return;
    const dx = Math.abs(t.clientX - drag.startX);
    const dy = Math.abs(t.clientY - drag.startY);
    if (drag.moved || dx + dy > 3) {
      drag.moved = true;
      const pt = screenToMapMm(t.clientX, t.clientY);
      if (pt) setEditorDragPos({ id: drag.id, x: pt.x, y: pt.y });
    }
  }, [screenToMapMm]);

  const handleControlTouchEnd = useCallback((e: React.TouchEvent) => {
    e.stopPropagation();
    if (!editorDragRef.current) return;
    if (
      hadMultiTouchRef.current ||
      Date.now() < suppressEditorSelectionUntilRef.current
    ) {
      editorDragRef.current = null;
      setEditorDragPos(null);
      return;
    }
    const t = e.changedTouches[0];
    if (!t) return;
    finishEditorDrag(t.clientX, t.clientY, false);
  }, [finishEditorDrag]);

  const legHitMouseDown = useCallback(
    (course: string, index: number, e: React.MouseEvent) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      legDownRef.current = { course, index, x: e.clientX, y: e.clientY };
    },
    [],
  );

  const legHitMouseUp = useCallback(
    (course: string, index: number, e: React.MouseEvent) => {
      const ld = legDownRef.current;
      legDownRef.current = null;
      if (!ld || ld.course !== course || ld.index !== index) return;
      if (
        hadMultiTouchRef.current ||
        Date.now() < suppressEditorSelectionUntilRef.current
      ) return;
      if (Math.abs(e.clientX - ld.x) + Math.abs(e.clientY - ld.y) >= 5) return;
      e.stopPropagation();
      const pt = screenToMapMm(e.clientX, e.clientY);
      if (pt) editor?.onLegClick?.(course, index, pt);
    },
    [screenToMapMm, editor],
  );

  const legHitTouchStart = useCallback(
    (course: string, index: number, e: React.TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      e.stopPropagation();
      touchOnEditorTargetRef.current = true;
      legDownRef.current = { course, index, x: t.clientX, y: t.clientY };
    },
    [],
  );

  const legHitTouchEnd = useCallback(
    (course: string, index: number, e: React.TouchEvent) => {
      const ld = legDownRef.current;
      legDownRef.current = null;
      if (!ld || ld.course !== course || ld.index !== index) return;
      const t = e.changedTouches[0];
      if (!t) return;
      if (Math.abs(t.clientX - ld.x) + Math.abs(t.clientY - ld.y) >= 5) return;
      e.stopPropagation();
      const pt = screenToMapMm(t.clientX, t.clientY);
      if (pt) editor?.onLegClick?.(course, index, pt);
    },
    [screenToMapMm, editor],
  );

  // Helper: get slit cuts from course geometry for a given control code
  function getCourseGeomCuts(code: string): SlitGap[] | null {
    if (!courseGeometry) return null;
    const features = courseGeometry.features || [];
    for (const f of features) {
      if (f.properties?.symbolType === "control" && f.properties?.code === code && f.properties?.cuts) {
        return f.properties.cuts;
      }
    }
    return null;
  }

  // ─── Overlay rendering ─────────────────────────────────

  const overlayContent = useMemo(() => {
    if (!viewport || containerSize.w === 0 || containerSize.h === 0) return null;
    const cw = renderW;
    const ch = renderH;

    const radius = 2.5 * symbolScale;
    const stroke = Math.max(0.5, 0.35 * symbolScale);
    const labelSize = 3.5 * symbolScale;
    const startSize = 3.5 * symbolScale;
    const finishInner = 2.0 * symbolScale;
    const finishOuter = 3.0 * symbolScale;
    const legStroke = Math.max(0.5, 0.35 * symbolScale);

    // Build pixel positions for all controls (fallback from lat/lng)
    const ctrlPixels = new Map<string, Pt>();
    for (const c of controls) {
      if (c.lat === 0 && c.lng === 0) continue;
      const { px, py } = latlngToPixel(c.lat, c.lng, viewport, cw, ch);
      ctrlPixels.set(c.id, { x: px, y: py });
    }

    // Override with precise OCAD positions from courseGeometry when available
    if (courseGeometry && affine) {
      for (const f of (courseGeometry.features || [])) {
        const p = f.properties;
        if (!p?.code || !f.geometry || f.geometry.type !== "Point") continue;
        if (p.symbolType !== "control" && p.symbolType !== "start" && p.symbolType !== "finish") continue;
        const [mx, my] = f.geometry.coordinates as [number, number];
        const { lat, lng } = affine.toLatLng(mx, my);
        const { px, py } = latlngToPixel(lat, lng, viewport, cw, ch);
        const ctrl = controls.find(c => c.code === p.code);
        if (ctrl) ctrlPixels.set(ctrl.id, { x: px, y: py });
      }
    }

    // Editor overrides win over everything: a control being dragged (or
    // whose move is still round-tripping) renders at its local position.
    // A pending move only applies while the control still reports the
    // position it had when the drag started — once the refetch lands (or
    // an external writer moved it) the entry is inert.
    if (editor) {
      for (const [id, m] of pendingMoves) {
        const c = controls.find((k) => k.id === id);
        if (!c) continue;
        if (Math.abs(c.x - m.from.x) > 1e-9 || Math.abs(c.y - m.from.y) > 1e-9) continue;
        const p = mapMmToScreen(m.to.x, m.to.y);
        if (p) ctrlPixels.set(id, p);
      }
      if (editorDragPos) {
        const p = mapMmToScreen(editorDragPos.x, editorDragPos.y);
        if (p) ctrlPixels.set(editorDragPos.id, p);
      }
    }

    const elements: React.ReactNode[] = [];
    // Editor hit-target metadata. The JSX (with its ref-writing event
    // handlers) is materialized OUTSIDE this memo — the React Compiler
    // lint treats everything inside useMemo as render-scope, where ref
    // access is forbidden. The memo only computes positions.
    const controlHits: EditorControlHit[] = [];
    const legHits: EditorLegHit[] = [];

    // Line segments actually drawn on screen (course legs, marked and
    // forbidden routes — of every course rendered). Collected while
    // rendering and fed to the control-number placement so numbers avoid
    // exactly the lines the user sees, no more (courses that are not
    // drawn must not push labels around) and no less.
    const drawnLineSegs: PlacementSeg[] = [];

    // Highlighted courses drive fallback legs, multi-course leg labels
    // and description numbering below.
    const highlightedCourses = courses.filter(
      (c) => c.highlight || c.name === highlightCourseName,
    );
    // With more than one course on screen it's hard to tell which lines
    // belong to what — label each leg with the classes that run it.
    const legLabelMode = highlightedCourses.length > 1;

    // ─── Course geometry (GeoJSON) ───────────────────────

    // Per-course running leg ordinal for the editor's insert-on-leg hit
    // lines. Leg features appear in course order (one feature per leg),
    // so counting them per course name yields the 0-based leg index.
    const geomLegIndex = new Map<string, number>();
    /** Record one invisible fat hit-line along a leg polyline. */
    const pushLegHit = (key: string, d: string, courseName: string, legIndex: number) => {
      if (!editor?.onLegClick) return;
      legHits.push({ key, d, course: courseName, index: legIndex });
    };

    if (courseGeometry && affine) {
      const features = courseGeometry.features || [];
      for (let fi = 0; fi < features.length; fi++) {
        const feature = features[fi];
        const props = feature.properties || {};
        const geom = feature.geometry;
        if (!geom) continue;

        if (props.symbolType === "leg" && geom.type === "LineString") {
          const coords = geom.coordinates as [number, number][];
          if (coords.length < 2) continue;

          const screenPts: Pt[] = [];
          for (const [mx, my] of coords) {
            const { lat, lng } = affine.toLatLng(mx, my);
            const { px, py } = latlngToPixel(lat, lng, viewport, cw, ch);
            screenPts.push({ x: px, y: py });
          }
          for (let si = 0; si < screenPts.length - 1; si++) {
            drawnLineSegs.push({
              x1: screenPts[si].x, y1: screenPts[si].y,
              x2: screenPts[si + 1].x, y2: screenPts[si + 1].y,
            });
          }

          // Insert-on-leg hit line spanning the full (unclipped) leg.
          {
            const legCourse: string | undefined =
              props.courseName ?? highlightCourseName ?? undefined;
            if (legCourse) {
              const idx = geomLegIndex.get(legCourse) ?? 0;
              geomLegIndex.set(legCourse, idx + 1);
              const fullD = screenPts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
              pushLegHit(`edit-leg-${fi}`, fullD, legCourse, idx);
            }
          }

          if (props.preclipped) {
            const d = screenPts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
            elements.push(
              <path key={`leg-${fi}`} d={d} stroke="#c026d3" strokeWidth={legStroke} fill="none" opacity={0.85} />
            );
          } else {
            // Automatic overprint gaps (black map features under the
            // leg), computed server-side into the geometry as fractions
            // of the full leg.
            const legGaps: { from: number; to: number }[] = Array.isArray(props.gaps)
              ? props.gaps
              : [];
            const pieces =
              legGaps.length > 0 ? subtractLegGaps(screenPts, legGaps) : [screenPts];
            // Only visible controls clip the leg. When the user has
            // "show only relevant" on (the default for a single-course
            // selection), unrelated controls have `visible: false` and
            // therefore aren't drawn as circles — so they shouldn't
            // chop a slit out of an unrelated course's leg either.
            // When showAllControls is on, every control is visible
            // again and the original "leg breaks around any circle on
            // the map" behaviour is preserved.
            const obstacles: Pt[] = [];
            for (const c of controls) {
              if (c.visible === false) continue;
              const p = ctrlPixels.get(c.id);
              if (p) obstacles.push(p);
            }
            const gapped = pieces.length > 1 ? "true" : undefined;
            for (let pi = 0; pi < pieces.length; pi++) {
              const pts = pieces[pi];
              for (let si = 0; si < pts.length - 1; si++) {
                const segs = clipLine(pts[si], pts[si + 1], obstacles, radius * 1.2);
                for (let segi = 0; segi < segs.length; segi++) {
                  const seg = segs[segi];
                  elements.push(
                    <line key={`leg-${fi}-${pi}-${si}-${segi}`}
                      x1={seg.x1} y1={seg.y1} x2={seg.x2} y2={seg.y2}
                      data-leg-gapped={gapped}
                      stroke="#c026d3" strokeWidth={legStroke} opacity={0.85} />
                  );
                }
              }
            }
          }
        } else if (props.symbolType === "marked_route" && geom.type === "LineString") {
          const coords = geom.coordinates as [number, number][];
          const screenPts = coords.map(([mx, my]) => {
            const { lat, lng } = affine.toLatLng(mx, my);
            return latlngToPixel(lat, lng, viewport, cw, ch);
          });
          for (let si = 0; si < screenPts.length - 1; si++) {
            drawnLineSegs.push({
              x1: screenPts[si].px, y1: screenPts[si].py,
              x2: screenPts[si + 1].px, y2: screenPts[si + 1].py,
            });
          }
          const d = screenPts.map((p, i) => `${i === 0 ? "M" : "L"}${p.px.toFixed(1)},${p.py.toFixed(1)}`).join(" ");
          elements.push(
            <path key={`route-${fi}`} d={d} stroke="#c026d3" strokeWidth={legStroke * 1.5}
              fill="none" opacity={0.7} strokeDasharray={`${legStroke * 4} ${legStroke * 2}`} />
          );
        } else if ((props.symbolType === "forbidden_route" || props.symbolType === "restricted_line") && geom.type === "LineString") {
          const coords = geom.coordinates as [number, number][];
          const screenPts = coords.map(([mx, my]) => {
            const { lat, lng } = affine.toLatLng(mx, my);
            return latlngToPixel(lat, lng, viewport, cw, ch);
          });
          for (let si = 0; si < screenPts.length - 1; si++) {
            drawnLineSegs.push({
              x1: screenPts[si].px, y1: screenPts[si].py,
              x2: screenPts[si + 1].px, y2: screenPts[si + 1].py,
            });
          }
          const d = screenPts.map((p, i) => `${i === 0 ? "M" : "L"}${p.px.toFixed(1)},${p.py.toFixed(1)}`).join(" ");
          elements.push(
            <path key={`restrict-${fi}`} d={d} stroke="#c026d3" strokeWidth={legStroke * 2}
              fill="none" opacity={0.6}
              strokeDasharray={props.symbolType === "forbidden_route" ? `${legStroke * 6} ${legStroke * 3}` : "none"} />
          );
        }
        // Note: start/finish/control symbols are rendered by the "Control symbols"
        // section below (with click handlers, badges, highlights, etc.).
        // Rendering them here from courseGeometry would produce duplicate rings.
      }
    }

    // ─── GPS route traces ─────────────────────────────────

    if (gpsRoutes && gpsRoutes.length > 0 && viewport) {
      for (let ri = 0; ri < gpsRoutes.length; ri++) {
        const route = gpsRoutes[ri];
        if (route.points.length < 2) continue;
        const screenPts = route.points.map(({ lat, lng }) =>
          latlngToPixel(lat, lng, viewport, cw, ch),
        );
        const d = screenPts
          .map((p, i) => `${i === 0 ? "M" : "L"}${p.px.toFixed(1)},${p.py.toFixed(1)}`)
          .join(" ");
        elements.push(
          <path
            key={`gps-${ri}`}
            d={d}
            stroke={route.color}
            strokeWidth={4.5}
            fill="none"
            strokeLinejoin="round"
            strokeLinecap="round"
            opacity={0.8}
          />,
        );
      }
    }

    // ─── Fallback legs for every highlighted course ───────
    //
    // Draw straight-line legs (clipped around control circles) for every
    // highlighted course that isn't already covered by `courseGeometry`.
    // When `coursesWithGeometry` is provided, it lists the courses whose
    // routes are already drawn from precise OCD/XML geometry — those we
    // skip. Anything else highlighted (selection without imported routes,
    // or selection alongside geometry-only courses) gets legs here so
    // the user always sees *every* selected course connected.
    //
    // Back-compat: when neither `coursesWithGeometry` nor `courseGeometry`
    // is provided, fall back to the legacy behaviour of drawing just one
    // highlighted course.
    let coursesToDraw: typeof courses;
    if (coursesWithGeometry) {
      coursesToDraw = highlightedCourses.filter((c) => !coursesWithGeometry.has(c.name));
    } else if (!courseGeometry) {
      coursesToDraw = highlightedCourses.slice(0, 1);
    } else {
      coursesToDraw = [];
    }

    for (const course of coursesToDraw) {
      const obstacles: Pt[] = [];
      for (const cid of course.controls) {
        const p = ctrlPixels.get(cid);
        if (p) obstacles.push(p);
      }

      for (let i = 0; i < course.controls.length - 1; i++) {
        const fromPt = ctrlPixels.get(course.controls[i]);
        const toPt = ctrlPixels.get(course.controls[i + 1]);
        if (!fromPt || !toPt) continue;
        drawnLineSegs.push({ x1: fromPt.x, y1: fromPt.y, x2: toPt.x, y2: toPt.y });
        pushLegHit(
          `edit-fleg-${course.name}-${i}`,
          `M${fromPt.x.toFixed(1)},${fromPt.y.toFixed(1)} L${toPt.x.toFixed(1)},${toPt.y.toFixed(1)}`,
          course.name,
          i,
        );
        const segs = clipLine(fromPt, toPt, obstacles, radius * 1.2);
        for (let segi = 0; segi < segs.length; segi++) {
          const seg = segs[segi];
          elements.push(
            <line key={`fleg-${course.name}-${i}-${segi}`}
              x1={seg.x1} y1={seg.y1} x2={seg.x2} y2={seg.y2}
              stroke="#c026d3" strokeWidth={legStroke} opacity={0.85} />
          );
        }
      }
    }

    // ─── Control symbols ─────────────────────────────────

    const sortedControls = [...controls].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

    // In description mode with a SINGLE course, map control IDs to sequence
    // numbers (1, 2, 3, …) — a proper course card. With multiple courses
    // selected there is no meaningful shared sequence, so every control
    // keeps its code and the description sheet lists all of them by code.
    // The course editor gets the same numbering while a course is being
    // edited, so the on-map labels match the sidebar sequence rows.
    const sequenceNumbering =
      (showDescriptions || !!editor) && highlightedCourses.length === 1;
    const sequenceMap = new Map<string, number>();
    if (sequenceNumbering) {
      let seq = 0;
      for (const cid of highlightedCourses[0].controls) {
        const ctrl = controls.find(c => c.id === cid);
        if (ctrl && ctrl.type === "Control") {
          seq++;
          sequenceMap.set(cid, seq);
        }
      }
    }

    // Control-number placement (pure module, unit-tested). Inputs are
    // exactly what is on screen: every VISIBLE circle is an obstacle
    // (start triangles and finish rings with their real extents), regular
    // controls carry their label, and `drawnLineSegs` holds the legs of
    // every drawn course. All cost terms scale with the symbol sizes, so
    // the chosen slots don't change when zooming — only when the set of
    // visible controls or drawn courses does.
    const placementCircles: PlacementCircle[] = [];
    for (const c of sortedControls) {
      if (c.visible === false) continue;
      const pos = ctrlPixels.get(c.id);
      if (!pos) continue;
      if (c.type === "Start") {
        placementCircles.push({ id: c.id, x: pos.x, y: pos.y, radius: startSize });
      } else if (c.type === "Finish") {
        placementCircles.push({ id: c.id, x: pos.x, y: pos.y, radius: finishOuter });
      } else {
        const label = sequenceNumbering && sequenceMap.has(c.id)
          ? String(sequenceMap.get(c.id))
          : c.code;
        placementCircles.push({ id: c.id, x: pos.x, y: pos.y, label });
      }
    }
    const placedControlLabels = hideControls
      ? new Map<string, never>()
      : placeControlLabels(placementCircles, drawnLineSegs, { radius, labelSize });

    for (const c of sortedControls) {
      if (c.visible === false) continue;
      const pos = ctrlPixels.get(c.id);
      if (!pos) continue;

      const isHighlighted = c.highlight || c.id === highlightControlId;
      const baseColor =
        c.punchStatus === "missing" ? "#ef4444" :
        c.punchStatus === "extra" ? "#f59e0b" :
        c.punchStatus === "ok" ? "#059669" :
        isHighlighted ? "#ef4444" :
        "#c026d3";
      // Editor fading: while a course is selected, regular controls off
      // the course recede (Purple Pen style) — still purple, still
      // clickable. Start/finish stay at full strength.
      const fade =
        editor?.fadeNonCourse && c.type === "Control" && !editor.courseControlIds?.has(c.id)
          ? 0.3
          : undefined;

      if (c.type === "Start") {
        const s = startSize;
        const triPath = `M${pos.x},${pos.y - s} L${pos.x - s * 0.866},${pos.y + s * 0.5} L${pos.x + s * 0.866},${pos.y + s * 0.5} Z`;
        elements.push(
          <path key={`start-${c.id}`} d={triPath} stroke={baseColor} strokeWidth={stroke} fill="none"
            style={{ cursor: onControlClick ? "pointer" : undefined }}
            onClick={onControlClick ? () => onControlClick(c.id) : undefined} />
        );
      } else if (c.type === "Finish") {
        elements.push(
          <g key={`finish-${c.id}`} style={{ cursor: onControlClick ? "pointer" : undefined }}
            onClick={onControlClick ? () => onControlClick(c.id) : undefined}>
            <circle cx={pos.x} cy={pos.y} r={finishOuter} stroke={baseColor} strokeWidth={stroke} fill="none" />
            <circle cx={pos.x} cy={pos.y} r={finishInner} stroke={baseColor} strokeWidth={stroke} fill="none" />
          </g>
        );
      } else {
        const cuts = getCourseGeomCuts(c.code);

        if (cuts && cuts.length > 0) {
          const adj = cuts.map(g => ({ start: g.start + (northOffset || 0), end: g.end + (northOffset || 0) }));
          const arcs = drawBrokenCircle(pos.x, pos.y, radius, adj);
          elements.push(
            <path key={`ctrl-${c.id}`} d={arcs} stroke={baseColor} strokeWidth={stroke} fill="none"
              data-testid="control-circle-cut"
              opacity={fade}
              style={{ cursor: onControlClick ? "pointer" : undefined }}
              onClick={onControlClick ? () => onControlClick(c.id) : undefined} />
          );
        } else {
          elements.push(
            <circle key={`ctrl-${c.id}`} cx={pos.x} cy={pos.y} r={radius} stroke={baseColor} strokeWidth={stroke} fill="none"
              opacity={fade}
              style={{ cursor: onControlClick ? "pointer" : undefined }}
              onClick={onControlClick ? () => onControlClick(c.id) : undefined} />
          );
        }

        // Completion ring (overlaps control circle at same radius)
        if (c.completionPct !== undefined && c.completionPct > 0) {
          const ringR = radius;
          const pct = Math.min(c.completionPct, 1);
          if (pct >= 1) {
            elements.push(
              <circle key={`comp-${c.id}`} cx={pos.x} cy={pos.y} r={ringR}
                stroke="#059669" strokeWidth={stroke * 2.5} fill="none" opacity={0.8} />
            );
          } else {
            const angle = pct * 2 * Math.PI;
            const startAngle = -Math.PI / 2;
            const endAngle = startAngle + angle;
            const x1 = pos.x + ringR * Math.cos(startAngle);
            const y1 = pos.y + ringR * Math.sin(startAngle);
            const x2 = pos.x + ringR * Math.cos(endAngle);
            const y2 = pos.y + ringR * Math.sin(endAngle);
            const largeArc = angle > Math.PI ? 1 : 0;
            elements.push(
              <path key={`comp-${c.id}`}
                d={`M${x1},${y1} A${ringR},${ringR} 0 ${largeArc} 1 ${x2},${y2}`}
                stroke="#059669" strokeWidth={stroke * 2.5} fill="none" opacity={0.8} />
            );
          }
        }

        // Punch count badge
        if (c.punchCount !== undefined && c.punchCount > 0) {
          const badgeR = Math.max(6, labelSize * 0.5);
          elements.push(
            <g key={`badge-${c.id}`}
              transform={rotDeg !== 0 ? `rotate(${-rotDeg}, ${pos.x}, ${pos.y})` : undefined}>
              <circle cx={pos.x} cy={pos.y} r={badgeR} fill="#2563eb" opacity={0.85} />
              <text x={pos.x} y={pos.y} textAnchor="middle" dominantBaseline="central"
                fontSize={badgeR * 1.2} fill="white" fontWeight="bold">
                {c.punchCount}
              </text>
            </g>
          );
        }

        // Control code label (or sequence number in description mode) —
        // position chosen by the placement module above.
        const placedLabel = placedControlLabels.get(c.id);
        if (placedLabel) {
          const label = sequenceNumbering && sequenceMap.has(c.id)
            ? String(sequenceMap.get(c.id))
            : c.code;
          const labelColor = (c.completionPct !== undefined && c.completionPct >= 1) ? "#059669" : baseColor;
          // Contested label (congested cluster): thin leader line from the
          // number to its own circle, so the association stays readable.
          if (placedLabel.leader) {
            const ld = placedLabel.leader;
            elements.push(
              <line key={`leader-${c.id}`} x1={ld.x1} y1={ld.y1} x2={ld.x2} y2={ld.y2}
                stroke={labelColor} strokeWidth={stroke * 0.7} opacity={fade ?? 0.9}
                data-testid="control-label-leader" />
            );
          }
          elements.push(
            <text key={`label-${c.id}`} x={placedLabel.x} y={placedLabel.y}
              textAnchor="middle" dominantBaseline="central"
              fontSize={labelSize} fill={labelColor} fontWeight="bold"
              opacity={fade}
              transform={rotDeg !== 0 ? `rotate(${-rotDeg}, ${placedLabel.x}, ${placedLabel.y})` : undefined}
              style={{ cursor: onControlClick ? "pointer" : undefined }}
              onClick={onControlClick ? () => onControlClick(c.id) : undefined}>
              {label}
            </text>
          );
        }
      }

      // Editor: selection ring + grab target. The hit circle is filled
      // (transparent) so the whole symbol interior is grabbable — the
      // visible rings are stroke-only and would otherwise only respond
      // on their outline.
      if (editor) {
        const symbolR = c.type === "Start" ? startSize : c.type === "Finish" ? finishOuter : radius;
        if (editor.selectedControlId === c.id) {
          elements.push(
            <circle key={`edit-sel-${c.id}`} cx={pos.x} cy={pos.y} r={symbolR * 1.45}
              stroke="#2563eb" strokeWidth={Math.max(1, stroke * 0.8)} fill="none"
              strokeDasharray={`${Math.max(2, stroke * 2)} ${Math.max(2, stroke * 2)}`}
              opacity={0.9} style={{ pointerEvents: "none" }}
              data-testid="editor-selection-ring" />
          );
        }
        controlHits.push({
          id: c.id, code: c.code,
          px: pos.x, py: pos.y, r: Math.max(symbolR, 10),
          mmX: c.x, mmY: c.y,
        });
      }
    }

    // ─── Multi-course leg labels ──────────────────────────
    //
    // One label per unique leg (control pair), centered between the two
    // controls; legs shared by several courses carry the union
    // ("Öppen 1, Öppen 2"). Styled like the measure tool's per-leg
    // distance pills, and rendered AFTER the control symbols so circles
    // and code labels never cover them. Base size is the measure label's
    // 11px, clamped to zoom: at deep zoom-in the pill never gets thinner
    // than the course line (it exactly covers it), and at zoom-out the
    // text never exceeds a third of the control-code font. Per label,
    // text longer than its leg shrinks to fit or is dropped.
    if (legLabelMode) {
      // The pill is always exactly as tall as the course line — embedded
      // in it, not riding on it — at every zoom level. A tight pill/font
      // ratio keeps the text close to the full line width. Labels only
      // shrink below this when their text wouldn't fit the leg length.
      const pillRatio = 1.15; // pill height / font size
      const baseFontSize = legStroke / pillRatio;
      // The visible line stops at the circle edges — same clearances the
      // leg clipping uses, with the finish's outer ring being the widest.
      const typeById = new Map(controls.map((c) => [c.id, c.type]));
      const clearance = (id: string) => {
        const type = typeById.get(id);
        if (type === "Finish") return finishOuter * 1.2;
        if (type === "Start") return startSize * 1.2;
        return radius * 1.2;
      };
      const placed = buildCourseLegLabels(
        highlightedCourses.map((c) => ({
          text: courseLegLabelText(c.name, c.classNames),
          controlIds: c.controls,
        })),
        ctrlPixels,
        { baseFontSize, minFontSize: 5, mapRotationDeg: rotDeg, clearance },
      );
      for (let li = 0; li < placed.length; li++) {
        const l = placed[li];
        const fs = l.fontSize;
        const pillH = fs * pillRatio;
        const halfW = pillHalfWidth(l.text.length, fs);
        elements.push(
          <g
            key={`leg-label-${li}`}
            transform={`translate(${l.x.toFixed(1)}, ${l.y.toFixed(1)}) rotate(${l.angleDeg.toFixed(1)})`}
            style={{ pointerEvents: "none" }}
          >
            <rect x={-halfW} y={-pillH / 2} width={halfW * 2} height={pillH}
              rx={fs * 0.27}
              fill="rgba(255,255,255,0.85)" stroke="#d8b4fe"
              strokeWidth={Math.max(0.4, fs * 0.045)} />
            <text x={0} y={0} textAnchor="middle" dominantBaseline="central"
              fontSize={fs} fill="#86198f" fontWeight={600}>
              {l.text}
            </text>
          </g>
        );
      }
    }

    // Description sheet rendered separately (outside rotated div)

    // ─── Measure overlay ────────────────────────────────

    if (measuring && measurePoints.length > 0) {
      const screenMeasurePts = measurePoints.map((p) => mapMmToScreen(p.x, p.y)).filter(Boolean) as Pt[];
      let cursorScreen: Pt | null = null;
      if (measureCursor) cursorScreen = mapMmToScreen(measureCursor.x, measureCursor.y);

      const allPts = cursorScreen ? [...screenMeasurePts, cursorScreen] : screenMeasurePts;

      if (allPts.length >= 2) {
        const d = allPts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
        elements.push(
          <path key="measure-line" d={d} stroke="#2563eb" strokeWidth={3} fill="none" strokeDasharray="10 5" />
        );

        // Per-leg distance labels
        for (let i = 1; i < allPts.length; i++) {
          const p1 = allPts[i - 1], p2 = allPts[i];
          const midX = (p1.x + p2.x) / 2;
          const midY = (p1.y + p2.y) / 2;
          const srcPt1 = measurePoints[i - 1];
          const srcPt2 = i < measurePoints.length ? measurePoints[i] : measureCursor;
          if (srcPt1 && srcPt2) {
            const legM = mmToMeters(mapMmDist(srcPt1, srcPt2));
            const label = formatDist(legM);
            const halfW = label.length * 3.5 + 6;
            elements.push(
              <g key={`mleg-${i}`}>
                <rect x={midX - halfW} y={midY - 9} width={halfW * 2} height={16} rx={3}
                  fill="rgba(255,255,255,0.85)" stroke="#93c5fd" strokeWidth={0.5} />
                <text x={midX} y={midY} textAnchor="middle" dominantBaseline="central"
                  fontSize={11} fill="#1e3a8a" fontWeight="600">{label}</text>
              </g>
            );
          }
        }
      }

      for (let i = 0; i < screenMeasurePts.length; i++) {
        elements.push(
          <circle key={`mpt-${i}`} cx={screenMeasurePts[i].x} cy={screenMeasurePts[i].y}
            r={5} fill="#2563eb" stroke="white" strokeWidth={2} />
        );
      }
    }

    return { nodes: elements, controlHits, legHits, radiusPx: radius, strokePx: stroke };

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewport, containerSize, renderW, renderH, controls, courses, courseGeometry, coursesWithGeometry, highlightControlId, highlightCourseName,
      symbolScale, affine, measuring, measurePoints, measureCursor, showDescriptions, hideControls, onControlClick,
      mapMmToScreen, rotDeg, gpsRoutes, editor, editorDragPos, pendingMoves]);

  // ─── Description sheet (outside rotation) ──────────────

  const descriptionSheet = useMemo(() => {
    if (!showDescriptions || containerSize.w === 0 || containerSize.h === 0) return null;
    const activeCourses = courses.filter(
      (c) => c.highlight || c.name === highlightCourseName,
    );
    // Without an active course the sheet normally needs geometry to know
    // which controls to list; `descriptionsAllControls` lists them all
    // from the control overlays instead (no geometry required).
    const allControlsMode = descriptionsAllControls && activeCourses.length === 0;
    if (!courseGeometry && !allControlsMode) return null;
    return renderDescriptionSheet(
      courseGeometry,
      symbolScale,
      containerSize.w,
      containerSize.h,
      activeCourses,
      controls,
      allControlsMode,
      allControlsTitle,
    );
  }, [showDescriptions, courseGeometry, descriptionsAllControls, allControlsTitle, symbolScale, containerSize, courses, highlightCourseName, controls]);

  // ─── Scale bar ─────────────────────────────────────────

  const scaleBar = useMemo(() => {
    if (!viewport || !mapScale || containerSize.w === 0) return null;
    const mpp = metersPerPixel(viewport.centerLat, viewport.zoom);
    const targetPx = 120;
    const targetM = targetPx * mpp;

    const niceSteps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
    let barM = niceSteps[0];
    for (const s of niceSteps) {
      if (s <= targetM * 2) barM = s;
    }
    const barPx = barM / mpp;
    const label = barM >= 1000 ? `${barM / 1000} km` : `${barM} m`;

    return (
      <div style={{ position: "absolute", bottom: 12, left: 12, pointerEvents: "none", zIndex: 10 }}>
        <div style={{ fontSize: 11, color: "#334155", fontWeight: 600, marginBottom: 2 }}>{label}</div>
        <div style={{ width: barPx, height: 4, background: "#334155", borderRadius: 1, opacity: 0.8 }} />
      </div>
    );
  }, [viewport, mapScale, containerSize]);

  // ─── Measure HUD ──────────────────────────────────────

  const measureHud = useMemo(() => {
    if (!measuring || measurePoints.length === 0) return null;
    let total = 0;
    for (let i = 1; i < measurePoints.length; i++) {
      total += mmToMeters(mapMmDist(measurePoints[i - 1], measurePoints[i]));
    }
    if (measureCursor && measurePoints.length > 0) {
      total += mmToMeters(mapMmDist(measurePoints[measurePoints.length - 1], measureCursor));
    }
    return (
      <div style={{
        position: "absolute", top: 8, left: "50%", transform: "translateX(-50%)",
        background: "rgba(255,255,255,0.9)", borderRadius: 6, padding: "4px 12px",
        fontSize: 13, fontWeight: 600, color: "#1e3a8a", boxShadow: "0 1px 4px rgba(0,0,0,0.15)", zIndex: 10,
      }}>
        {formatDist(total)} · {measurePoints.length} pt{measurePoints.length > 1 ? "s" : ""}
      </div>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measuring, measurePoints, measureCursor, mapScale]);

  // ─── Render ───────────────────────────────────────────

  if (!mapBounds) {
    return (
      <div className={`flex items-center justify-center bg-slate-50 rounded-lg border border-slate-200 ${className}`} style={style}>
        <div className="text-center p-4">
          <p className="text-sm text-slate-500">No map uploaded</p>
        </div>
      </div>
    );
  }

  if (!viewport) {
    return (
      <div ref={containerRef} className={`flex items-center justify-center bg-slate-50 rounded-lg border border-slate-200 ${className}`} style={style}>
        <div className="text-center">
          <div className="w-8 h-8 border-3 border-blue-200 border-t-blue-600 rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm text-slate-500">Loading map...</p>
          {tileProgress && tileProgress.rendering && tileProgress.total > 0 && (
            <>
              <div className="w-32 h-1.5 bg-slate-200 rounded-full mt-2 mx-auto">
                <div className="h-full bg-blue-500 rounded-full transition-all"
                  style={{ width: `${Math.round((tileProgress.done / tileProgress.total) * 100)}%` }} />
              </div>
              <p className="text-xs text-slate-400 mt-1">
                Generating tiles... {tileProgress.done}/{tileProgress.total}
              </p>
            </>
          )}
        </div>
      </div>
    );
  }

  // ─── Editor: phantom ring + contextual action menu ────────
  // The phantom lives in the rotated overlay SVG (inner coords); the
  // menu is unrotated HTML anchored via innerToContainer. Both hidden
  // while a drag is in flight.
  const phantomPos =
    editor?.phantom && overlayContent
      ? mapMmToScreen(editor.phantom.x, editor.phantom.y)
      : null;

  let editorMenu: React.ReactNode = null;
  const menuEntries =
    (editor?.contextActions?.length ?? 0) + (editor?.suggestions?.length ?? 0) + (editor?.onDismiss ? 1 : 0);
  if (editor && menuEntries > 0 && overlayContent && !editorDragPos) {
    let inner: Pt | null = null;
    let anchorR = overlayContent.radiusPx;
    if (editor.phantom) {
      inner = phantomPos;
    } else if (editor.selectedControlId) {
      const c = controls.find((k) => k.id === editor.selectedControlId);
      if (c && c.visible !== false) {
        const pend = pendingMoves.get(c.id);
        const mm =
          pend && Math.abs(c.x - pend.from.x) < 1e-9 && Math.abs(c.y - pend.from.y) < 1e-9
            ? pend.to
            : { x: c.x, y: c.y };
        inner = mapMmToScreen(mm.x, mm.y);
        anchorR = overlayContent.radiusPx * 1.45;
      }
    }
    if (inner) {
      const pos = innerToContainer(inner.x, inner.y);
      if (pos.x > -40 && pos.x < containerSize.w + 40 && pos.y > -20 && pos.y < containerSize.h + 20) {
        editorMenu = (
          <div
            data-testid="editor-context-menu"
            className="relative flex flex-col gap-0.5 bg-white/95 backdrop-blur-sm rounded-lg border border-slate-200 shadow-lg p-1"
            style={{
              position: "absolute",
              left: pos.x + anchorR + 10,
              top: pos.y,
              transform: "translateY(-50%)",
              zIndex: 9,
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
          >
            {editor.onDismiss && (
              <button
                type="button"
                data-testid="editor-dismiss"
                onPointerDown={(e) => e.stopPropagation()}
                onTouchStart={(e) => e.stopPropagation()}
                onTouchEnd={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  editor.onDismiss?.();
                }}
                onClick={editor.onDismiss}
                className="absolute right-1 top-1 z-10 p-1 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer"
                title={t("editorDismiss")}
                aria-label={t("editorDismiss")}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
            {editor.contextInfo && (
              <div
                data-testid="editor-context-info"
                className="text-[11px] text-slate-500 pl-2.5 pr-8 pt-1.5 pb-1 whitespace-nowrap border-b border-slate-100"
              >
                {editor.contextInfo}
              </div>
            )}
            {editor.contextBadge && (
              <div
                data-testid="editor-srr-badge"
                title={editor.contextBadge.title}
                className="text-[10px] font-medium text-amber-800 bg-amber-100 rounded pl-2 pr-8 py-0.5 mx-1 mt-0.5 w-fit"
              >
                {editor.contextBadge.label}
              </div>
            )}
            {editor.contextRadioBadge && (
              <div
                data-testid="editor-radio-badge"
                title={editor.contextRadioBadge.title}
                className="text-[10px] font-medium text-sky-800 bg-sky-100 rounded pl-2 pr-8 py-0.5 mx-1 mt-0.5 w-fit"
              >
                {editor.contextRadioBadge.label}
              </div>
            )}
            {editor.suggestions && editor.suggestions.length > 0 && (
              <div
                data-testid="editor-suggestions"
                className="border-b border-slate-100 pb-0.5 mb-0.5"
              >
                {editor.suggestionsHeading && (
                  <div className="text-[11px] text-slate-500 pl-2.5 pr-8 pt-1 pb-0.5 whitespace-nowrap">
                    {editor.suggestionsHeading}
                  </div>
                )}
                {editor.suggestions.map((s) => (
                  <button
                    key={s.id}
                    data-testid={`editor-suggestion-${s.id}`}
                    data-suggestion-label={s.label}
                    onClick={s.onApply}
                    className="w-full flex items-center gap-1.5 text-xs text-left px-2.5 py-1 rounded-md whitespace-nowrap text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer"
                  >
                    {s.symbolSvg && (
                      <svg
                        viewBox="-100 -100 200 200"
                        className="w-5 h-5 shrink-0"
                        dangerouslySetInnerHTML={{ __html: s.symbolSvg }}
                      />
                    )}
                    {s.sideSvg && (
                      <svg
                        viewBox="-100 -100 200 200"
                        className="w-5 h-5 shrink-0"
                        dangerouslySetInnerHTML={{ __html: s.sideSvg }}
                      />
                    )}
                    <span>{s.label}</span>
                  </button>
                ))}
              </div>
            )}
            {editor.contextActions?.map((a) => (
              <button
                key={a.id}
                data-testid={`editor-action-${a.id}`}
                onClick={a.onClick}
                className={`text-xs text-left pl-2.5 pr-8 py-1.5 rounded-md whitespace-nowrap transition-colors cursor-pointer ${
                  a.variant === "danger"
                    ? "text-red-600 hover:bg-red-50"
                    : "text-slate-700 hover:bg-slate-100"
                }`}
              >
                {a.label}
              </button>
            ))}
          </div>
        );
      }
    }
  }

  // Drag warning chip — "moving this affects other courses". Follows
  // the dragged control; pre-formatted text supplied by the page.
  let dragWarning: React.ReactNode = null;
  if (editor?.moveWarnings && editorDragPos) {
    const warn = editor.moveWarnings.get(editorDragPos.id);
    if (warn) {
      const inner = mapMmToScreen(editorDragPos.x, editorDragPos.y);
      if (inner) {
        const pos = innerToContainer(inner.x, inner.y);
        dragWarning = (
          <div
            data-testid="editor-move-warning"
            className="text-[11px] bg-amber-50 border border-amber-300 text-amber-800 rounded-md px-2 py-0.5 shadow-sm whitespace-nowrap"
            style={{
              position: "absolute",
              left: pos.x,
              top: pos.y + 18,
              transform: "translateX(-50%)",
              zIndex: 9,
              pointerEvents: "none",
            }}
          >
            {warn}
          </div>
        );
      }
    }
  }

  const containerTouchAction =
    measuring || allowOneFingerMapPan ? "none" : "pan-y";

  return (
    <div
      ref={containerRef}
      data-testid="map-viewer"
      data-center-lat={viewport?.centerLat}
      data-center-lng={viewport?.centerLng}
      data-zoom={viewport?.zoom}
      className={`relative overflow-hidden select-none bg-white ${hideControls ? "" : "rounded-lg border border-slate-200"} ${className}`}
      style={{
        cursor: hideControls ? "default"
          : measuring ? "crosshair"
          : isPanningRef.current ? "grabbing" : "grab",
        touchAction: containerTouchAction,
        ...style,
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      {showTwoFingerHint && (
        <div
          data-testid="map-two-finger-hint"
          className="pointer-events-none absolute inset-x-0 top-1/2 z-20 flex justify-center -translate-y-1/2 px-4"
        >
          <div className="rounded-lg bg-black/70 px-4 py-2 text-sm text-white text-center shadow-lg">
            {t("twoFingerMapHint")}
          </div>
        </div>
      )}
      {/* Rotated map layer (tiles + overlay) — corrects map north offset */}
      <div style={{
        position: "absolute",
        inset: 0,
        transform: rotDeg !== 0 ? `rotate(${rotDeg}deg)` : undefined,
        transformOrigin: "center center",
        ...(rotDeg !== 0 ? { width: renderW, height: renderH, left: (containerSize.w - renderW) / 2, top: (containerSize.h - renderH) / 2 } : {}),
      }}>
        {/* Base map tiles */}
        <TileLayer
          viewport={viewport}
          containerWidth={renderW}
          containerHeight={renderH}
          tileUrlBase={tileUrlBase}
          tileVersion={mapVersion}
        />

        {/* Overlay SVG */}
        <svg
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 2 }}
          viewBox={`0 0 ${renderW} ${renderH}`}
        >
          <g style={{ pointerEvents: "auto" }}>
            {overlayContent?.nodes}
            {locateMode !== "off" && geo.position && viewport && (() => {
              const { px, py } = latlngToPixel(
                geo.position.lat,
                geo.position.lng,
                viewport,
                renderW,
                renderH,
              );
              const mpp = metersPerPixel(geo.position.lat, viewport.zoom);
              const radius = accuracyRadiusPx(geo.position.accuracy, mpp);
              return (
                <g data-testid="my-location-marker" style={{ pointerEvents: "none" }}>
                  {radius > 2 && (
                    <circle
                      cx={px}
                      cy={py}
                      r={Math.min(radius, Math.max(renderW, renderH))}
                      fill="rgba(66, 133, 244, 0.15)"
                      stroke="rgba(66, 133, 244, 0.45)"
                      strokeWidth={1}
                    />
                  )}
                  <circle cx={px} cy={py} r={14} fill="rgba(66, 133, 244, 0.25)" />
                  <circle
                    cx={px}
                    cy={py}
                    r={7}
                    fill="#4285F4"
                    stroke="#ffffff"
                    strokeWidth={2.5}
                  />
                </g>
              );
            })()}
            {/* Editor hit targets — topmost, so grabbing a control or a
                leg always wins over decorative overlay shapes. Handlers
                live here (not in the memo) because they write refs. */}
            {editor && overlayContent && overlayContent.legHits.map((h) => (
              <path key={h.key} d={h.d} stroke="transparent" strokeWidth={12} fill="none"
                style={{ pointerEvents: "stroke", cursor: "copy" }}
                data-testid="editor-leg-hit"
                data-course-name={h.course}
                data-leg-index={h.index}
                onMouseDown={(e) => legHitMouseDown(h.course, h.index, e)}
                onMouseUp={(e) => legHitMouseUp(h.course, h.index, e)}
                onTouchStart={(e) => legHitTouchStart(h.course, h.index, e)}
                onTouchEnd={(e) => legHitTouchEnd(h.course, h.index, e)} />
            ))}
            {editor && overlayContent && overlayContent.controlHits.map((h) => (
              <circle key={`edit-hit-${h.id}`} cx={h.px} cy={h.py} r={h.r}
                fill="transparent" stroke="none"
                style={{ pointerEvents: "all", cursor: "move", touchAction: "none" }}
                data-testid="editor-control-hit"
                data-control-id={h.id}
                data-control-code={h.code}
                onMouseDown={(ev) => beginControlDragMouse(h.id, h.mmX, h.mmY, ev)}
                onTouchStart={(ev) => beginControlDragTouch(h.id, h.mmX, h.mmY, ev)}
                onTouchMove={handleControlTouchMove}
                onTouchEnd={handleControlTouchEnd} />
            ))}
            {/* Phantom selection — where the user clicked empty map / a leg */}
            {overlayContent && phantomPos && !editorDragPos && (
              <circle cx={phantomPos.x} cy={phantomPos.y}
                r={overlayContent.radiusPx}
                stroke="#2563eb" strokeWidth={Math.max(1, overlayContent.strokePx * 0.8)}
                fill="none"
                strokeDasharray={`${Math.max(2, overlayContent.strokePx * 2)} ${Math.max(2, overlayContent.strokePx * 2)}`}
                opacity={0.9} style={{ pointerEvents: "none" }}
                data-testid="editor-phantom" />
            )}
          </g>
        </svg>
      </div>

      {/* Editor contextual actions — unrotated HTML, anchored at the
          selection/phantom */}
      {editorMenu}
      {dragWarning}

      {/* Description sheet (not rotated) */}
      {descriptionSheet && (
        <svg data-testid="description-sheet"
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 3 }}
          viewBox={`0 0 ${containerSize.w} ${containerSize.h}`}>
          {descriptionSheet}
        </svg>
      )}

      {/* Scale bar */}
      {scaleBar}

      {/* Measure HUD */}
      {measureHud}

      {locateErrorFlash && (
        <div
          data-testid="locate-error"
          className="absolute bottom-14 right-12 z-20 max-w-[12rem] rounded-md bg-slate-900/90 px-2.5 py-1.5 text-xs text-white shadow-lg"
        >
          {locateErrorFlash}
        </div>
      )}

      {/* Control buttons */}
      {!hideControls && (
        <div className="touch-manipulation" style={{
          position: "absolute", bottom: 12, right: 12, display: "flex", flexDirection: "column", gap: 4, zIndex: 10,
        }}>
          <button
            onClick={() => {
              breakLocateFollow();
              setViewport((prev) => prev ? { ...prev, zoom: Math.min(22, prev.zoom + 0.5) } : prev);
            }}
            className="w-8 h-8 bg-white rounded shadow hover:bg-slate-50 flex items-center justify-center text-slate-600 font-bold text-lg"
            title="Zoom in"
          >+</button>
          <button
            onClick={() => {
              breakLocateFollow();
              setViewport((prev) => prev ? { ...prev, zoom: Math.max(1, prev.zoom - 0.5) } : prev);
            }}
            className="w-8 h-8 bg-white rounded shadow hover:bg-slate-50 flex items-center justify-center text-slate-600 font-bold text-lg"
            title="Zoom out"
          >−</button>
          <button
            onClick={() => {
              if (mapBounds) setViewport(fitBounds(mapBounds, containerSize.w, containerSize.h, 0.05));
            }}
            className="w-8 h-8 bg-white rounded shadow hover:bg-slate-50 flex items-center justify-center"
            title="Reset view"
          >
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.8} className="w-4 h-4 text-slate-600">
              <path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4" strokeLinecap="round" strokeLinejoin="round" />
              <rect x="7" y="7" width="6" height="6" rx="0.5" fill="currentColor" opacity="0.3" />
            </svg>
          </button>
          <button
            onClick={() => {
              setMeasuring((prev) => {
                if (prev) { setMeasurePoints([]); setMeasureCursor(null); }
                return !prev;
              });
            }}
            className={`w-8 h-8 rounded shadow flex items-center justify-center ${measuring ? "bg-blue-500 text-white" : "bg-white hover:bg-slate-50 text-slate-600"}`}
            title="Measure distance"
          >
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-4 h-4">
              <path d="M3 17L17 3" strokeLinecap="round" />
              <path d="M6 14l1.5-1.5M9 11l1.5-1.5M12 8l1.5-1.5" strokeLinecap="round" />
            </svg>
          </button>
          <button
            type="button"
            data-testid="locate-button"
            onClick={handleLocateClick}
            className={`w-8 h-8 rounded shadow flex items-center justify-center ${
              locateMode === "following"
                ? "bg-blue-500 text-white"
                : locateMode === "located"
                  ? "bg-blue-100 text-blue-600"
                  : "bg-white hover:bg-slate-50 text-slate-600"
            }`}
            title={t("locateMe")}
            aria-label={t("locateMe")}
            aria-pressed={locateMode !== "off"}
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path fillRule="evenodd" d="M10 3.5a.75.75 0 01.75.75v1.042a5.252 5.252 0 014.0 4.0H16.5a.75.75 0 010 1.5h-1.042a5.252 5.252 0 01-4.0 4.0V16.5a.75.75 0 01-1.5 0v-1.042a5.252 5.252 0 01-4.0-4.0H3.5a.75.75 0 010-1.5h1.042a5.252 5.252 0 014.0-4.0V4.25A.75.75 0 0110 3.5zm0 3.25a3.25 3.25 0 100 6.5 3.25 3.25 0 000-6.5zM10 9a1 1 0 100 2 1 1 0 000-2z" clipRule="evenodd" />
            </svg>
          </button>
          {onToggleFullscreen && (
            <button
              onClick={onToggleFullscreen}
              className="w-8 h-8 bg-white rounded shadow hover:bg-slate-50 flex items-center justify-center text-slate-600"
              title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
            >
              <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                {isFullscreen ? (
                  <path fillRule="evenodd" d="M3.28 2.22a.75.75 0 00-1.06 1.06L5.44 6.5H2.75a.75.75 0 000 1.5h4.5a.75.75 0 00.75-.75v-4.5a.75.75 0 00-1.5 0v2.69L3.28 2.22zm13.44 0a.75.75 0 10-1.06 1.06L18.88 6.5h-2.69a.75.75 0 000 1.5h4.5a.75.75 0 00.75-.75v-4.5a.75.75 0 00-1.5 0v2.69L16.72 2.22zM3.28 17.78a.75.75 0 001.06 1.06L7.56 15.5h-2.69a.75.75 0 010-1.5h4.5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-2.69L3.28 17.78zm13.44 0a.75.75 0 11-1.06 1.06L12.44 15.5h2.69a.75.75 0 010-1.5h-4.5a.75.75 0 01-.75.75v4.5a.75.75 0 011.5 0v-2.69l3.22 3.22z" clipRule="evenodd" />
                ) : (
                  <path fillRule="evenodd" d="M4.25 2A2.25 2.25 0 002 4.25v2a.75.75 0 001.5 0v-2a.75.75 0 01.75-.75h2a.75.75 0 000-1.5h-2zm9.5 0a.75.75 0 000 1.5h2a.75.75 0 01.75.75v2a.75.75 0 001.5 0v-2A2.25 2.25 0 0015.75 2h-2zM3.5 13.75a.75.75 0 00-1.5 0v2A2.25 2.25 0 004.25 18h2a.75.75 0 000-1.5h-2a.75.75 0 01-.75-.75v-2zm15 0a.75.75 0 00-1.5 0v2a.75.75 0 01-.75.75h-2a.75.75 0 000 1.5h2A2.25 2.25 0 0018.5 15.75v-2z" clipRule="evenodd" />
                )}
              </svg>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Subtract leg gaps from a screen-space polyline ────────

/**
 * Split a leg polyline into the kept sub-polylines outside the given
 * gaps. Gaps are fractions 0..1 of the leg's total length (the parameter
 * space the server computed them in); fractions survive the map
 * projection because a leg is short enough to be locally linear.
 */
function subtractLegGaps(
  pts: Pt[],
  gaps: { from: number; to: number }[],
): Pt[][] {
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  const total = cum[cum.length - 1];
  if (total === 0) return [pts];

  const sorted = gaps
    .map((g): [number, number] => [Math.max(0, g.from), Math.min(1, g.to)])
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);

  const kept: [number, number][] = [];
  let cursor = 0;
  for (const [a, b] of sorted) {
    if (a > cursor) kept.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (cursor < 1) kept.push([cursor, 1]);

  const pointAt = (t: number): Pt => {
    const d = t * total;
    let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i++;
    const segLen = cum[i] - cum[i - 1] || 1;
    const f = (d - cum[i - 1]) / segLen;
    return {
      x: pts[i - 1].x + f * (pts[i].x - pts[i - 1].x),
      y: pts[i - 1].y + f * (pts[i].y - pts[i - 1].y),
    };
  };

  return kept.map(([a, b]) => {
    const out: Pt[] = [pointAt(a)];
    for (let i = 0; i < pts.length; i++) {
      const t = cum[i] / total;
      if (t > a && t < b) out.push(pts[i]);
    }
    out.push(pointAt(b));
    return out;
  });
}

// ─── Draw broken circle with slit gaps ─────────────────────

function drawBrokenCircle(cx: number, cy: number, r: number, gaps: SlitGap[]): string {
  const normalized: { start: number; end: number }[] = [];
  for (const g of gaps) {
    const s = ((g.start % 360) + 360) % 360;
    const e = ((g.end % 360) + 360) % 360;
    if (Math.abs(s - e) < 0.5) continue;
    normalized.push({ start: s, end: e });
  }

  if (normalized.length === 0) {
    return `M${cx + r},${cy} A${r},${r} 0 1 1 ${cx - r},${cy} A${r},${r} 0 1 1 ${cx + r},${cy}`;
  }

  const gapAngles: [number, number][] = [];
  for (const g of normalized) {
    if (g.start < g.end) {
      gapAngles.push([g.start, g.end]);
    } else {
      gapAngles.push([g.start, 360]);
      gapAngles.push([0, g.end]);
    }
  }
  gapAngles.sort((a, b) => a[0] - b[0]);

  const merged: [number, number][] = [];
  for (const g of gapAngles) {
    if (merged.length > 0 && g[0] <= merged[merged.length - 1][1]) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], g[1]);
    } else {
      merged.push([g[0], g[1]]);
    }
  }

  const arcs: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const [gs, ge] of merged) {
    if (gs > cursor) arcs.push({ start: cursor, end: gs });
    cursor = ge;
  }
  if (cursor < 360) arcs.push({ start: cursor, end: 360 });

  let d = "";
  for (const arc of arcs) {
    const sweep = arc.end - arc.start;
    if (sweep < 0.5) continue;
    const startRad = ((90 - arc.start) * Math.PI) / 180;
    const endRad = ((90 - arc.end) * Math.PI) / 180;
    const x1 = cx + r * Math.cos(startRad);
    const y1 = cy - r * Math.sin(startRad);
    const x2 = cx + r * Math.cos(endRad);
    const y2 = cy - r * Math.sin(endRad);
    const largeArc = sweep > 180 ? 1 : 0;
    d += `M${x1.toFixed(1)},${y1.toFixed(1)} A${r},${r} 0 ${largeArc} 1 ${x2.toFixed(1)},${y2.toFixed(1)} `;
  }

  return d;
}

// ─── Description sheet renderer ────────────────────────────

function renderDescriptionSheet(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped GeoJSON JSONB straight from the API; traversed dynamically
  courseGeometry: any,
  symbolScale: number,
  cw: number,
  ch: number,
  /** The highlighted courses. 1 → sequence card; >1 → code-sorted union. */
  activeCourses?: Array<Pick<CourseOverlay, "name" | "controls">>,
  /** All control overlays — used to resolve id → code/type when geometry is sparse. */
  controlOverlays?: ControlOverlay[],
  /**
   * List every positioned control from the overlays instead of a course
   * card. Set by the caller when no course is active; works without any
   * course geometry.
   */
  allControlsMode = false,
  /** Localized title for the all-controls listing. */
  allControlsTitle?: string,
): React.ReactNode | null {
  if (!courseGeometry?.features && !allControlsMode) return null;

  const features = courseGeometry?.features || [];

  // Build a code-keyed map from the geometry. Start/finish features have
  // their own symbolType so they can't accidentally appear here, and we
  // de-dup by code (the same control may show up in multiple courses).
  const featureByCode = new Map<string, { code: string; description?: unknown }>();
  for (const f of features) {
    if (f?.properties?.symbolType === "control" && f.properties?.code) {
      const code = String(f.properties.code);
      if (!featureByCode.has(code)) {
        featureByCode.set(code, {
          code,
          description: f.properties.description,
        });
      }
    }
  }
  // Descriptions live on the control rows now (`controls.description`),
  // exposed through the overlays. They take precedence over any legacy
  // copy embedded in geometry feature properties.
  for (const o of controlOverlays ?? []) {
    if (!o.description) continue;
    const existing = featureByCode.get(String(o.code));
    if (existing) existing.description = o.description;
  }

  /** Resolve one course-control id to a row (null for start/finish). */
  const toRow = (cid: string): { code: string; description?: unknown } | null => {
    // Look up overlay first: it tells us the type so we can skip start/finish.
    const overlay = controlOverlays?.find((o) => o.id === cid);
    if (overlay && overlay.type !== "Control") return null;
    // The id used by the course is normally the punch code (OCD parser
    // sets `id: code`). For IOF-parsed courses the id may differ, so
    // also fall back to the overlay's code.
    const lookupKey = String(overlay?.code ?? cid);
    return {
      code: lookupKey,
      description:
        overlay?.description ?? featureByCode.get(lookupKey)?.description,
    };
  };

  const byCodeAsc = (a: { code: string }, b: { code: string }) =>
    a.code.localeCompare(b.code, undefined, { numeric: true });

  // Build the rows. One course → its ordered control list with sequence
  // numbers (a proper course card). Several courses → the code-sorted
  // UNION of all their controls, without sequence numbers (there is no
  // shared sequence, and the map keeps showing codes). No course → every
  // positioned control (`allControlsMode`) or all geometry codes.
  type Row = { code: string; description?: unknown };
  const rows: Row[] = [];
  const single = activeCourses?.length === 1 ? activeCourses[0] : null;
  const withSequence = single !== null;
  let title = "";
  if (single) {
    title = single.name;
    for (const cid of single.controls) {
      const row = toRow(cid);
      if (row) rows.push(row);
    }
  } else if (activeCourses && activeCourses.length > 1) {
    title = activeCourses.map((c) => c.name).join(" · ");
    const byCode = new Map<string, Row>();
    for (const course of activeCourses) {
      for (const cid of course.controls) {
        const row = toRow(cid);
        if (row && !byCode.has(row.code)) byCode.set(row.code, row);
      }
    }
    rows.push(...[...byCode.values()].sort(byCodeAsc));
  } else if (allControlsMode) {
    title = allControlsTitle ?? "";
    const byCode = new Map<string, Row>();
    for (const o of controlOverlays ?? []) {
      if (o.type !== "Control" || o.visible === false) continue;
      const code = String(o.code);
      if (byCode.has(code)) continue;
      byCode.set(code, {
        code,
        description: o.description ?? featureByCode.get(code)?.description,
      });
    }
    rows.push(...[...byCode.values()].sort(byCodeAsc));
  } else {
    for (const f of featureByCode.values()) {
      rows.push(f);
    }
  }

  if (rows.length === 0) return null;

  // IOF standard: 8 columns (A=seq, B=code, C-G=description symbols, H=dimensions)
  const cellSize = Math.max(20, Math.min(36, 7 * symbolScale));
  const cols = 8;
  const headerRows = 1; // course name header
  const sheetW = cols * cellSize;
  const sheetY = 12;

  // Long lists (all controls of a big event) don't fit one column, so the
  // rows flow into side-by-side blocks — at most two, so the sheet never
  // eats the whole map. Anything past that is dropped with a "+N" marker:
  // the sheet is a reading aid, not a print layout.
  const rowsPerBlock = Math.max(1, Math.floor((ch - 2 * sheetY) / cellSize) - headerRows);
  const maxBlocks = Math.max(1, Math.min(2, Math.floor((cw - 24) / sheetW)));
  const blocks: Row[][] = [];
  for (let i = 0; i < rows.length && blocks.length < maxBlocks; i += rowsPerBlock) {
    blocks.push(rows.slice(i, i + rowsPerBlock));
  }
  const hidden = rows.length - blocks.reduce((n, b) => n + b.length, 0);
  // Right-aligned as a whole, so a single block keeps its old position.
  const originX = cw - blocks.length * sheetW - 12;

  const elements: React.ReactNode[] = [];

  for (let bi = 0; bi < blocks.length; bi++) {
    const blockRows = blocks[bi];
    const sheetX = originX + bi * sheetW;
    const totalRows = headerRows + blockRows.length;
    const sheetH = totalRows * cellSize;

    // Background with shadow effect
    elements.push(
      <rect key={`desc-shadow-${bi}`} x={sheetX + 2} y={sheetY + 2} width={sheetW} height={sheetH}
        fill="rgba(0,0,0,0.1)" rx={2} />
    );
    elements.push(
      <rect key={`desc-bg-${bi}`} x={sheetX} y={sheetY} width={sheetW} height={sheetH}
        fill="white" stroke="#94a3b8" strokeWidth={1} rx={2} />
    );

    // Header row: course name(s). Long multi-course titles shrink to fit.
    elements.push(
      <rect key={`desc-header-${bi}`} x={sheetX} y={sheetY} width={sheetW} height={cellSize}
        fill="#e2e8f0" stroke="#94a3b8" strokeWidth={0.5} rx={2} />
    );
    if (title && bi === 0) {
      const titleFs = Math.min(cellSize * 0.5, (sheetW - 8) / (title.length * 0.62));
      elements.push(
        <text key="desc-title" x={sheetX + sheetW / 2} y={sheetY + cellSize * 0.5}
          textAnchor="middle" dominantBaseline="central"
          fontSize={titleFs} fill="#1e293b" fontWeight="bold" data-testid="desc-title">
          {title}
        </text>
      );
    }

    // Grid lines
    for (let r = 0; r <= totalRows; r++) {
      elements.push(
        <line key={`desc-hr-${bi}-${r}`} x1={sheetX} y1={sheetY + r * cellSize}
          x2={sheetX + sheetW} y2={sheetY + r * cellSize} stroke="#cbd5e1" strokeWidth={0.5} />
      );
    }
    for (let c = 0; c <= cols; c++) {
      elements.push(
        <line key={`desc-vr-${bi}-${c}`} x1={sheetX + c * cellSize} y1={sheetY + cellSize}
          x2={sheetX + c * cellSize} y2={sheetY + sheetH} stroke="#cbd5e1" strokeWidth={0.5} />
      );
    }

    renderDescriptionRows(elements, blockRows, bi * rowsPerBlock, withSequence, {
      sheetX, sheetY, sheetW, cellSize, headerRows,
    });

    // Dropped rows are called out in the last block's header.
    if (hidden > 0 && bi === blocks.length - 1) {
      elements.push(
        <text key="desc-hidden" x={sheetX + sheetW - 4} y={sheetY + cellSize * 0.5}
          textAnchor="end" dominantBaseline="central"
          fontSize={cellSize * 0.42} fill="#64748b" data-testid="desc-hidden-count">
          {`+${hidden}`}
        </text>
      );
    }
  }

  return <g key="desc-sheet">{elements}</g>;
}

/** One block of description rows (code + IOF symbol cells). */
function renderDescriptionRows(
  elements: React.ReactNode[],
  rows: Array<{ code: string; description?: unknown }>,
  /** Index of the first row within the whole sheet (column A numbering). */
  rowOffset: number,
  withSequence: boolean,
  geom: { sheetX: number; sheetY: number; sheetW: number; cellSize: number; headerRows: number },
): void {
  const { sheetX, sheetY, sheetW, cellSize, headerRows } = geom;

  // Control rows
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const code = row.code;
    const desc = row.description;
    const n = rowOffset + i;
    const ry = sheetY + (i + headerRows) * cellSize;
    const fs = cellSize * 0.45;

    // Alternate row shading for readability — drawn first so the row
    // content lands on top of it.
    if (n % 2 === 1) {
      elements.push(
        <rect key={`desc-row-bg-${n}`} x={sheetX + 0.5} y={ry + 0.5}
          width={sheetW - 1} height={cellSize - 1} fill="#f8fafc" />
      );
    }

    // Column A: sequence number — only meaningful for a single course.
    // The multi-course union card is code-keyed, so A stays empty.
    if (withSequence) {
      elements.push(
        <text key={`desc-seq-${n}`} x={sheetX + cellSize * 0.5} y={ry + cellSize * 0.5}
          textAnchor="middle" dominantBaseline="central" fontSize={fs} fill="#475569">
          {n + 1}
        </text>
      );
    }
    // Column B: control code
    elements.push(
      <text key={`desc-code-${n}`} x={sheetX + cellSize * 1.5} y={ry + cellSize * 0.5}
        textAnchor="middle" dominantBaseline="central" fontSize={fs} fill="#1e293b" fontWeight="bold"
        data-testid="desc-row-code" data-code={code}>
        {code}
      </text>
    );

    // Columns C-G: IOF description symbols (empty if no description)
    const symbols = desc ? getDescriptionSymbols(desc, "#c026d3") : ({} as ReturnType<typeof getDescriptionSymbols>);
    const colKeys = ["colC", "colD", "colE", "colF", "colG"] as const;
    for (let ci = 0; ci < colKeys.length; ci++) {
      const content = symbols[colKeys[ci]];
      if (content) {
        const sx = sheetX + (ci + 2) * cellSize;
        if (colKeys[ci] === "colE") {
          // colE is dimensions text (e.g. "3m"), render as SVG text
          elements.push(
            <text key={`desc-sym-${n}-${ci}`} x={sx + cellSize * 0.5} y={ry + cellSize * 0.5}
              textAnchor="middle" dominantBaseline="central" fontSize={fs * 0.85} fill="#475569">
              {content}
            </text>
          );
        } else {
          // IOF symbol SVG — render as nested <svg> (foreignObject + HTML can't render raw SVG paths)
          elements.push(
            <svg key={`desc-sym-${n}-${ci}`} x={sx + 1} y={ry + 1}
              width={cellSize - 2} height={cellSize - 2}
              viewBox="-100 -100 200 200"
              dangerouslySetInnerHTML={{ __html: content }} />
          );
        }
      }
    }
  }
}
