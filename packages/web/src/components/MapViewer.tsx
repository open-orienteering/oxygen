import { useState, useRef, useEffect, useCallback, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import {
  CONTROL_NUMBER_CAP_HEIGHT_RATIO,
  type ControlDescription,
  defaultMapAppearance,
} from "@oxygen/shared";
import { descriptionCells, IOF_SYMBOLS } from "../iof-symbols";
import {
  buildDescriptionSheet,
  DESCRIPTION_THICK_COLUMNS,
  hasThickRuleBelow,
  type DescriptionSheetRow,
} from "@oxygen/shared";
import { MapLayerMessage, VectorMapLayer, type VectorLoupe } from "./VectorMapLayer";
import {
  type MapViewport,
  type ViewportContext,
  centreOnGeo,
  centreShiftPx,
  fitMm,
  geoToInner,
  geoToMm,
  glView,
  innerToGeo,
  innerToMm,
  mercatorEquivalentZoom,
  metresPerPx,
  mmToInner,
  panBy,
  pxPerMapMm,
  viewportRotationDeg,
  zoomAt,
} from "../lib/map-viewport";
import { useMapDocument } from "../lib/map-document-cache";
import { boundsMm, paperFrameOf, type MapBudget } from "../lib/vector-map";
import { rotatedBoundingBox } from "../lib/map-rotation";
import {
  shouldSuppressSyntheticMouse,
  isMeasureTap,
  dist2d,
} from "../lib/measure-tap";
import {
  IconZoomIn,
  IconZoomOut,
  IconFitView,
  IconRuler,
  IconLocate,
  IconCompass,
  IconFullscreenEnter,
  IconFullscreenExit,
  IconUndo,
} from "./map-icons";
import { useGeolocationWatch, type GeolocationFix } from "../hooks/useGeolocationWatch";
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
import { useMediaQuery } from "../hooks/useMediaQuery";
import { courseLayerRequest, PROVISIONAL_SITE_ID, type LayoutRequest, type ProvisionalVisit } from "../lib/course-layer-request";
import { dragLegShapes } from "../lib/editor/leg-length";
import { outlinePoints, vertexRule } from "../lib/editor/geometry-edit";
import type { CourseInfo } from "../map-gl/engine";
import { editorHitAt, HIT_TOLERANCE_PX, uiLegsOf, type EditorTarget } from "../lib/editor/hit";
import { showSelectionRing } from "../lib/editor/state";
import { COARSE_HIT_TOLERANCE_PX, IDLE as SITE_TOUCH_IDLE, LONG_PRESS_MS, LOUPE_DIAMETER_PX, LOUPE_SCALE, liftedPoint, loupePlacement, siteTouch, type SiteTouch, type SiteTouchEvent } from "../lib/editor/touch";

/** Persisted compass state: "1"/absent = rotation locked (north up). */
const ROTATION_LOCK_STORAGE_KEY = "oxygen.map.rotationLock";

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
  /** IOF control description from the control row (`controls.description`), for the description sheet. */
  description?: ControlDescription | null;
  /** `controls.circle_gaps`: authored circle cuts for the course layer (course-layer.md §6.4). */
  circleGaps?: { start: number; end: number }[];
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
  /** Course length / climb for the description-sheet header row 3. */
  lengthM?: number;
  climbM?: number;
  /** Visit-order mode — free-order courses draw no legs and use code labels. */
  orderMode?: import("@oxygen/shared").CourseOrderMode;
  /** Special / finish instructions for the description sheet. */
  descriptionInstructions?: import("@oxygen/shared").CourseDescriptionInstructions | null;
  /**
   * Per-control number offsets (map mm from the control centre), keyed
   * by overlay control id. Used when this course is the single
   * highlighted course — ordered (sequence numbers) and free-order
   * (punch codes) alike.
   */
  labelOffsets?: Record<string, { dx: number; dy: number }>;
  /** The stored structure's legs whole (style, bends, gaps, corridor), keyed `"<fromId>><toId>"` (course-layer.md §5, §10). */
  legs?: Record<string, import("@oxygen/shared").course.CourseLegProps>;
  /** Ids of the controls whose number every visit hides. */
  hiddenNumbers?: number[];
}

/**
 * Course-editor hooks. When set, the viewer grows editing gestures on top
 * of the normal pan/zoom behaviour. The editor is tool-less — every click
 * resolves to a selection and the page supplies contextual actions:
 *
 * - *Empty-map click* fires `onMapClick` with the position in map mm
 *   (paper millimetres, the `xpos`/`ypos` coordinate space of
 *   `controls`). The page typically anchors a `phantom` there.
 * Targets are resolved by the shared hit-test over the GL course layer's
 * symbolised shapes (docs/course-editor.md §5); a map whose stack the
 * layer cannot take has no targets.
 *
 * - *Drag-to-move*: mouse-down on a control symbol starts a local drag
 *   (rendered without network round-trips); mouse-up fires `onMoveEnd`
 *   once. The viewer keeps rendering the dragged position until the
 *   `controls` prop catches up, so no snap-back while the mutation and
 *   refetch are in flight. Touch and mouse share the same drag path.
 * - *Select*: clicking a control fires `onSelect(id)` (replacing
 *   `onControlClick`). The control matching `selectedControlId` gets a
 *   selection ring.
 * - *Leg click*: a click on a drawn leg of a highlighted course fires
 *   `onLegClick` with the course name, the 0-based leg index and the
 *   clicked point.
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
  /** Greyed out and inert — e.g. while an earlier edit is still saving. */
  disabled?: boolean;
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
  /** Drop of a dragged control-number; offset is map mm from the control centre. */
  onLabelMoveEnd?: (id: string, offset: { dx: number; dy: number }) => void;
  onSelect?: (id: string | null) => void;
  onLegClick?: (courseName: string, legIndex: number, pt: { x: number; y: number }) => void;
  /** Touch-friendly dismiss (mirrors Escape cascade on the owning page). */
  onDismiss?: () => void;
  /**
   * `bar`: the contextual actions as a horizontal action bar centred under
   * the selection (`editor-action-bar`, docs/course-editor.md §2) instead
   * of the popover menu beside it; same entries and `editor-action-<id>`s.
   * `host`: the page docks them itself (the phone's bottom sheet, §10) and the viewer draws none.
   */
  actionLayout?: "menu" | "bar" | "host";
  /**
   * The active editor tool (docs/course-editor.md §6): it sees the pointer
   * before the viewer's own gestures and draws UI-layer shapes.
   */
  tool?: EditorToolBinding | null;
  /** Snap a dragged control's centre (§6.2); returns the point unchanged when nothing is near. */
  snap?: ((pt: { x: number; y: number }) => { x: number; y: number }) | null;
  /**
   * Course objects the page is editing, drawn instead of the stored ones
   * with the same id (and added when new) — a vertex drag, a region being
   * drawn (§7). `draftFast`: a filter region is being dragged, so the
   * layer uses the fast predicate (map-rendering.md §4.11).
   */
  draftObjects?: readonly import("@oxygen/shared").course.CourseObject[] | null;
  draftFast?: boolean;
  /** The layer's derivation and course symbol sizes, on every course reply: the ghost's true size, the gap tool's effective gaps. */
  onCourseInfo?: ((info: Pick<CourseInfo, "derivation" | "metrics"> | null) => void) | null;
  /**
   * The armed placement tool's visit (§6.1): spliced into the highlighted
   * course's request so the layer draws the pending legs; the hit-test then
   * reports only real sites.
   */
  provisional?: ProvisionalVisit | null;
  /**
   * A view request: fit these controls, centre on a point, or fit `bounds` upright (paper mm; Layout
   * mode's `F`, the bearing reset so the page stands upright); acted on when `key` changes.
   * `offsetPx` puts the centred point that far from the view centre on screen (Field mode's bottom
   * sheet: the selection mid-way in the band above it, docs/course-editor.md §10).
   */
  viewRequest?: {
    key: number;
    fit?: readonly string[];
    centre?: { x: number; y: number };
    offsetPx?: { x: number; y: number };
    bounds?: { minX: number; minY: number; maxX: number; maxY: number };
  } | null;
  /** Layout mode's sheet (docs/course-layout.md §1): the course layer draws as the sheet prints, the page part over it. */
  layout?: LayoutRequest | null;
  /**
   * Field mode's GPS fix (docs/course-editor.md §9): the page owns the watch; the viewer draws it
   * with its accuracy ring as `my-location-marker`, through `mapGeo` like its own locate button.
   */
  fix?: GeolocationFix | null;
  /** Screen px at the bottom the page covers (the phone's bottom sheet): the touch Place / Done sit above it. */
  bottomInsetPx?: number;
  /** The page fills the screen (the phone editor, §10): nothing to scroll, so one finger pans as in fullscreen. */
  fullBleed?: boolean;
  /** Check markers (docs/course-editor.md §8): UI-layer shapes, never hit targets. */
  markers?: readonly ToolShape[];
}

/** What a tool gets for a pointer event. */
export interface ToolPointer {
  /** Paper mm. */
  pt: { x: number; y: number };
  /** The shared hit-test's target under the pointer (`editorHitAt`), null for empty map. */
  target: EditorTarget | null;
  shift: boolean;
  /** Alt / Option held (mouse; touch never): the geometry gestures of §7 "Editing geometry". */
  alt?: boolean;
  /** Paper mm per CSS px at the current zoom: for handle tolerances. */
  mmPerPx: number;
}

/** A UI-layer shape a tool draws, paper mm (the viewer projects it). */
export type ToolShape =
  | { kind: "circle"; x: number; y: number; rMm: number; dashed?: boolean; color?: string; fill?: string; testId?: string; data?: Record<string, string> }
  | { kind: "line"; points: readonly { x: number; y: number }[]; closed?: boolean; dashed?: boolean; color?: string; fill?: string; widthPx?: number; testId?: string; data?: Record<string, string> }
  /** A screen-size square handle. */
  | { kind: "handle"; x: number; y: number; active?: boolean; testId?: string; data?: Record<string, string> }
  /** A screen-size Bézier handle grip at `x`, `y` on a thin line from its vertex `from`. */
  | { kind: "grip"; x: number; y: number; from: { x: number; y: number }; testId?: string; data?: Record<string, string> }
  | { kind: "text"; x: number; y: number; text: string; dxPx?: number; dyPx?: number; color?: string; testId?: string }
  /** A raster on the UI layer (Layout mode's page images): its top-left, top-right and bottom-left corners, paper mm. */
  | { kind: "image"; topLeft: { x: number; y: number }; topRight: { x: number; y: number }; bottomLeft: { x: number; y: number }; href: string; testId?: string; data?: Record<string, string> };

/**
 * An editor tool's hooks into the viewer (docs/course-editor.md §6). The
 * viewer offers every pointer-down to `onPointerDown` first: `true` takes
 * the gesture (`onPointerDrag` … `onPointerUp`, null when cancelled), so
 * the map neither pans nor arms its own targets. An `exclusive` tool also
 * keeps the viewer's targets off — a drag pans, a click goes to `onClick`
 * — which is the armed creation tools' "drag pans, click places".
 */
export interface EditorToolBinding {
  exclusive?: boolean;
  cursor?: string;
  shapes?: readonly ToolShape[];
  onPointerDown?: (p: ToolPointer) => boolean;
  /** `mods`: the keys held now (Shift constrains, Alt breaks a handle pair, §7). */
  onPointerDrag?: (pt: { x: number; y: number }, mods?: { shift: boolean; alt: boolean }) => void;
  onPointerUp?: (pt: { x: number; y: number } | null) => void;
  /** A click without movement (exclusive tools; a tap on touch). */
  onClick?: (p: ToolPointer) => void;
  onDoubleClick?: (p: ToolPointer) => void;
  /** Hover without a button (mouse); null when the pointer leaves the map. */
  onHover?: (p: ToolPointer | null) => void;
  onContextMenu?: (p: ToolPointer) => void;
  /**
   * Touch (coarse pointer): the pin-drop flow of 08 §5.3 — a fixed centre
   * crosshair (hover follows the view centre) and Place / Done buttons;
   * taps on the map do not place.
   */
  touch?: { placeLabel: string; doneLabel: string; onPlace: (p: ToolPointer) => void; onDone: () => void } | null;
  /**
   * Two fingers (§10): `start` with both fingers — true takes the gesture (the map does not pinch);
   * `move` with the fingers' distance over their starting distance; `end` on lift (`commit`) or cancel.
   */
  onPinch?: { start: (a: ToolPointer, b: ToolPointer) => boolean; move: (scale: number) => void; end: (commit: boolean) => void } | null;
}

interface Props {
  /**
   * Bearing from true north to the map's display-up direction, degrees
   * (`course.mapMetadata.northOffset`: paper +Y plus the drawn meridians'
   * tilt). With `cutRotationDeg` it gives the meridian tilt the view undoes.
   */
  northOffset?: number | null;
  /** The paper-north part of `northOffset` (`course.mapMetadata.cutRotationDeg`). */
  cutRotationDeg?: number | null;
  controls?: ControlOverlay[];
  courses?: CourseOverlay[];
  /** Course objects in scope of the highlighted courses, drawn by the GL course layer (docs/course-layer.md §8.3). */
  courseObjects?: import("@oxygen/shared").course.CourseObject[];
  /** The event's automatic cuts (`Event.autoOverprintCuts`); `false` = the GL course layer draws no automatic slits / gaps (course-layer.md §3.4). */
  autoCuts?: boolean;
  highlightControlId?: string;
  highlightCourseName?: string;
  onControlClick?: (controlId: string) => void;
  className?: string;
  style?: React.CSSProperties;
  initialFitControls?: boolean;
  focusControlIds?: string[] | null;
  showDescriptions?: boolean;
  /**
   * When no course is highlighted, list every positioned control in the
   * description sheet instead of rendering nothing. Used by the course
   * editor, where descriptions are useful before a course is picked.
   */
  descriptionsAllControls?: boolean;
  /** Localized sheet title for the all-controls listing ("All controls"). */
  allControlsTitle?: string;
  /** Event name for the single-course sheet's first header row. */
  eventName?: string;
  onToggleFullscreen?: () => void;
  isFullscreen?: boolean;
  /** Hide all interactive controls (zoom, measure, reset, fullscreen) */
  hideControls?: boolean;
  /** GPS route traces to overlay on the map (lat/lng points, already in WGS84). */
  gpsRoutes?: Array<{ color: string; points: Array<{ lat: number; lng: number }> }>;
  /** Course-editor gesture hooks. Editing is enabled iff this is set. */
  editor?: MapViewerEditorProps;
  /**
   * Content hash of the map's pinned document (`/api/map-documents/:hash`):
   * the vector base layer draws it (docs/map-rendering.md §5.4). `MapPanel`
   * mounts the viewer only with one.
   */
  documentHash: string;
  /** GPU budget of the vector layer: a club map's 150 MB or an event map's 30 MB. */
  mapBudget?: MapBudget;
  /** Operator rotation correction (`map_files.rotation_correction`), degrees, for the paper frame. */
  rotationCorrection?: number | null;
}

// ─── Helpers ────────────────────────────────────────────────

interface Pt { x: number; y: number }

/**
 * A control's number offset on the single highlighted course: the one
 * being dragged, else a move still round-tripping, else the stored one.
 */
function labelOffsetOf(
  id: string,
  controls: readonly ControlOverlay[],
  stored: CourseOverlay["labelOffsets"],
  drag: { id: string; x: number; y: number } | null,
  pending: ReadonlyMap<string, { to: { dx: number; dy: number } }>,
): { dx: number; dy: number } | undefined {
  if (drag?.id === id) {
    const ctrl = controls.find((k) => k.id === id);
    return ctrl ? { dx: drag.x - ctrl.x, dy: drag.y - ctrl.y } : undefined;
  }
  return pending.get(id)?.to ?? stored?.[id];
}

// ─── Component ──────────────────────────────────────────────

export function MapViewer({
  northOffset,
  cutRotationDeg,
  controls = [],
  courses = [],
  courseObjects,
  autoCuts = true,
  highlightControlId,
  highlightCourseName,
  onControlClick,
  className = "",
  style,
  initialFitControls = false,
  focusControlIds = null,
  showDescriptions = false,
  descriptionsAllControls = false,
  allControlsTitle,
  eventName,
  onToggleFullscreen,
  isFullscreen = false,
  hideControls = false,
  gpsRoutes,
  editor,
  documentHash,
  mapBudget = "event",
  rotationCorrection,
}: Props) {
  const { nameId } = useParams<{ nameId: string }>();
  const { t } = useTranslation("dashboard");
  const isCoarsePointer = useMediaQuery("(pointer: coarse)");
  const allowOneFingerMapPan = isFullscreen || !isCoarsePointer || !!editor?.fullBleed;
  const [showTwoFingerHint, setShowTwoFingerHint] = useState(false);

  // Base layer: the map document over a paper-space view
  // (docs/map-rendering.md §5.4).
  const { state: docState, retry: retryDocument } = useMapDocument(documentHash, nameId ?? null);
  const mapDoc = docState.status === "ready" ? docState.doc : null;
  const paperFrame = useMemo(
    () => (mapDoc ? paperFrameOf(mapDoc.header, rotationCorrection) : null),
    [mapDoc, rotationCorrection],
  );
  // Distances (scale bar, measure, leg lengths) follow the frame the transform uses.
  const mapScale = paperFrame?.mapScale ?? null;

  const containerRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<MapViewport | null>(null);
  const viewportRef = useRef<MapViewport | null>(null);
  viewportRef.current = viewport;
  // Live viewport context for native listeners and callbacks (set below, once the frame size is known).
  const vctxRef = useRef<ViewportContext>({ w: 0, h: 0, frame: null });

  const isPanningRef = useRef(false);
  const lastPosRef = useRef({ x: 0, y: 0 });
  const hasInitialFitRef = useRef(false);
  const lastFocusKeyRef = useRef<string>("");

  // ─── Measure tool state ──────────────────────────────────
  const [measuring, setMeasuring] = useState(false);
  const [measurePoints, setMeasurePoints] = useState<Pt[]>([]);
  const [measureCursor, setMeasureCursor] = useState<Pt | null>(null);
  const [userBearing, setUserBearing] = useState(0);
  // Two-finger rotate is easy to trigger by accident while pinch-zooming,
  // so rotation is opt-in: locked (north up) by default, remembered per
  // browser. The compass button below cycles reset → unlock/lock.
  const [rotationLocked, setRotationLocked] = useState<boolean>(() => {
    try {
      return localStorage.getItem(ROTATION_LOCK_STORAGE_KEY) !== "0";
    } catch {
      return true;
    }
  });
  // Mirror for the native touch listeners (registered in an effect whose
  // dependency list should not grow for this).
  const rotationLockedRef = useRef(rotationLocked);
  rotationLockedRef.current = rotationLocked;
  const persistRotationLock = (locked: boolean) => {
    setRotationLocked(locked);
    try {
      localStorage.setItem(ROTATION_LOCK_STORAGE_KEY, locked ? "1" : "0");
    } catch {
      // Private mode etc. — the session still gets the chosen state.
    }
  };

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
      prev ? centreOnGeo(prev, vctxRef.current, lat, lng) : prev,
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
          ? centreOnGeo(prev, vctxRef.current, geo.position!.lat, geo.position!.lng)
          : prev,
      );
    }
  }, [locateMode, geo]);

  const mouseDownPosRef = useRef<Pt | null>(null);
  const lastClickTimeRef = useRef(0);
  const lastClickPosRef = useRef<Pt | null>(null);
  const lastTouchRef = useRef<{ x: number; y: number; dist?: number } | null>(null);
  const touchGestureBaseRef = useRef<{
    x: number;
    y: number;
    dist: number;
    viewport: MapViewport;
  } | null>(null);
  const touchGestureFrameRef = useRef<number | null>(null);
  const pendingTouchGestureRef = useRef<{ x: number; y: number; dist: number } | null>(null);
  const touchStartPosRef = useRef<Pt | null>(null);
  const hadMultiTouchRef = useRef(false);
  const lastTouchEndAtRef = useRef<number | null>(null);
  const touchStartViewportRef = useRef<MapViewport | null>(null);
  const pinchStartAngleRef = useRef<number | null>(null);
  const pinchStartBearingRef = useRef(0);
  const rotateActivatedRef = useRef(false);
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
    touch: boolean;
  } | null>(null);
  const [editorDragPos, setEditorDragPos] = useState<{ id: string; x: number; y: number } | null>(null);
  const [editorDragTouch, setEditorDragTouch] = useState(false);
  // Coarse-pointer rules on the shared hit path (docs/course-editor.md §10, `lib/editor/touch.ts`):
  // the pending long-press on an unselected site, its timer, and the finger under a lifted drag (container px).
  const siteTouchRef = useRef<SiteTouch>(SITE_TOUCH_IDLE);
  /** A two-finger gesture the active tool took (pinch-scale of a selected object): the fingers' starting distance. */
  const toolPinchRef = useRef<{ dist0: number } | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const [touchFinger, setTouchFinger] = useState<Pt | null>(null);
  // Moves already sent via onMoveEnd but not yet reflected in the
  // `controls` prop (mutation + refetch in flight). Rendering `to`
  // prevents the control snapping back to its stale position. An entry
  // only applies while the control is still at `from`; it is deleted as
  // soon as the data catches up to `to` (effect below) so that a later
  // genuine return to `from` — an undone move — renders truthfully.
  const [pendingMoves, setPendingMoves] = useState<Map<string, { from: Pt; to: Pt }>>(new Map());
  const editorLabelDragRef = useRef<{
    id: string; startX: number; startY: number; moved: boolean;
    ctrlX: number; ctrlY: number;
    from: { dx: number; dy: number } | null;
    touch: boolean;
  } | null>(null);
  const [editorLabelDragPos, setEditorLabelDragPos] = useState<{ id: string; x: number; y: number } | null>(null);
  const [pendingLabelMoves, setPendingLabelMoves] = useState<
    Map<string, { from: { dx: number; dy: number } | null; to: { dx: number; dy: number } }>
  >(new Map());
  // Pointer-down bookkeeping for a leg click (insert on leg).
  const legDownRef = useRef<{ course: string; index: number; x: number; y: number } | null>(null);
  // A gesture the active tool took on pointer-down (docs/course-editor.md §6).
  const toolDragRef = useRef<{ startX: number; startY: number } | null>(null);
  const editorToolRef = useRef<EditorToolBinding | null>(null);
  editorToolRef.current = editor?.tool ?? null;

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

  useEffect(() => {
    setPendingLabelMoves((prev) => {
      if (prev.size === 0) return prev;
      const highlighted = courses.find(
        (c) => c.highlight || c.name === highlightCourseName,
      );
      let changed = false;
      const next = new Map(prev);
      for (const [id, m] of prev) {
        const stored = highlighted?.labelOffsets?.[id] ?? null;
        const from = m.from;
        const stillAtFrom =
          (stored == null && from == null) ||
          (stored != null &&
            from != null &&
            Math.abs(stored.dx - from.dx) < 1e-9 &&
            Math.abs(stored.dy - from.dy) < 1e-9);
        if (!stillAtFrom) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [courses, highlightCourseName]);

  // Undo/redo ran on the page: drop every bridge immediately, even ones
  // whose move round-trip hasn't refetched yet — the user asked for the
  // authoritative (restored) positions.
  const moveEpoch = editor?.moveEpoch;
  useEffect(() => {
    setPendingMoves((prev) => (prev.size === 0 ? prev : new Map()));
    setPendingLabelMoves((prev) => (prev.size === 0 ? prev : new Map()));
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

  // Map rotation: the drawn meridians vertical on screen — the paper view
  // is paper-north-up, so by the meridian tilt only (see viewportRotationDeg).
  const rotDeg = viewportRotationDeg(northOffset, cutRotationDeg, userBearing);
  const rotRad = (rotDeg * Math.PI) / 180;
  // Effective render dimensions: minimum bounding box of a rectangle that
  // fully covers the outer container after rotation. See rotatedBoundingBox
  // for the math — the previous single-factor formula was only correct for
  // square containers and produced visible wedges at corners otherwise.
  const { width: renderW, height: renderH } = rotatedBoundingBox(
    containerSize.w, containerSize.h, rotDeg,
  );

  const vctx: ViewportContext = useMemo(
    () => ({ w: renderW, h: renderH, frame: paperFrame }),
    [renderW, renderH, paperFrame],
  );
  vctxRef.current = vctx;

  // The vector layer's GL view: the paper view at device pixels, the
  // container's size, the inner frame's rotation (docs/map-rendering.md §5.4).
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const glViewRect = useMemo(
    () => viewport && containerSize.w > 0 && containerSize.h > 0
      ? glView(viewport, containerSize.w, containerSize.h, dpr, rotDeg)
      : null,
    [viewport, containerSize, dpr, rotDeg],
  );

  /** A control's position in paper mm: its own mm, else its lat/lng through the document's frame. */
  const controlMm = useCallback(
    (c: ControlOverlay): Pt | null => {
      if (c.x !== 0 || c.y !== 0) return { x: c.x, y: c.y };
      if (c.lat === 0 && c.lng === 0) return null;
      return geoToMm(paperFrame, c.lat, c.lng);
    },
    [paperFrame],
  );

  // ─── Course layer (vector) ──────────────────────────────
  // The course is drawn by the GL backend's dynamic bucket in colour order
  // with the map (docs/map-rendering.md §5.4 "Overlay"); the SVG keeps the
  // UI layer. A document whose stack cannot take the layer
  // (`onCourseSupport(false)`) draws no course: the viewer says so.
  const [courseSupport, setCourseSupport] = useState<boolean | null>(null);
  const [courseInfo, setCourseInfo] = useState<CourseInfo | null>(null);
  const glCourse = courseSupport !== false;
  /** The objects drawn: the stored ones in view with the editor's drafts over them (§7). */
  const drawnObjects = useMemo(() => {
    const drafts = editor?.draftObjects ?? [];
    if (drafts.length === 0) return courseObjects ?? [];
    const byId = new Map(drafts.map((o) => [o.id, o] as const));
    const out = (courseObjects ?? []).map((o) => byId.get(o.id) ?? o);
    for (const d of drafts) if (!out.includes(d)) out.push(d);
    return out;
  }, [courseObjects, editor?.draftObjects]);
  // The request reads these of the editor only: the editor object itself changes with every tool hover.
  const editorOn = !!editor;
  const editorFade = editor?.fadeNonCourse ?? false;
  const editorCourseIds = editor?.courseControlIds;
  const editorDraftFast = editor?.draftFast ?? false;
  const editorProvisional = editor?.provisional ?? null;
  const editorLayout = editor?.layout ?? null;
  const courseRequest = useMemo(() => {
    if (!glCourse) return null;
    const positions = new Map<string, Pt>();
    for (const c of controls) {
      const mm = controlMm(c);
      if (mm) positions.set(c.id, mm);
    }
    // The editor's local positions (pending moves while the data is stale).
    if (editorOn) {
      for (const [id, m] of pendingMoves) {
        const c = controls.find((k) => k.id === id);
        if (c && Math.abs(c.x - m.from.x) <= 1e-9 && Math.abs(c.y - m.from.y) <= 1e-9) positions.set(id, m.to);
      }
      if (editorDragPos) positions.set(editorDragPos.id, { x: editorDragPos.x, y: editorDragPos.y });
    }
    const sequenceLabels = showDescriptions || editorOn;
    const highlighted = courses.filter((c) => c.highlight || c.name === highlightCourseName);
    const single = sequenceLabels && highlighted.length === 1 ? highlighted[0] : null;
    const request = courseLayerRequest({
      controls,
      positions,
      courses,
      highlightCourseName,
      courseObjects: drawnObjects,
      sequenceLabels,
      // Manual offsets apply with the sheet or the editor only.
      labelOffset: (id) => (single ? labelOffsetOf(id, controls, single.labelOffsets, editorLabelDragPos, pendingLabelMoves) : undefined),
      exclude: editorFade
        ? new Set(controls.filter((c) => c.type === "Control" && !editorCourseIds?.has(c.id)).map((c) => c.id))
        : undefined,
      provisional: editorProvisional,
      layout: editorLayout,
      autoCuts,
    });
    return editorDraftFast ? { ...request, fastFilter: true } : request;
  }, [glCourse, controls, controlMm, editorOn, editorFade, editorCourseIds, editorDraftFast, editorProvisional, editorLayout, pendingMoves, editorDragPos, showDescriptions,
      courses, highlightCourseName, drawnObjects, editorLabelDragPos, pendingLabelMoves, autoCuts]);
  /** A dragged control's leg lengths (§6.1), from the positions the request draws. */
  const dragLegLabels = useMemo(() => {
    const st = courseRequest?.structure;
    type Structure = import("@oxygen/shared").course.CourseStructure;
    const structures: readonly Structure[] = !st ? [] : Array.isArray(st) ? st : [st as Structure];
    if (!editorOn || !editorDragPos || !courseRequest || structures.length !== 1) return [];
    const pos = new Map(courseRequest.sites.map((x) => [x.id, { x: x.x, y: x.y }] as const));
    return dragLegShapes(structures[0].items.map((i) => i.siteId), pos, editorDragPos.id, mapScale, structures[0].items.map((i) => i.leg?.bends));
  }, [editorOn, editorDragPos, courseRequest, mapScale]);

  // ─── Editor hit-test on the shared stage (docs/course-editor.md §5) ──
  const sharedHit = !!editor && glCourse;
  // Closed course objects (oob_area, whiteout, toner_saver, filter_region) hit by their outline only: their
  // interior is the map, so a press there pans (§5, §7; docs/bugfix-editor-area-press-pans.md).
  const uiAreas = useMemo(
    () => (editor ? drawnObjects.filter((o) => vertexRule(o.kind).closed).map((o) => ({ id: o.id, ring: outlinePoints(o.geometry, true) })) : []),
    [editor, drawnObjects],
  );
  // `style: "none"` legs have no layer object, so no hit piece: they hit from the derivation (§6.7).
  const uiLegs = useMemo(() => (editor ? uiLegsOf(courseInfo?.derivation?.courses) : []), [editor, courseInfo]);
  /** The editor target under a client point, `null` for empty map; `undefined` without a hit index (no editor, no course layer). */
  const resolveEditorTarget = (clientX: number, clientY: number): EditorTarget | null | undefined => {
    if (!sharedHit || !editor) return undefined;
    const pt = screenToMapMm(clientX, clientY);
    const edge = screenToMapMm(clientX + (isCoarsePointer ? COARSE_HIT_TOLERANCE_PX : HIT_TOLERANCE_PX), clientY);
    if (!pt || !edge) return null;
    const tol = Math.hypot(edge.x - pt.x, edge.y - pt.y);
    // The faded off-course controls are drawn by the UI layer, not the layer: plain circles. The layer's own
    // controls too, below its shapes: a circle with gaps is drawn as open arcs, whose interior does not hit.
    const radiusMm = courseInfo?.metrics?.circleRadiusMm ?? 3;
    const uiSites = [
      ...(editor.fadeNonCourse
        ? controls.filter((c) => c.type === "Control" && !editor.courseControlIds?.has(c.id) && (c.x !== 0 || c.y !== 0))
          .map((c) => ({ id: c.id, x: c.x, y: c.y, radiusMm }))
        : []),
      ...(courseInfo?.derivation?.sites ?? []).filter((d) => d.role === "control" && d.cuts.length > 0)
        .map((d) => ({ id: d.id, x: d.x, y: d.y, radiusMm })),
    ];
    // An armed placement draws its own visit: only real sites are targets (a reuse), never the cursor's circle or legs.
    const accept = editor.provisional ? (t: EditorTarget) => t.kind === "site" && t.id !== PROVISIONAL_SITE_ID : undefined;
    return editorHitAt(courseInfo?.hit ?? null, pt, tol, uiSites, uiAreas, accept, uiLegs);
  };
  const resolveEditorTargetRef = useRef(resolveEditorTarget);
  resolveEditorTargetRef.current = resolveEditorTarget;
  const editorSnapRef = useRef(editor?.snap ?? null);
  editorSnapRef.current = editor?.snap ?? null;

  /** The pointer as a tool sees it (§6): paper mm, the target under it, the zoom's mm per px. */
  const toolPointer = (clientX: number, clientY: number, shift: boolean, alt = false): ToolPointer | null => {
    const pt = screenToMapMm(clientX, clientY);
    const edge = screenToMapMm(clientX + 1, clientY);
    if (!pt || !edge) return null;
    return { pt, target: resolveEditorTarget(clientX, clientY) ?? null, shift, alt, mmPerPx: Math.hypot(edge.x - pt.x, edge.y - pt.y) };
  };
  const toolPointerRef = useRef(toolPointer);
  toolPointerRef.current = toolPointer;

  /**
   * Pointer-down on the map: arm a control drag, a number drag or a leg
   * click for the target under the pointer. True when the pointer is on a
   * target (the map does not pan); false for empty map or no hit index.
   */
  const armEditorTargetImpl = (clientX: number, clientY: number, touch: boolean): boolean => {
    const target = resolveEditorTargetRef.current(clientX, clientY);
    if (!target) return false;
    if (touch && Date.now() < suppressEditorSelectionUntilRef.current) return true;
    if (target.kind === "leg") {
      legDownRef.current = { course: target.courseId, index: target.index, x: clientX, y: clientY };
      return true;
    }
    const ctrl = controls.find((k) => k.id === target.id);
    if (!ctrl) return false;
    // Touch (§10): only a selected control drags at once; on another one the press is pending — a pan,
    // a tap that selects it, or a long press that selects it and starts the move. Its number likewise.
    if (touch && ctrl.id !== editor?.selectedControlId) {
      stepSiteTouchRef.current({ type: "down", id: ctrl.id, selected: false, x: clientX, y: clientY, t: performance.now() });
      if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = window.setTimeout(() => {
        longPressTimerRef.current = null;
        stepSiteTouchRef.current({ type: "tick", t: performance.now() });
      }, LONG_PRESS_MS);
      return false;
    }
    if (touch && target.kind === "site") siteTouchRef.current = { kind: "drag", id: ctrl.id };
    if (target.kind === "site") {
      editorDragRef.current = { id: ctrl.id, startX: clientX, startY: clientY, moved: false, origX: ctrl.x, origY: ctrl.y, touch };
      setEditorDragTouch(touch);
      return true;
    }
    const single = courses.filter((c) => c.highlight || c.name === highlightCourseName);
    const from = single.length === 1 ? labelOffsetOf(ctrl.id, controls, single[0].labelOffsets, null, pendingLabelMoves) ?? null : null;
    editorLabelDragRef.current = { id: ctrl.id, startX: clientX, startY: clientY, moved: false, ctrlX: ctrl.x, ctrlY: ctrl.y, from, touch };
    return true;
  };
  /** One step of the touch rules; its effect selects the site and / or starts its (lifted) drag. */
  const stepSiteTouch = (e: SiteTouchEvent) => {
    const { state, effect } = siteTouch(siteTouchRef.current, e);
    siteTouchRef.current = state;
    if (state.kind !== "pending" && longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    if (!effect) return;
    // The finger is on a site: its lift is not a map tap.
    touchOnEditorTargetRef.current = true;
    if (effect.kind === "select" || effect.select) editor?.onSelect?.(effect.id);
    if (effect.kind === "drag") {
      const ctrl = controls.find((k) => k.id === effect.id);
      const p = e.type === "move" ? { x: e.x, y: e.y } : touchStartPosRef.current;
      if (!ctrl || !p) return;
      isPanningRef.current = false;
      editorDragRef.current = { id: ctrl.id, startX: p.x, startY: p.y, moved: false, origX: ctrl.x, origY: ctrl.y, touch: true };
      setEditorDragTouch(true);
      try { navigator.vibrate?.(15); } catch { /* not supported */ }
    }
  };
  const stepSiteTouchRef = useRef(stepSiteTouch);
  stepSiteTouchRef.current = stepSiteTouch;
  useEffect(() => () => { if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current); }, []);
  const armEditorTargetRef = useRef(armEditorTargetImpl);
  armEditorTargetRef.current = armEditorTargetImpl;
  const armEditorTarget = useCallback((clientX: number, clientY: number, touch: boolean) => armEditorTargetRef.current(clientX, clientY, touch), []);

  /** Fits the whole map: the document's extent. */
  const fitWholeMap = useCallback(() => {
    if (containerSize.w === 0 || containerSize.h === 0) return;
    if (mapDoc) setViewport(fitMm(boundsMm(mapDoc.header), containerSize.w, containerSize.h, 0.05));
  }, [mapDoc, containerSize]);

  // ─── Viewport initialization from the document's extent ──

  useEffect(() => {
    if (viewport) return; // already initialized
    if (containerSize.w === 0 || containerSize.h === 0) return;
    if (!mapDoc) return;
    setViewport(fitMm(boundsMm(mapDoc.header), containerSize.w, containerSize.h, 0.05));
    hasInitialFitRef.current = false;
    lastFocusKeyRef.current = "";
  }, [containerSize, viewport, mapDoc]);

  // ─── Helper: fit the view to controls (paper mm) ─────────

  const fitToControlBounds = useCallback(
    (ctrls: ControlOverlay[], padding: number) => {
      if (ctrls.length === 0 || containerSize.w === 0 || containerSize.h === 0) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const c of ctrls) {
        const mm = controlMm(c);
        if (!mm) continue;
        minX = Math.min(minX, mm.x); maxX = Math.max(maxX, mm.x);
        minY = Math.min(minY, mm.y); maxY = Math.max(maxY, mm.y);
      }
      if (minX === Infinity) return;
      // Ring radius 2.5 mm on paper, so control rings aren't clipped at the edge.
      setViewport(fitMm({ minX: minX - 2.5, minY: minY - 2.5, maxX: maxX + 2.5, maxY: maxY + 2.5 }, containerSize.w, containerSize.h, padding));
    },
    [containerSize, controlMm],
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
      fitWholeMap();
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

  const onCourseInfo = editor?.onCourseInfo;
  useEffect(() => {
    onCourseInfo?.(courseInfo ? { derivation: courseInfo.derivation, metrics: courseInfo.metrics } : null);
  }, [courseInfo, onCourseInfo]);

  // ─── Editor view requests (docs/course-editor.md §6.5: F, Tab) ──
  const viewRequestKeyRef = useRef<number | null>(null);
  useEffect(() => {
    const req = editor?.viewRequest;
    if (!req || !viewport || req.key === viewRequestKeyRef.current) return;
    viewRequestKeyRef.current = req.key;
    if (req.bounds) {
      setUserBearing(0);
      setViewport(fitMm(req.bounds, containerSize.w, containerSize.h, 0.04));
    } else if (req.fit && req.fit.length > 0) {
      const ids = new Set(req.fit);
      fitToControlBounds(controls.filter((c) => ids.has(c.id)), 0.08);
    } else if (req.centre) {
      const c = req.centre;
      // The screen offset into the inner (rotated) frame, then into paper µm (y up).
      const o = req.offsetPx ?? { x: 0, y: 0 };
      const ix = o.x * Math.cos(rotRad) + o.y * Math.sin(rotRad);
      const iy = -o.x * Math.sin(rotRad) + o.y * Math.cos(rotRad);
      setViewport((prev) => (prev
        ? { ...prev, centreX: c.x * 1000 - ix / prev.pxPerUm, centreY: c.y * 1000 + iy / prev.pxPerUm }
        : prev));
    }
  }, [editor?.viewRequest, viewport, controls, fitToControlBounds, rotRad, containerSize.w, containerSize.h]);

  // Touch pin-drop: the ghost follows the view centre (08 §5.3 "Touch").
  useEffect(() => {
    const tool = editor?.tool;
    if (!tool?.touch || !isCoarsePointer || !tool.onHover || !viewport) return;
    const rect = containerRef.current?.getBoundingClientRect();
    const p = rect ? toolPointerRef.current(rect.left + rect.width / 2, rect.top + rect.height / 2, false) : null;
    if (p) tool.onHover(p);
  }, [editor?.tool, isCoarsePointer, viewport]);

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
      const fcMm = controlMm(focusControls[0]);
      if (!fcMm) return;
      const all = controls.filter((c) => c.type === "Control").map(controlMm).filter((p): p is Pt => p !== null);
      if (all.length >= 2) {
        const xs = all.map((p) => p.x), ys = all.map((p) => p.y);
        const ext = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 0.167;
        setViewport(fitMm({ minX: fcMm.x - ext, minY: fcMm.y - ext, maxX: fcMm.x + ext, maxY: fcMm.y + ext }, cw, ch, 0.05));
      } else {
        setViewport((prev) => prev ? { ...prev, centreX: fcMm.x * 1000, centreY: fcMm.y * 1000 } : prev);
      }
    } else {
      fitToControlBounds(focusControls, hideControls ? 0.02 : 0.05);
    }
  }, [viewport, focusControlIds, controls, containerSize, hideControls, fitToControlBounds, controlMm]);

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

  /** Convert screen pixel to map mm (always reads live refs, so touchend
   *  placement in native listeners never samples a stale viewport after
   *  a pan frame). */
  const screenToMapMm = useCallback(
    (clientX: number, clientY: number): Pt | null => {
      const vp = viewportRef.current;
      if (!vp || !containerRef.current) return null;
      const rect = containerRef.current.getBoundingClientRect();
      const { ix, iy } = screenToInner(clientX - rect.left, clientY - rect.top);
      return innerToMm(vp, vctxRef.current, ix, iy);
    },
    [screenToInner],
  );

  /** Convert map mm coords to screen pixel (in the rotated inner space). */
  const mapMmToScreen = useCallback(
    (mapX: number, mapY: number): Pt | null => {
      if (!viewport || containerSize.w === 0) return null;
      return mmToInner(viewport, vctx, mapX, mapY);
    },
    [viewport, vctx, containerSize],
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

  // Symbol size: CSS px per paper mm at the current zoom.
  const symbolScale = useMemo(() => (viewport ? pxPerMapMm(viewport) : 1), [viewport]);

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

      const zoomDelta = e.deltaY > 0 ? -0.15 : 0.15;
      const vc = { ...vctxRef.current, w: rw, h: rh };

      breakLocateFollowRef.current();
      setViewport((prev) => (prev ? zoomAt(prev, vc, ix, iy, zoomDelta) : prev));
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
    setEditorDragTouch(false);
    if (cancelled) {
      setEditorDragPos(null);
      return;
    }
    if (drag.moved) {
      const raw = screenToMapMm(clientX, clientY);
      const pt = raw && editor.snap ? editor.snap(raw) : raw;
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

  const finishEditorLabelDrag = useCallback((clientX: number, clientY: number, cancelled: boolean) => {
    const drag = editorLabelDragRef.current;
    if (!editor || !drag) return;
    editorLabelDragRef.current = null;
    isPanningRef.current = false;
    mouseDownPosRef.current = null;
    if (cancelled) {
      setEditorLabelDragPos(null);
      return;
    }
    if (drag.moved) {
      const pt = screenToMapMm(clientX, clientY);
      setEditorLabelDragPos(null);
      if (pt) {
        const to = { dx: pt.x - drag.ctrlX, dy: pt.y - drag.ctrlY };
        setPendingLabelMoves((prev) => {
          const next = new Map(prev);
          next.set(drag.id, { from: drag.from, to });
          return next;
        });
        editor.onLabelMoveEnd?.(drag.id, to);
      }
    } else {
      editor.onSelect?.(drag.id);
    }
  }, [editor, screenToMapMm]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const tool = editorToolRef.current;
    if (!measuring && tool) {
      const p = toolPointerRef.current(e.clientX, e.clientY, e.shiftKey, e.altKey);
      if (p && tool.onPointerDown?.(p)) {
        toolDragRef.current = { startX: e.clientX, startY: e.clientY };
        return;
      }
    }
    if (!measuring && !tool?.exclusive && armEditorTarget(e.clientX, e.clientY, false)) return;
    if (!measuring) isPanningRef.current = true;
    lastPosRef.current = { x: e.clientX, y: e.clientY };
    mouseDownPosRef.current = { x: e.clientX, y: e.clientY };
  }, [measuring, armEditorTarget]);

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
        const raw = screenToMapMm(e.clientX, e.clientY);
        const pt = raw && editor.snap ? editor.snap(raw) : raw;
        if (pt) setEditorDragPos({ id: drag.id, x: pt.x, y: pt.y });
      }
      return;
    }
    if (editor && toolDragRef.current) {
      const pt = screenToMapMm(e.clientX, e.clientY);
      if (pt) editorToolRef.current?.onPointerDrag?.(pt, { shift: e.shiftKey, alt: e.altKey });
      return;
    }
    if (editor?.tool?.onHover && !isPanningRef.current && e.buttons === 0) {
      const p = toolPointerRef.current(e.clientX, e.clientY, e.shiftKey, e.altKey);
      if (p) editor.tool.onHover(p);
    }
    const labelDrag = editorLabelDragRef.current;
    if (editor && labelDrag) {
      const dx = Math.abs(e.clientX - labelDrag.startX);
      const dy = Math.abs(e.clientY - labelDrag.startY);
      if (labelDrag.moved || dx + dy > 3) {
        labelDrag.moved = true;
        const pt = screenToMapMm(e.clientX, e.clientY);
        if (pt) setEditorLabelDragPos({ id: labelDrag.id, x: pt.x, y: pt.y });
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
      breakLocateFollow();
      setViewport((prev) => (prev ? panBy(prev, dx, dy) : prev));
    }
    if (measuring) {
      const pt = screenToMapMm(e.clientX, e.clientY);
      if (pt) setMeasureCursor(pt);
    }
  }, [measuring, viewport, rotRad, screenToMapMm, editor, breakLocateFollow]);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    if (editor && toolDragRef.current) {
      toolDragRef.current = null;
      isPanningRef.current = false;
      mouseDownPosRef.current = null;
      editorToolRef.current?.onPointerUp?.(e.type === "mouseleave" ? null : screenToMapMm(e.clientX, e.clientY));
      return;
    }
    if (e.type === "mouseleave") editorToolRef.current?.onHover?.(null);
    const drag = editorDragRef.current;
    if (editor && drag) {
      if (e.type === "mouseleave") {
        finishEditorDrag(e.clientX, e.clientY, true);
        return;
      }
      finishEditorDrag(e.clientX, e.clientY, false);
      return;
    }
    const labelDrag = editorLabelDragRef.current;
    if (editor && labelDrag) {
      if (e.type === "mouseleave") {
        finishEditorLabelDrag(e.clientX, e.clientY, true);
        return;
      }
      finishEditorLabelDrag(e.clientX, e.clientY, false);
      return;
    }
    const leg = legDownRef.current;
    if (editor && leg) {
      // The leg click of shared hit-testing (§5).
      legDownRef.current = null;
      isPanningRef.current = false;
      mouseDownPosRef.current = null;
      if (e.type !== "mouseleave" && Date.now() >= suppressEditorSelectionUntilRef.current &&
          Math.abs(e.clientX - leg.x) + Math.abs(e.clientY - leg.y) < 5) {
        const pt = screenToMapMm(e.clientX, e.clientY);
        if (pt) editor.onLegClick?.(leg.course, leg.index, pt);
      }
      return;
    }
    isPanningRef.current = false;
    if (measuring && mouseDownPosRef.current) {
      if (shouldSuppressSyntheticMouse(Date.now(), lastTouchEndAtRef.current)) {
        mouseDownPosRef.current = null;
        return;
      }
      const onButton = (e.target as HTMLElement).closest?.("button");
      const dx = Math.abs(e.clientX - mouseDownPosRef.current.x);
      const dy = Math.abs(e.clientY - mouseDownPosRef.current.y);
      if (dx + dy < 5 && !onButton) {
        const now = Date.now();
        // Double-click clears the rubber-band cursor (mouse/hover only).
        // Require spatial proximity too: two quick clicks at *different*
        // spots are two measure points, not a double-click — without the
        // distance check a fast second click anywhere swallowed the point.
        const lastPos = lastClickPosRef.current;
        const isDoubleClick =
          now - lastClickTimeRef.current < 300 &&
          lastPos != null &&
          Math.hypot(e.clientX - lastPos.x, e.clientY - lastPos.y) < 8;
        if (isDoubleClick) {
          lastClickTimeRef.current = 0;
          lastClickPosRef.current = null;
          setMeasureCursor(null);
        } else {
          lastClickTimeRef.current = now;
          lastClickPosRef.current = { x: e.clientX, y: e.clientY };
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
        const tool = editorToolRef.current;
        if (tool?.exclusive) {
          const p = toolPointerRef.current(e.clientX, e.clientY, e.shiftKey, e.altKey);
          if (p) tool.onClick?.(p);
        } else {
          const pt = screenToMapMm(e.clientX, e.clientY);
          if (pt) editor.onMapClick?.(pt);
        }
      }
    }
    mouseDownPosRef.current = null;
  }, [measuring, screenToMapMm, editor, finishEditorDrag, finishEditorLabelDrag]);

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
      breakLocateFollowRef.current();
      setViewport((prev) => {
        if (!prev) return prev;
        const next = panBy(prev, dx, dy);
        // Sync immediately so a tap on the same gesture frame sees the
        // post-pan viewport (React state alone would still be stale).
        viewportRef.current = next;
        return next;
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
        stepSiteTouchRef.current({ type: "second-finger" });
        // A first finger may have landed on a control before the second
        // finger joined. That is a map gesture, not a control drag.
        editorDragRef.current = null;
        setEditorDragPos(null);
        editorLabelDragRef.current = null;
        setEditorLabelDragPos(null);
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const midpointX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const midpointY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        const distance = Math.sqrt(dx * dx + dy * dy);
        // The tool first: two fingers on a selected object's handles scale it (§10).
        const pinch = editorToolRef.current?.onPinch;
        if (pinch && distance > 0) {
          const a = toolPointerRef.current(e.touches[0].clientX, e.touches[0].clientY, false);
          const b = toolPointerRef.current(e.touches[1].clientX, e.touches[1].clientY, false);
          if (a && b && pinch.start(a, b)) {
            toolPinchRef.current = { dist0: distance };
            touchStartPosRef.current = null;
            e.preventDefault();
            return;
          }
        }
        lastTouchRef.current = {
          x: midpointX,
          y: midpointY,
          dist: distance,
        };
        pinchStartAngleRef.current = Math.atan2(dy, dx);
        pinchStartBearingRef.current = userBearing;
        rotateActivatedRef.current = false;
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
      if (!measuring && !editorToolRef.current?.exclusive && armEditorTargetRef.current(t.clientX, t.clientY, true)) {
        touchOnEditorTargetRef.current = true;
        e.preventDefault();
        return;
      }
      touchStartViewportRef.current = viewportRef.current;
      if (allowOneFingerMapPan && !measuring) isPanningRef.current = true;
      if (measuring || allowOneFingerMapPan) e.preventDefault();
    };

    const onTouchMove = (e: TouchEvent) => {
      if (siteTouchRef.current.kind === "pending" && e.touches.length === 1) {
        stepSiteTouchRef.current({ type: "move", x: e.touches[0].clientX, y: e.touches[0].clientY, t: performance.now() });
      }
      const drag = editorDragRef.current;
      if (drag && e.touches.length === 1) {
        e.preventDefault();
        const t = e.touches[0];
        const dx = Math.abs(t.clientX - drag.startX);
        const dy = Math.abs(t.clientY - drag.startY);
        if (drag.moved || dx + dy > 3) {
          drag.moved = true;
          // Touch on the shared path: the control rides above the finger (§10), on a stem to it.
          const lifted = drag.touch;
          const at = lifted ? liftedPoint(t.clientX, t.clientY) : { x: t.clientX, y: t.clientY };
          const raw = screenToMapMm(at.x, at.y);
          const snap = editorSnapRef.current;
          const pt = raw && snap ? snap(raw) : raw;
          if (pt) setEditorDragPos({ id: drag.id, x: pt.x, y: pt.y });
          if (lifted) {
            const rect = el.getBoundingClientRect();
            setTouchFinger({ x: t.clientX - rect.left, y: t.clientY - rect.top });
          }
        }
        return;
      }
      const labelDrag = editorLabelDragRef.current;
      if (labelDrag && e.touches.length === 1) {
        e.preventDefault();
        const t = e.touches[0];
        const dx = Math.abs(t.clientX - labelDrag.startX);
        const dy = Math.abs(t.clientY - labelDrag.startY);
        if (labelDrag.moved || dx + dy > 3) {
          labelDrag.moved = true;
          const pt = screenToMapMm(t.clientX, t.clientY);
          if (pt) setEditorLabelDragPos({ id: labelDrag.id, x: pt.x, y: pt.y });
        }
        return;
      }

      const rw = renderW || 1;
      const rh = renderH || 1;

      if (e.touches.length === 2 && toolPinchRef.current) {
        e.preventDefault();
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        editorToolRef.current?.onPinch?.move(Math.hypot(dx, dy) / toolPinchRef.current.dist0);
        return;
      }
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

        // Two-finger rotate: activate after ~8° so plain pinch-zoom stays
        // stable — and only when the compass is unlocked, since even 8°
        // is easy to hit by accident mid-pinch.
        if (pinchStartAngleRef.current != null && !rotationLockedRef.current) {
          const angle = Math.atan2(dy, dx);
          let deltaDeg = ((angle - pinchStartAngleRef.current) * 180) / Math.PI;
          if (deltaDeg > 180) deltaDeg -= 360;
          if (deltaDeg < -180) deltaDeg += 360;
          if (!rotateActivatedRef.current && Math.abs(deltaDeg) >= 8) {
            rotateActivatedRef.current = true;
          }
          if (rotateActivatedRef.current) {
            setUserBearing(pinchStartBearingRef.current + deltaDeg);
          }
        }

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
            const next = zoomAt(
              base.viewport,
              { ...vctxRef.current, w: rw, h: rh },
              from.x,
              from.y,
              Math.log2(current.dist / base.dist),
              to.x,
              to.y,
            );
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
      // A pending press lifted before its long press selects the site; the lift is not a map tap.
      if (e.touches.length === 0) stepSiteTouchRef.current({ type: "up" });
      setTouchFinger(null);
      if (toolPinchRef.current && e.touches.length < 2) {
        toolPinchRef.current = null;
        editorToolRef.current?.onPinch?.end(e.type !== "touchcancel");
        suppressEditorSelectionUntilRef.current = Date.now() + 400;
        if (e.touches.length === 0) { lastTouchRef.current = null; touchStartPosRef.current = null; hadMultiTouchRef.current = false; }
        return;
      }
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
        // Dropped where it was drawn: above the finger (§10).
        const at = drag.touch ? liftedPoint(t.clientX, t.clientY) : { x: t.clientX, y: t.clientY };
        finishEditorDrag(at.x, at.y, false);
        return;
      }
      const labelDrag = editorLabelDragRef.current;
      if (labelDrag && e.changedTouches.length > 0 && e.touches.length === 0) {
        if (
          hadMultiTouchRef.current ||
          Date.now() < suppressEditorSelectionUntilRef.current
        ) {
          editorLabelDragRef.current = null;
          setEditorLabelDragPos(null);
          lastTouchRef.current = null;
          touchStartPosRef.current = null;
          hadMultiTouchRef.current = false;
          isPanningRef.current = false;
          return;
        }
        const t = e.changedTouches[0];
        finishEditorLabelDrag(t.clientX, t.clientY, false);
        return;
      }

      const leg = legDownRef.current;
      if (leg && e.changedTouches.length > 0 && e.touches.length === 0) {
        legDownRef.current = null;
        const t = e.changedTouches[0];
        if (!hadMultiTouchRef.current && Date.now() >= suppressEditorSelectionUntilRef.current && Math.abs(t.clientX - leg.x) + Math.abs(t.clientY - leg.y) < 10) {
          const pt = screenToMapMm(t.clientX, t.clientY);
          if (pt) editor?.onLegClick?.(leg.course, leg.index, pt);
        }
      }
      if (e.touches.length === 0) {
        if (hadMultiTouchRef.current) {
          suppressEditorSelectionUntilRef.current = Date.now() + 400;
        }
        lastTouchEndAtRef.current = Date.now();
        // Touch has no hover: clear the rubber-band so a pan-end position
        // never sticks as a phantom measure endpoint.
        if (measuring) setMeasureCursor(null);
        if (measuring && touchStartPosRef.current && e.changedTouches.length > 0 && !hadMultiTouchRef.current) {
          const t = e.changedTouches[0];
          const fingerMovementPx = dist2d(
            touchStartPosRef.current,
            { x: t.clientX, y: t.clientY },
          );
          let viewportCenterDeltaPx = 0;
          const startVp = touchStartViewportRef.current;
          const vp = viewportRef.current;
          if (startVp && vp) {
            // Centre drift in CSS pixels at the current zoom.
            viewportCenterDeltaPx = centreShiftPx(startVp, vp);
          }
          if (isMeasureTap({ fingerMovementPx, viewportCenterDeltaPx })) {
            const pt = screenToMapMm(t.clientX, t.clientY);
            if (pt) setMeasurePoints((prev) => [...prev, pt]);
          }
        }
        touchStartViewportRef.current = null;
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
            const tool = editorToolRef.current;
            if (tool?.exclusive) {
              // Pin-drop: the Place button places, a tap does not (08 §5.3 "Touch").
              const p = tool.touch ? null : toolPointerRef.current(t.clientX, t.clientY, false);
              if (p) tool.onClick?.(p);
            } else {
              // A tap on a course object goes to the tool (V selects it, §10); anything else is a map tap.
              const p = tool?.onPointerDown ? toolPointerRef.current(t.clientX, t.clientY, false) : null;
              if (p?.target?.kind === "object" && tool!.onPointerDown!(p)) {
                tool!.onPointerUp?.(p.pt);
              } else {
                const pt = screenToMapMm(t.clientX, t.clientY);
                if (pt) editor.onMapClick?.(pt);
              }
            }
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
    finishEditorLabelDrag,
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

  // ─── Overlay rendering ─────────────────────────────────

  // GPS tracks in paper mm: proj4 once per point per route set, so pan
  // and zoom only scale them.
  const gpsRoutesMm = useMemo(() => {
    if (!gpsRoutes || !paperFrame) return null;
    return gpsRoutes.map((r) =>
      r.points.map(({ lat, lng }) => geoToMm(paperFrame, lat, lng)).filter((p): p is Pt => p !== null),
    );
  }, [gpsRoutes, paperFrame]);

  const overlayContent = useMemo(() => {
    if (!viewport || containerSize.w === 0 || containerSize.h === 0) return null;

    // The UI layer (status and selection rings, faded controls, badges)
    // takes the drawn symbols' sizes: the library's dimensions × the
    // document factor (course-layer.md §3.1).
    const glm = courseInfo?.metrics ?? null;
    const radius = (glm?.circleRadiusMm ?? 2.5) * symbolScale;
    const stroke = Math.max(0.5, (glm?.lineWidthMm ?? 0.35) * symbolScale);
    // The punch-count badge scales with the course layer's number (ISOM
    // 704's digit height as an em).
    const labelDigitHeight = (glm?.digitHeightMm ?? defaultMapAppearance.numberHeightMm) * symbolScale;
    const labelSize = labelDigitHeight / CONTROL_NUMBER_CAP_HEIGHT_RATIO;
    const startSize = (glm?.startRadiusMm ?? 3.5) * symbolScale;
    const finishOuter = (glm?.finishRadiusMm ?? 3.0) * symbolScale;
    const legStroke = Math.max(0.5, (glm?.lineWidthMm ?? 0.35) * symbolScale);

    const mmPx = (mx: number, my: number) => {
      const p = mmToInner(viewport, vctx, mx, my);
      return { px: p.x, py: p.y };
    };

    // Pixel positions for all controls: the control's own paper mm
    // (lat/lng through the document's frame only as a fallback).
    const ctrlPixels = new Map<string, Pt>();
    for (const c of controls) {
      const mm = controlMm(c);
      if (mm) ctrlPixels.set(c.id, mmToInner(viewport, vctx, mm.x, mm.y));
    }

    // Editor overrides: a control being dragged (or whose move is still
    // round-tripping) renders at its local position. A pending move only
    // applies while the control still reports the position it had when
    // the drag started — once the refetch lands (or an external writer
    // moved it) the entry is inert.
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

    const purple = defaultMapAppearance.purple;
    const lowerElements: React.ReactNode[] = [];
    const upperElements: React.ReactNode[] = [];

    // Highlighted courses drive the multi-course leg labels below.
    const highlightedCourses = courses.filter(
      (c) => c.highlight || c.name === highlightCourseName,
    );
    // With more than one course on screen it's hard to tell which lines
    // belong to what — label each leg with the classes that run it.
    const legLabelMode = highlightedCourses.length > 1;

    // ─── GPS route traces ─────────────────────────────────

    if (gpsRoutes && gpsRoutes.length > 0 && viewport) {
      for (let ri = 0; ri < gpsRoutes.length; ri++) {
        const route = gpsRoutes[ri];
        if (route.points.length < 2) continue;
        // Tracks reach the paper view through mapGeo once per route (gpsRoutesMm), not per frame.
        const screenPts = (gpsRoutesMm?.[ri] ?? []).map((p) => mmPx(p.x, p.y));
        const d = screenPts
          .map((p, i) => `${i === 0 ? "M" : "L"}${p.px.toFixed(1)},${p.py.toFixed(1)}`)
          .join(" ");
        upperElements.push(
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

    // ─── Control marks (the UI layer over the GL course layer) ─────

    const sortedControls = [...controls].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

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
        purple;
      // Editor fading: while a course is selected, regular controls off
      // the course recede (Purple Pen style). The course layer leaves them
      // out (`exclude`); they are drawn here as plain circles, still
      // clickable. Start/finish stay at full strength.
      const fade =
        editor?.fadeNonCourse && c.type === "Control" && !editor.courseControlIds?.has(c.id)
          ? 0.3
          : undefined;
      const symbolR = c.type === "Start" ? startSize : c.type === "Finish" ? finishOuter : radius;

      if (fade) {
        lowerElements.push(
          <circle key={`ctrl-${c.id}`} cx={pos.x} cy={pos.y} r={radius} stroke={baseColor} strokeWidth={stroke} fill="none"
            opacity={fade}
            data-testid="control-faded"
            style={{ cursor: onControlClick ? "pointer" : undefined }}
            onClick={onControlClick ? () => onControlClick(c.id) : undefined} />
        );
      } else if (baseColor !== purple) {
        // The GL layer draws the symbol; a status (readout punch state,
        // highlight) is a ring of the UI layer around it.
        upperElements.push(
          <circle key={`status-${c.id}`} cx={pos.x} cy={pos.y} r={symbolR + stroke * 1.5}
            stroke={baseColor} strokeWidth={stroke * 1.5} fill="none"
            data-testid="control-status-ring" data-control-id={c.id}
            style={{ cursor: onControlClick ? "pointer" : undefined }}
            onClick={onControlClick ? () => onControlClick(c.id) : undefined} />
        );
      } else if (onControlClick) {
        upperElements.push(
          <circle key={`click-${c.id}`} cx={pos.x} cy={pos.y} r={symbolR} fill="transparent" stroke="none"
            style={{ cursor: "pointer" }} onClick={() => onControlClick(c.id)} />
        );
      }

      if (c.type === "Control") {
        // Completion ring (overlaps control circle at same radius)
        if (c.completionPct !== undefined && c.completionPct > 0) {
          const ringR = radius;
          const pct = Math.min(c.completionPct, 1);
          if (pct >= 1) {
            lowerElements.push(
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
            lowerElements.push(
              <path key={`comp-${c.id}`}
                d={`M${x1},${y1} A${ringR},${ringR} 0 ${largeArc} 1 ${x2},${y2}`}
                stroke="#059669" strokeWidth={stroke * 2.5} fill="none" opacity={0.8} />
            );
          }
        }

        // Punch count badge
        if (c.punchCount !== undefined && c.punchCount > 0) {
          const badgeR = Math.max(6, labelSize * 0.5);
          upperElements.push(
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
      }

      // Editor: selection ring. No ring while an exclusive tool is armed
      // (§6.1): the control just placed stays selected, its purple circle
      // is the mark.
      if (editor && showSelectionRing(editor) && editor.selectedControlId === c.id) {
        upperElements.push(
          <circle key={`edit-sel-${c.id}`} cx={pos.x} cy={pos.y} r={symbolR * 1.45}
            stroke="#2563eb" strokeWidth={Math.max(1, stroke * 0.8)} fill="none"
            strokeDasharray={`${Math.max(2, stroke * 2)} ${Math.max(2, stroke * 2)}`}
            opacity={0.9} style={{ pointerEvents: "none" }}
            data-testid="editor-selection-ring" />
        );
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
        upperElements.push(
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
        upperElements.push(
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
            upperElements.push(
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
        upperElements.push(
          <circle key={`mpt-${i}`} cx={screenMeasurePts[i].x} cy={screenMeasurePts[i].y}
            r={5} fill="#2563eb" stroke="white" strokeWidth={2} />
        );
      }
    }

    return { lowerNodes: lowerElements, upperNodes: upperElements, radiusPx: radius, strokePx: stroke };

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewport, containerSize, renderW, renderH, controls, courses, highlightControlId, highlightCourseName,
      symbolScale, vctx, controlMm, gpsRoutesMm, measuring, measurePoints, measureCursor, onControlClick,
      mapMmToScreen, rotDeg, gpsRoutes, editor, editorDragPos, pendingMoves, courseInfo]);

  // ─── Description sheet (outside rotation) ──────────────

  const descriptionSheet = useMemo(() => {
    if (!showDescriptions || containerSize.w === 0 || containerSize.h === 0) return null;
    const activeCourses = courses.filter(
      (c) => c.highlight || c.name === highlightCourseName,
    );
    // Without an active course `descriptionsAllControls` lists every
    // positioned control; otherwise there is no sheet.
    const allControlsMode = descriptionsAllControls && activeCourses.length === 0;
    if (activeCourses.length === 0 && !allControlsMode) return null;
    return renderDescriptionSheet(
      symbolScale,
      containerSize.w,
      containerSize.h,
      activeCourses,
      controls,
      allControlsMode,
      allControlsTitle,
      { eventName, mapScale: mapScale ?? null },
    );
  }, [showDescriptions, descriptionsAllControls, allControlsTitle, symbolScale, containerSize, courses, highlightCourseName, controls, eventName, mapScale]);

  // ─── Scale bar ─────────────────────────────────────────

  // The page's bottom sheet (§10): the scale bar and the corner buttons sit above it, and hide once it is too tall.
  const bottomInset = editor?.bottomInsetPx ?? 0;
  const scaleBar = useMemo(() => {
    if (!viewport || !mapScale || containerSize.w === 0) return null;
    const mpp = metresPerPx(viewport, mapScale);
    if (mpp == null) return null;
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
      <div style={{ position: "absolute", bottom: 12 + bottomInset, left: 12, pointerEvents: "none", zIndex: 10 }}>
        <div style={{ fontSize: 11, color: "#334155", fontWeight: 600, marginBottom: 2 }}>{label}</div>
        <div style={{ width: barPx, height: 4, background: "#334155", borderRadius: 1, opacity: 0.8 }} />
      </div>
    );
  }, [viewport, mapScale, containerSize, bottomInset]);

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
      <button
        type="button"
        data-testid="measure-undo"
        onMouseDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          setMeasurePoints((prev) => prev.slice(0, -1));
        }}
        title={t("undoMeasurePoint")}
        aria-label={t("undoMeasurePoint")}
        className="cursor-pointer"
        style={{
          position: "absolute", top: 8, left: "50%", transform: "translateX(-50%)",
          background: "rgba(255,255,255,0.9)", borderRadius: 6, padding: "4px 12px",
          fontSize: 13, fontWeight: 600, color: "#1e3a8a", boxShadow: "0 1px 4px rgba(0,0,0,0.15)", zIndex: 10,
          display: "flex", alignItems: "center", gap: 6, border: "none",
        }}
      >
        <IconUndo className="w-4 h-4" />
        {formatDist(total)} · {measurePoints.length} pt{measurePoints.length > 1 ? "s" : ""}
      </button>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measuring, measurePoints, measureCursor, mapScale, t]);

  // ─── Render ───────────────────────────────────────────

  if (!viewport) {
    if (docState.status === "error") {
      const key = {
        offline: "mapDocumentOffline",
        unauthorised: "mapDocumentUnauthorised",
        missing: "mapDocumentMissing",
        failed: "mapDocumentFailed",
      } as const;
      return (
        <div ref={containerRef} data-testid="map-viewer" className={`relative bg-slate-50 rounded-lg border border-slate-200 ${className}`} style={style}>
          <MapLayerMessage message={t(key[docState.kind])} onRetry={retryDocument} retryLabel={t("mapRetry")} />
        </div>
      );
    }
    return (
      <div ref={containerRef} className={`flex items-center justify-center bg-slate-50 rounded-lg border border-slate-200 ${className}`} style={style}>
        <div className="text-center">
          <div className="w-8 h-8 border-3 border-blue-200 border-t-blue-600 rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm text-slate-500">{t("loadingMap")}</p>
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
  // An exclusive tool (an armed creation tool, §6) opens no action bar: it would cover the map on every click.
  if (editor && editor.actionLayout !== "host" && !editor.tool?.exclusive && menuEntries > 0 && overlayContent && !editorDragPos && !editorLabelDragPos) {
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
      const bar = editor.actionLayout === "bar";
      if (pos.x > -40 && pos.x < containerSize.w + 40 && pos.y > -20 && pos.y < containerSize.h + 20) {
        editorMenu = (
          <div
            data-testid={bar ? "editor-action-bar" : "editor-context-menu"}
            className="relative flex flex-col gap-0.5 bg-white/95 backdrop-blur-sm rounded-lg border border-slate-200 shadow-lg p-1"
            style={bar ? {
              position: "absolute",
              left: Math.max(8, Math.min(containerSize.w - 8, pos.x)),
              top: pos.y + anchorR + 10,
              transform: "translateX(-50%)",
              maxWidth: Math.max(160, containerSize.w - 16),
              zIndex: 9,
            } : {
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
            <div className={bar ? "flex flex-row flex-wrap gap-0.5 pr-7" : "contents"}>
              {editor.contextActions?.map((a) => (
                <button
                  key={a.id}
                  data-testid={`editor-action-${a.id}`}
                  onClick={a.onClick}
                  disabled={a.disabled}
                  className={`text-xs text-left ${bar ? "px-2.5" : "pl-2.5 pr-8"} py-1.5 rounded-md whitespace-nowrap transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default ${
                    a.variant === "danger"
                      ? "text-red-600 hover:bg-red-50 disabled:hover:bg-transparent"
                      : "text-slate-700 hover:bg-slate-100 disabled:hover:bg-transparent"
                  }`}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </div>
        );
      }
    }
  }

  // The lifted touch drag's stem (§10): from the finger to the control drawn above it; on the GL
  // canvas the loupe above that (§10 "Loupe"): the layer draws the magnified map into the circle,
  // `editor-loupe` is its ring and the crosshair at the drop point.
  let touchHandle: React.ReactNode = null;
  let glLoupe: VectorLoupe | null = null;
  if (touchFinger && editorDragPos && editorDragTouch) {
    const inner = mapMmToScreen(editorDragPos.x, editorDragPos.y);
    if (inner) {
      const pos = innerToContainer(inner.x, inner.y);
      touchHandle = (
        <svg data-testid="editor-touch-handle" aria-hidden className="absolute inset-0 w-full h-full pointer-events-none" style={{ zIndex: 9 }}>
          <line x1={touchFinger.x} y1={touchFinger.y} x2={pos.x} y2={pos.y} stroke="#7c3aed" strokeWidth={2} strokeDasharray="4 3" />
          <circle cx={touchFinger.x} cy={touchFinger.y} r={12} fill="rgba(124, 58, 237, 0.18)" stroke="#7c3aed" strokeWidth={1.5} />
        </svg>
      );
      if (glViewRect) {
        const c = loupePlacement(touchFinger, { width: containerSize.w, height: containerSize.h });
        const r = LOUPE_DIAMETER_PX / 2;
        glLoupe = { xUm: editorDragPos.x * 1000, yUm: editorDragPos.y * 1000, cx: c.x, cy: c.y, diameterPx: LOUPE_DIAMETER_PX, scale: LOUPE_SCALE };
        touchHandle = (
          <>
            {touchHandle}
            <div
              data-testid="editor-loupe"
              data-scale={LOUPE_SCALE}
              aria-hidden
              className="absolute pointer-events-none rounded-full border-2 border-slate-700 shadow-lg"
              style={{ left: c.x - r, top: c.y - r, width: 2 * r, height: 2 * r, zIndex: 9 }}
            >
              <svg className="absolute inset-0 w-full h-full" viewBox={`0 0 ${2 * r} ${2 * r}`}>
                <line x1={r - 14} y1={r} x2={r + 14} y2={r} stroke="#0f172a" strokeWidth={1.5} />
                <line x1={r} y1={r - 14} x2={r} y2={r + 14} stroke="#0f172a" strokeWidth={1.5} />
              </svg>
            </div>
          </>
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

  // The view's centre in WGS 84, for the data-* attributes only.
  const centreGeo = innerToGeo(viewport, vctx, renderW / 2, renderH / 2);

  return (
    <div
      ref={containerRef}
      data-testid="map-viewer"
      data-course-layer={glCourse ? "gl" : "none"}
      data-editor-hit={editor ? "shared" : undefined}
      data-center-lat={centreGeo?.lat}
      data-center-lng={centreGeo?.lng}
      data-zoom={mercatorEquivalentZoom(viewport, mapScale, centreGeo?.lat ?? null) ?? undefined}
      data-centre-x={viewport.centreX}
      data-centre-y={viewport.centreY}
      data-px-per-um={viewport.pxPerUm}
      data-rotation={rotDeg}
      data-user-bearing={userBearing}
      data-measure-points={measurePoints.length}
      data-measure-cursor={measureCursor ? "1" : "0"}
      className={`relative overflow-hidden select-none bg-white ${hideControls ? "" : "rounded-lg border border-slate-200"} ${className}`}
      style={{
        cursor: hideControls ? "default"
          : editor?.tool?.cursor && !editorDragPos ? editor.tool.cursor
          : measuring || (editor && !editorDragPos) ? "crosshair"
          : editorDragPos ? "crosshair"
          : isPanningRef.current ? "grabbing" : "grab",
        touchAction: containerTouchAction,
        ...style,
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onDoubleClick={(e) => {
        const tool = editorToolRef.current;
        if (!tool?.onDoubleClick || (e.target as HTMLElement).closest?.("button")) return;
        const p = toolPointer(e.clientX, e.clientY, e.shiftKey, e.altKey);
        if (p) tool.onDoubleClick(p);
      }}
      onContextMenu={(e) => {
        const tool = editorToolRef.current;
        if (!tool?.onContextMenu) return;
        e.preventDefault();
        const p = toolPointer(e.clientX, e.clientY, e.shiftKey, e.altKey);
        if (p) tool.onContextMenu(p);
      }}
    >
      {courseSupport === false && (
        // A document whose colour stack is not aligned cannot take the GL
        // course layer (`CourseStackError`, docs/map-rendering.md §5.4
        // "Fallback"): say so — no course is drawn until the map is re-imported.
        <div
          data-testid="map-course-layer-unsupported"
          className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center px-4"
        >
          <div className="rounded-md bg-amber-50/95 px-3 py-1 text-xs text-amber-800 shadow">
            {t("courseLayerUnsupported")}
          </div>
        </div>
      )}
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
      {/* Vector base map: container-sized and unrotated — the rotation is in its view matrix */}
      {mapDoc && glViewRect && (
        <VectorMapLayer
          doc={mapDoc}
          view={glViewRect}
          width={containerSize.w}
          height={containerSize.h}
          budget={mapBudget}
          zIndex={0}
          course={glCourse ? courseRequest : null}
          onCourse={setCourseInfo}
          onCourseSupport={setCourseSupport}
          loupe={glLoupe}
        />
      )}
      {/* Rotated UI layer (the overlay SVG) — the meridians vertical, as the canvas's view matrix */}
      <div style={{
        position: "absolute",
        inset: 0,
        transform: rotDeg !== 0 ? `rotate(${rotDeg}deg)` : undefined,
        transformOrigin: "center center",
        ...(rotDeg !== 0 ? { width: renderW, height: renderH, left: (containerSize.w - renderW) / 2, top: (containerSize.h - renderH) / 2 } : {}),
      }}>
        {/* Lower UI layer: faded controls, completion rings */}
        <svg
          data-testid="map-course-overlay-lower"
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 2 }}
          viewBox={`0 0 ${renderW} ${renderH}`}
        >
          <g style={{ pointerEvents: "auto" }}>
            {overlayContent?.lowerNodes}
          </g>
        </svg>

        {/* Upper UI layer: status rings, badges, pills, GPS, measure, editor shapes */}
        <svg
          data-testid="map-course-overlay-upper"
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 4 }}
          viewBox={`0 0 ${renderW} ${renderH}`}
        >
          <g style={{ pointerEvents: "auto" }}>
            {overlayContent?.upperNodes}
            {(() => {
              // Field mode's fix (the page's watch) wins over the locate button's own.
              const fix = editor?.fix ?? (locateMode !== "off" ? geo.position : null);
              if (!fix || !viewport) return null;
              const p = geoToInner(viewport, vctx, fix.lat, fix.lng);
              const mpp = metresPerPx(viewport, mapScale);
              if (!p || mpp == null) return null;
              const px = p.x, py = p.y;
              const radius = accuracyRadiusPx(fix.accuracy, mpp);
              return (
                <g data-testid="my-location-marker" data-accuracy-m={fix.accuracy} style={{ pointerEvents: "none" }}>
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
            {editor?.markers && editor.markers.length > 0 && viewport && (
              <g data-testid="editor-check-layer" className="pointer-events-none">
                {editor.markers.map((sh, i) => toolShapeNode(sh, i, mapMmToScreen, symbolScale))}
              </g>
            )}
            {editor?.tool?.shapes && viewport && (
              <g data-testid="editor-tool-layer" className="pointer-events-none">
                {editor.tool.shapes.map((sh, i) => toolShapeNode(sh, i, mapMmToScreen, symbolScale))}
              </g>
            )}
            {dragLegLabels.length > 0 && viewport && (
              <g className="pointer-events-none">{dragLegLabels.map((sh, i) => toolShapeNode(sh, i, mapMmToScreen, symbolScale))}</g>
            )}
          </g>
        </svg>
      </div>
      {/* Touch pin-drop (08 §5.3): the fixed centre crosshair and Place / Done. */}
      {editor?.tool?.touch && isCoarsePointer && (
        <>
          <div aria-hidden data-testid="editor-touch-crosshair" className="pointer-events-none absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2">
            <div className="w-8 h-px bg-purple-700" />
            <div className="absolute left-1/2 top-1/2 h-8 w-px -translate-x-1/2 -translate-y-1/2 bg-purple-700" />
          </div>
          <div data-testid="editor-touch-bar" className="absolute inset-x-0 bottom-3 z-30 flex justify-center gap-2 px-4"
            style={editor.bottomInsetPx ? { bottom: editor.bottomInsetPx + 12 } : undefined}>
            <button type="button" data-testid="editor-touch-place"
              className="min-h-11 px-5 rounded-full bg-purple-600 text-white text-sm font-medium shadow-lg"
              onClick={() => {
                const rect = containerRef.current?.getBoundingClientRect();
                const p = rect ? toolPointer(rect.left + rect.width / 2, rect.top + rect.height / 2, false) : null;
                if (p) editor.tool?.touch?.onPlace(p);
              }}>
              {editor.tool.touch.placeLabel}
            </button>
            <button type="button" data-testid="editor-touch-done"
              className="min-h-11 px-5 rounded-full bg-white text-slate-700 text-sm font-medium border border-slate-300 shadow-lg"
              onClick={() => editor.tool?.touch?.onDone()}>
              {editor.tool.touch.doneLabel}
            </button>
          </div>
        </>
      )}
      {/* The GL course layer's numbers and legs as DOM, for tests: what the canvas draws. */}
      {glCourse && courseInfo?.derivation && (
        <ul data-testid="course-layer" hidden>
          {courseInfo.derivation.sites.map((ds) => (
            <li key={`s-${ds.id}`} data-testid="course-site" data-site-id={ds.id} data-role={ds.role} data-x={ds.x} data-y={ds.y}
              data-cuts={ds.cuts.map((g) => `${g.start}-${g.end}`).join(" ")}>
              {ds.label && (
                <span data-testid="course-label" data-site-id={ds.id} data-text={ds.label.text} data-x={ds.label.x} data-y={ds.label.y}>
                  {ds.label.text}
                </span>
              )}
            </li>
          ))}
          {courseInfo.derivation.courses.flatMap((dc) => dc.legs.flatMap((leg, i) => leg.pieces.map((piece, k) => (
            <li key={`l-${dc.id}-${i}-${k}`} data-testid="course-leg" data-course={dc.id} data-leg={i} data-style={leg.style}
              data-points={piece.map((q) => `${q.x},${q.y}`).join(" ")} />
          ))))}
        </ul>
      )}

      {/* Shared hit-testing has no DOM targets: every editor site as DOM, for tests (docs/course-editor.md §5). */}
      {editor && (
        <ul data-testid="editor-sites" hidden>
          {controls.filter((c) => c.visible !== false && (c.x !== 0 || c.y !== 0)).map((c) => {
            const pend = pendingMoves.get(c.id);
            const at = editorDragPos?.id === c.id ? editorDragPos
              : pend && Math.abs(c.x - pend.from.x) < 1e-9 && Math.abs(c.y - pend.from.y) < 1e-9 ? pend.to : c;
            return <li key={c.id} data-testid="editor-site" data-control-id={c.id} data-control-code={c.code} data-type={c.type} data-x={at.x} data-y={at.y} />;
          })}
        </ul>
      )}
      {/* Editor contextual actions — unrotated HTML, anchored at the
          selection/phantom */}
      {editorMenu}
      {dragWarning}
      {touchHandle}

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
          position: "absolute", bottom: 12 + bottomInset, right: 12, flexDirection: "column", gap: 4, zIndex: 10,
          display: bottomInset > 0 && bottomInset > containerSize.h - 280 ? "none" : "flex",
        }}>
          <button
            type="button"
            onClick={() => {
              breakLocateFollow();
              setViewport((prev) => prev ? zoomAt(prev, vctxRef.current, renderW / 2, renderH / 2, 0.5) : prev);
            }}
            className="w-8 h-8 bg-white rounded shadow hover:bg-slate-50 flex items-center justify-center text-slate-600"
            title={t("zoomIn")}
            aria-label={t("zoomIn")}
          >
            <IconZoomIn className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              breakLocateFollow();
              setViewport((prev) => prev ? zoomAt(prev, vctxRef.current, renderW / 2, renderH / 2, -0.5) : prev);
            }}
            className="w-8 h-8 bg-white rounded shadow hover:bg-slate-50 flex items-center justify-center text-slate-600"
            title={t("zoomOut")}
            aria-label={t("zoomOut")}
          >
            <IconZoomOut className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              fitWholeMap();
            }}
            className="w-8 h-8 bg-white rounded shadow hover:bg-slate-50 flex items-center justify-center text-slate-600"
            title={t("fitMap")}
            aria-label={t("fitMap")}
          >
            <IconFitView className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              setMeasuring((prev) => {
                if (prev) { setMeasurePoints([]); setMeasureCursor(null); }
                return !prev;
              });
            }}
            className={`w-8 h-8 rounded shadow flex items-center justify-center ${measuring ? "bg-blue-500 text-white" : "bg-white hover:bg-slate-50 text-slate-600"}`}
            title={t("measureDistance")}
            aria-label={measuring ? t("exitMeasure") : t("measureDistance")}
            aria-pressed={measuring}
          >
            <IconRuler className="w-4 h-4" />
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
            <IconLocate className="w-4 h-4" />
          </button>
          {/* Compass — three states: rotated (tap resets to north up),
              unlocked at north up (tap locks), locked (tap unlocks).
              Locked is the default: an accidental two-finger twist while
              pinch-zooming must not turn the map. */}
          <button
            type="button"
            data-testid="map-compass"
            data-rotation-locked={rotationLocked ? "1" : "0"}
            onClick={() => {
              if (userBearing !== 0) {
                setUserBearing(0);
                return;
              }
              persistRotationLock(!rotationLocked);
            }}
            className={`w-8 h-8 rounded shadow flex items-center justify-center ${
              rotationLocked
                ? "bg-white hover:bg-slate-50 text-slate-600"
                : "bg-blue-100 hover:bg-blue-200 text-blue-600"
            }`}
            title={
              userBearing !== 0
                ? t("compassReset")
                : rotationLocked
                  ? t("compassLocked")
                  : t("compassUnlocked")
            }
            aria-label={
              userBearing !== 0
                ? t("compassReset")
                : rotationLocked
                  ? t("compassLocked")
                  : t("compassUnlocked")
            }
            aria-pressed={!rotationLocked}
          >
            <span
              className="relative flex items-center justify-center"
              style={{
                transform:
                  userBearing !== 0 ? `rotate(${userBearing}deg)` : undefined,
              }}
            >
              <IconCompass className="w-4 h-4" />
              {rotationLocked && (
                <svg
                  aria-hidden="true"
                  className="absolute -right-1.5 -bottom-1.5 h-2.5 w-2.5 text-slate-500"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path
                    fillRule="evenodd"
                    d="M10 1a4.5 4.5 0 0 0-4.5 4.5V9H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-.5V5.5A4.5 4.5 0 0 0 10 1Zm3 8V5.5a3 3 0 1 0-6 0V9h6Z"
                    clipRule="evenodd"
                  />
                </svg>
              )}
            </span>
          </button>
          {onToggleFullscreen && (
            <button
              type="button"
              onClick={onToggleFullscreen}
              className="w-8 h-8 bg-white rounded shadow hover:bg-slate-50 flex items-center justify-center text-slate-600"
              title={isFullscreen ? t("exitFullscreen") : t("enterFullscreen")}
              aria-label={isFullscreen ? t("exitFullscreen") : t("enterFullscreen")}
            >
              {isFullscreen ? (
                <IconFullscreenExit className="w-4 h-4" />
              ) : (
                <IconFullscreenEnter className="w-4 h-4" />
              )}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Description sheet renderer ────────────────────────────

function renderDescriptionSheet(
  symbolScale: number,
  cw: number,
  ch: number,
  /** The highlighted courses. 1 → sequence card; >1 → code-sorted union. */
  activeCourses?: Array<Pick<CourseOverlay, "name" | "controls" | "classNames" | "lengthM" | "climbM" | "orderMode" | "descriptionInstructions">>,
  /** All control overlays — resolve id → code / type / description. */
  controlOverlays?: ControlOverlay[],
  /** List every positioned control from the overlays instead of a course card (no course active). */
  allControlsMode = false,
  /** Localized title for the all-controls listing. */
  allControlsTitle?: string,
  sheetContext: {
    /** Event name for header row 1 of a single-course sheet. */
    eventName?: string;
    /** Map scale (1:N) — turns the last-control → finish leg into metres. */
    mapScale?: number | null;
  } = {},
): React.ReactNode | null {
  if ((activeCourses?.length ?? 0) === 0 && !allControlsMode) return null;

  /** Resolve one course-control id to a row (null for start/finish). */
  const toRow = (cid: string): { code: string; description?: unknown } | null => {
    // Look up overlay first: it tells us the type so we can skip start/finish.
    const overlay = controlOverlays?.find((o) => o.id === cid);
    if (overlay && overlay.type !== "Control") return null;
    // The overlay's code; the course's own id when no overlay knows it.
    return { code: String(overlay?.code ?? cid), description: overlay?.description ?? undefined };
  };

  const byCodeAsc = (a: { code: string }, b: { code: string }) =>
    a.code.localeCompare(b.code, undefined, { numeric: true });

  // Build the rows. One course → its ordered control list with sequence
  // numbers (a proper course card). Several courses → the code-sorted
  // UNION of all their controls, without sequence numbers (there is no
  // shared sequence, and the map keeps showing codes). No course → every
  // positioned control (`allControlsMode`).
  type Row = {
    code: string;
    description?: unknown;
    sequence?: number;
    kind?: string;
    symbolKey?: string;
    lengthM?: number;
  };
  const rows: Row[] = [];
  const single = activeCourses?.length === 1 ? activeCourses[0] : null;
  // Free-order sheets keep the A-column empty (codes only).
  const withSequence = single !== null && single.orderMode !== "free_order";
  let title = "";
  let headerRows = 1;
  let sheetHeader: {
    eventName: string;
    classNames: string;
    courseName: string;
    lengthKm: string;
    climbM: string;
  } | null = null;

  if (single) {
    title = single.name;
    // Prefer the full IOF sheet (start + specials + finish + 3-row header)
    // when we have course metadata; otherwise fall back to control rows only.
    const controlRows: Array<{
      id: number;
      code: string;
      description?: unknown;
    }> = [];
    for (const cid of single.controls) {
      const overlay = controlOverlays?.find((o) => o.id === cid);
      if (overlay && overlay.type !== "Control") continue;
      const row = toRow(cid);
      if (!row) continue;
      const idNum = Number.parseInt(String(overlay?.code ?? cid), 10);
      controlRows.push({
        id: Number.isFinite(idNum) ? idNum : controlRows.length + 1,
        code: row.code,
        description: row.description,
      });
    }
    const startOverlay = controlOverlays?.find(
      (o) => o.type === "Start" && single.controls.includes(o.id),
    );
    // Last control → finish in terrain metres, from the overlay positions
    // (map mm) and the map scale. Only when the course actually ends at a
    // finish control.
    let finishLengthM: number | null = null;
    const finishOverlay = controlOverlays?.find(
      (o) => o.type === "Finish" && single.controls.includes(o.id),
    );
    if (finishOverlay && sheetContext.mapScale) {
      const lastId = [...single.controls]
        .reverse()
        .find((cid) => controlOverlays?.find((o) => o.id === cid)?.type === "Control");
      const last = lastId ? controlOverlays?.find((o) => o.id === lastId) : undefined;
      if (last) {
        const mm = Math.hypot(finishOverlay.x - last.x, finishOverlay.y - last.y);
        finishLengthM = (mm * sheetContext.mapScale) / 1000;
      }
    }
    const sheet = buildDescriptionSheet({
      // Course name stands in when the caller has no event name yet.
      eventName: sheetContext.eventName || single.name,
      classNames: single.classNames ?? [],
      courseName: single.name,
      lengthM: single.lengthM ?? 0,
      climbM: single.climbM ?? 0,
      orderMode: single.orderMode ?? "ordered",
      startDescription: startOverlay?.description ?? null,
      controls: controlRows.map((c) => ({
        id: c.id,
        code: c.code,
        description: c.description as never,
      })),
      instructions: single.descriptionInstructions ?? null,
      finishLengthM,
    });
    sheetHeader = sheet.header;
    headerRows = 3;
    for (const r of sheet.rows as DescriptionSheetRow[]) {
      rows.push({
        code: r.code,
        description: r.description,
        sequence: r.sequence,
        kind: r.kind,
        symbolKey: r.symbolKey,
        lengthM: r.lengthM,
      });
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
      byCode.set(code, { code, description: o.description ?? undefined });
    }
    rows.push(...[...byCode.values()].sort(byCodeAsc));
  }

  if (rows.length === 0) return null;

  // IOF standard: 8 columns (A=seq, B=code, C–H=description symbols)
  const cellSize = Math.max(20, Math.min(36, 7 * symbolScale));
  const cols = 8;
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
    // IOF sheet rules: thick outer border and header cells, thick rule
    // under the start row and above the finish row (the control rows sit
    // boxed in between), thick verticals after columns C and F
    // (A B C | D E F | G H). Everything else thin. No shaded header —
    // bold text and the rules do the separating.
    const THIN = 0.5;
    const THICK = 1.5;
    const RULE = "#64748b";
    elements.push(
      <rect key={`desc-bg-${bi}`} x={sheetX} y={sheetY} width={sheetW} height={sheetH}
        fill="white" stroke={RULE} strokeWidth={THICK} rx={2} />
    );

    if (sheetHeader) {
      const h = sheetHeader;
      if (bi === 0) {
        const fs1 = Math.min(cellSize * 0.42, (sheetW - 8) / Math.max(1, h.eventName.length * 0.6));
        const fs2 = Math.min(cellSize * 0.38, (sheetW - 8) / Math.max(1, h.classNames.length * 0.6));
        elements.push(
          <text key="desc-title" x={sheetX + sheetW / 2} y={sheetY + cellSize * 0.5}
            textAnchor="middle" dominantBaseline="central"
            fontSize={fs1} fill="#0f172a" fontWeight="bold" data-testid="desc-title">
            {h.eventName}
          </text>,
          <text key="desc-classes" x={sheetX + sheetW / 2} y={sheetY + cellSize * 1.5}
            textAnchor="middle" dominantBaseline="central"
            fontSize={fs2} fill="#0f172a" fontWeight="bold" data-testid="desc-classes">
            {h.classNames}
          </text>,
          <line key="desc-h3a" x1={sheetX + cellSize * 3} y1={sheetY + cellSize * 2}
            x2={sheetX + cellSize * 3} y2={sheetY + cellSize * 3} stroke={RULE} strokeWidth={THICK} />,
          <line key="desc-h3b" x1={sheetX + cellSize * 6} y1={sheetY + cellSize * 2}
            x2={sheetX + cellSize * 6} y2={sheetY + cellSize * 3} stroke={RULE} strokeWidth={THICK} />,
          <text key="desc-course" x={sheetX + cellSize * 1.5} y={sheetY + cellSize * 2.5}
            textAnchor="middle" dominantBaseline="central"
            fontSize={cellSize * 0.38} fill="#0f172a" fontWeight="bold" data-testid="desc-course-name">
            {h.courseName}
          </text>,
          <text key="desc-length" x={sheetX + cellSize * 4.5} y={sheetY + cellSize * 2.5}
            textAnchor="middle" dominantBaseline="central"
            fontSize={cellSize * 0.38} fill="#0f172a" fontWeight="bold" data-testid="desc-length">
            {h.lengthKm}
          </text>,
          <text key="desc-climb" x={sheetX + cellSize * 7} y={sheetY + cellSize * 2.5}
            textAnchor="middle" dominantBaseline="central"
            fontSize={cellSize * 0.38} fill="#0f172a" fontWeight="bold" data-testid="desc-climb">
            {h.climbM}
          </text>,
        );
      }
    } else if (title && bi === 0) {
      const titleFs = Math.min(cellSize * 0.5, (sheetW - 8) / (title.length * 0.62));
      elements.push(
        <text key="desc-title" x={sheetX + sheetW / 2} y={sheetY + cellSize * 0.5}
          textAnchor="middle" dominantBaseline="central"
          fontSize={titleFs} fill="#0f172a" fontWeight="bold" data-testid="desc-title">
          {title}
        </text>,
      );
    }

    // Alternate row shading, under the grid so the rules stay crisp.
    for (let i = 0; i < blockRows.length; i++) {
      const n = bi * rowsPerBlock + i;
      if (n % 2 !== 1) continue;
      const top = sheetY + (headerRows + i) * cellSize;
      elements.push(
        <rect key={`desc-row-bg-${n}`} x={sheetX + 0.5} y={top + 0.5}
          width={sheetW - 1} height={cellSize - 1} fill="#f8fafc" />,
      );
    }

    // Horizontal rules: every header rule thick; below the rows thick only
    // under start and above finish (evaluated against the whole sheet so a
    // block split right before the finish row still gets its rule).
    const allRows = rows as unknown as DescriptionSheetRow[];
    for (let r = 0; r <= totalRows; r++) {
      const rowIdx = bi * rowsPerBlock + (r - headerRows - 1); // row whose bottom edge this is
      const thick =
        r <= headerRows ||
        (r > headerRows && r < totalRows && hasThickRuleBelow(allRows, rowIdx));
      elements.push(
        <line key={`desc-hr-${bi}-${r}`} x1={sheetX} y1={sheetY + r * cellSize}
          x2={sheetX + sheetW} y2={sheetY + r * cellSize}
          stroke={thick ? RULE : "#cbd5e1"} strokeWidth={thick ? THICK : THIN}
          data-testid={thick && r > headerRows && r < totalRows ? "desc-thick-rule" : undefined} />
      );
    }
    // Column dividers per row — thick after C and F, none on full-width
    // special / finish rows.
    for (let i = 0; i < blockRows.length; i++) {
      const kind = blockRows[i].kind;
      if (kind === "special" || kind === "finish") continue;
      const top = sheetY + (headerRows + i) * cellSize;
      for (let c = 1; c < cols; c++) {
        const thick = DESCRIPTION_THICK_COLUMNS.includes(c);
        elements.push(
          <line key={`desc-vr-${bi}-${i}-${c}`} x1={sheetX + c * cellSize} y1={top}
            x2={sheetX + c * cellSize} y2={top + cellSize}
            stroke={thick ? RULE : "#cbd5e1"} strokeWidth={thick ? THICK : THIN} />
        );
      }
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

/** One block of description rows (code + IOF symbol cells C–H). */
function renderDescriptionRows(
  elements: React.ReactNode[],
  rows: Array<{
    code: string;
    description?: unknown;
    sequence?: number;
    kind?: string;
    symbolKey?: string;
    lengthM?: number;
  }>,
  /** Index of the first row within the whole sheet (column A numbering). */
  rowOffset: number,
  withSequence: boolean,
  geom: { sheetX: number; sheetY: number; sheetW: number; cellSize: number; headerRows: number },
): void {
  const { sheetX, sheetY, sheetW, cellSize, headerRows } = geom;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const code = row.code;
    const desc = row.description as
      | { c?: string; d?: string; e?: string; g?: string; s?: string; f?: string; h?: string }
      | undefined;
    const n = rowOffset + i;
    const ry = sheetY + (i + headerRows) * cellSize;
    const fs = cellSize * 0.45;

    // Special / finish rows: full-width symbol spanning columns A–H.
    if (row.kind === "special" || row.kind === "finish" || row.kind === "start") {
      const key = row.symbolKey ?? (row.kind === "start" ? "start" : undefined);
      if (key && IOF_SYMBOLS[key]) {
        // Start: triangle in column A, optional C–H description.
        if (row.kind === "start") {
          elements.push(
            <svg key={`desc-start-${n}`} x={sheetX + 1} y={ry + 1}
              width={cellSize - 2} height={cellSize - 2}
              viewBox="-100 -100 200 200"
              dangerouslySetInnerHTML={{ __html: IOF_SYMBOLS.start }} />,
          );
          if (desc) {
            const cells = descriptionCells(desc, "#c026d3");
            const order = ["C", "D", "E", "F", "G", "H"] as const;
            order.forEach((col, ci) => {
              const cell = cells[col];
              if (!cell) return;
              const sx = sheetX + (ci + 2) * cellSize;
              if (cell.kind === "text") {
                elements.push(
                  <text key={`desc-sym-${n}-${ci}`} x={sx + cellSize * 0.5} y={ry + cellSize * 0.5}
                    textAnchor="middle" dominantBaseline="central" fontSize={fs * 0.85} fill="#475569">
                    {cell.text}
                  </text>,
                );
              } else {
                elements.push(
                  <svg key={`desc-sym-${n}-${ci}`} x={sx + 1} y={ry + 1}
                    width={cellSize - 2} height={cellSize - 2}
                    viewBox="-100 -100 200 200"
                    dangerouslySetInnerHTML={{ __html: cell.svg }} />,
                );
              }
            });
          }
          continue;
        }
        // Special / finish: symbol drawn across the full width with optional length.
        elements.push(
          <svg key={`desc-wide-${n}`} x={sheetX + 2} y={ry + 2}
            width={sheetW - 4} height={cellSize - 4}
            viewBox="-800 -100 1600 200"
            preserveAspectRatio="xMidYMid meet"
            dangerouslySetInnerHTML={{ __html: IOF_SYMBOLS[key] }} />,
        );
        if (row.lengthM != null && row.lengthM > 0) {
          elements.push(
            <text key={`desc-len-${n}`} x={sheetX + sheetW / 2} y={ry + cellSize * 0.55}
              textAnchor="middle" dominantBaseline="central"
              fontSize={fs * 0.9} fill="#1e293b" fontWeight="bold"
              data-testid="desc-row-length">
              {`${Math.round(row.lengthM)} m`}
            </text>,
          );
        }
        continue;
      }
    }

    if (withSequence && row.sequence != null) {
      elements.push(
        <text key={`desc-seq-${n}`} x={sheetX + cellSize * 0.5} y={ry + cellSize * 0.5}
          textAnchor="middle" dominantBaseline="central" fontSize={fs} fill="#475569">
          {row.sequence}
        </text>,
      );
    } else if (withSequence && !row.kind) {
      elements.push(
        <text key={`desc-seq-${n}`} x={sheetX + cellSize * 0.5} y={ry + cellSize * 0.5}
          textAnchor="middle" dominantBaseline="central" fontSize={fs} fill="#475569">
          {n + 1}
        </text>,
      );
    }
    elements.push(
      <text key={`desc-code-${n}`} x={sheetX + cellSize * 1.5} y={ry + cellSize * 0.5}
        textAnchor="middle" dominantBaseline="central" fontSize={fs} fill="#1e293b" fontWeight="bold"
        data-testid="desc-row-code" data-code={code}>
        {code}
      </text>,
    );

    if (!desc) continue;
    const cells = descriptionCells(desc, "#c026d3");
    const order = ["C", "D", "E", "F", "G", "H"] as const;
    order.forEach((col, ci) => {
      const cell = cells[col];
      if (!cell) return;
      const sx = sheetX + (ci + 2) * cellSize;
      if (cell.kind === "text") {
        elements.push(
          <text key={`desc-sym-${n}-${ci}`} x={sx + cellSize * 0.5} y={ry + cellSize * 0.5}
            textAnchor="middle" dominantBaseline="central" fontSize={fs * 0.85} fill="#475569">
            {cell.text}
          </text>,
        );
      } else {
        elements.push(
          <svg key={`desc-sym-${n}-${ci}`} x={sx + 1} y={ry + 1}
            width={cellSize - 2} height={cellSize - 2}
            viewBox="-100 -100 200 200"
            dangerouslySetInnerHTML={{ __html: cell.svg }} />,
        );
      }
    });
  }
}

/** One tool shape (docs/course-editor.md §6) in the rotated overlay's inner px; `pxPerMm` sizes true-size circles. */
function toolShapeNode(
  sh: ToolShape,
  key: number,
  project: (x: number, y: number) => { x: number; y: number } | null,
  pxPerMm: number,
): ReactNode {
  const color = ("color" in sh && sh.color) || "#7c3aed";
  const data = "data" in sh && sh.data ? Object.fromEntries(Object.entries(sh.data).map(([k, v]) => [`data-${k}`, v])) : {};
  switch (sh.kind) {
    case "circle": {
      const p = project(sh.x, sh.y);
      if (!p) return null;
      return <circle key={key} cx={p.x} cy={p.y} r={Math.max(2, sh.rMm * pxPerMm)} fill={sh.fill ?? "none"} stroke={color}
        strokeWidth={1.5} strokeDasharray={sh.dashed ? "4 3" : undefined} data-testid={sh.testId} data-x={sh.x} data-y={sh.y} {...data} />;
    }
    case "line": {
      const pts = sh.points.map((q) => project(q.x, q.y)).filter((q): q is { x: number; y: number } => q !== null);
      if (pts.length < 2) return null;
      const d = pts.map((q, i) => `${i ? "L" : "M"}${q.x.toFixed(1)},${q.y.toFixed(1)}`).join("") + (sh.closed ? "Z" : "");
      return <path key={key} d={d} fill={sh.fill ?? "none"} stroke={color} strokeWidth={sh.widthPx ?? 1.5}
        strokeDasharray={sh.dashed ? "5 4" : undefined} strokeLinejoin="round" data-testid={sh.testId}
        data-points={sh.points.map((q) => `${q.x},${q.y}`).join(" ")} {...data} />;
    }
    case "handle": {
      const p = project(sh.x, sh.y);
      if (!p) return null;
      return <rect key={key} x={p.x - 4} y={p.y - 4} width={8} height={8} fill={sh.active ? "#7c3aed" : "#ffffff"} stroke="#7c3aed"
        strokeWidth={1.5} data-testid={sh.testId} data-x={sh.x} data-y={sh.y} {...data} />;
    }
    case "grip": {
      const p = project(sh.x, sh.y), q = project(sh.from.x, sh.from.y);
      if (!p || !q) return null;
      return (
        <g key={key}>
          <line x1={q.x} y1={q.y} x2={p.x} y2={p.y} stroke="#7c3aed" strokeWidth={1} />
          <circle cx={p.x} cy={p.y} r={3.5} fill="#ffffff" stroke="#7c3aed" strokeWidth={1.5} data-testid={sh.testId} data-x={sh.x} data-y={sh.y} {...data} />
        </g>
      );
    }
    case "text": {
      const p = project(sh.x, sh.y);
      if (!p) return null;
      return <text key={key} x={p.x + (sh.dxPx ?? 0)} y={p.y + (sh.dyPx ?? 0)} fill={color} fontSize={12} fontWeight={600}
        paintOrder="stroke" stroke="#ffffff" strokeWidth={3} data-testid={sh.testId}>{sh.text}</text>;
    }
    case "image": {
      // A unit image under the affine map of its three projected corners: scale, rotation and the y flip in one.
      const o = project(sh.topLeft.x, sh.topLeft.y), u = project(sh.topRight.x, sh.topRight.y), v = project(sh.bottomLeft.x, sh.bottomLeft.y);
      if (!o || !u || !v) return null;
      const m = [u.x - o.x, u.y - o.y, v.x - o.x, v.y - o.y, o.x, o.y].map((n) => n.toFixed(3)).join(" ");
      return <image key={key} href={sh.href} x={0} y={0} width={1} height={1} preserveAspectRatio="none" transform={`matrix(${m})`}
        data-testid={sh.testId} {...data} />;
    }
  }
}
