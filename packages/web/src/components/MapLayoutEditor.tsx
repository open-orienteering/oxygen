/* eslint-disable react-hooks/refs -- pointer handlers access dragRef only after an event starts */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
  IOF_SYMBOLS,
  MAP_TEXT_PLACEHOLDERS,
  courseMapObjectPageBounds,
  descriptionBlockSize,
  expandMapText,
  getPaperDimensions,
  isWhiteoutObject,
  mapToPage,
  outOfBoundsPatternDef,
  pageToMap,
  pathData,
  printablePageRect,
  rectInside,
  renderCourseOverlaySvg,
  renderDescriptionBlockSvg,
  windowRotationDeg,
  type CourseMapDocument,
  type CourseMapObject,
  type CourseOverlayLeg,
  type DescriptionBlockSettings,
  type DescriptionRow,
  type DescriptionSheetHeader,
  type MapFillMode,
  type MapFontFamily,
  type MapPoint,
  type MapRect,
  type MapTextValues,
  type MapWindow,
  type PathVertex,
} from "@oxygen/shared";
import { EditorHelp } from "./EditorHelp";
import {
  IconFullscreenEnter,
  IconFullscreenExit,
} from "./map-icons";
import { fileToBase64 } from "../lib/file-to-base64";
import {
  constrainDescription,
  constrainMapObject,
  createImageObjectAt,
  createObjectAt,
  displayedPreviewPlacement,
  editorPreviewDpi,
  initialEditorViewport,
  insertPolygonVertex,
  panEditorViewport,
  pinchEditorViewport,
  pageDeltaToObject,
  parseClampedNumberDraft,
  removePolygonVertex,
  resizeMapObject,
  translateMapObject,
  updatePolygonHandle,
  zoomEditorViewport,
  type EditorViewport,
  type ResizeHandle,
} from "../lib/map-layout-editor";
import { trpc } from "../lib/trpc";
import { useMediaQuery } from "../hooks/useMediaQuery";

type EditorTool =
  | "select"
  | "pan"
  | "text"
  | "line"
  | "rectangle"
  | "path";

type PanelId = "tools" | "page" | "graphics" | "objects" | "properties";

interface EditorSnapshot {
  center: MapPoint;
  printScale: number;
  description: DescriptionBlockSettings;
  objects: CourseMapObject[];
  templateObjects: CourseMapObject[];
}

interface MapLayoutEditorProps {
  mode?: "map" | "template";
  nameId: string;
  mapName: string;
  document: CourseMapDocument;
  window: MapWindow;
  controls: Array<{
    id: string;
    code: string;
    type: "start" | "control" | "finish";
    cuts?: Array<{ start: number; end: number }>;
    x: number;
    y: number;
  }>;
  legs: CourseOverlayLeg[];
  allControls?: boolean;
  mapObjects: CourseMapObject[];
  templateObjects: CourseMapObject[];
  textValues: MapTextValues;
  /** Real control-description rows for the previewed course. */
  descriptionRows?: DescriptionRow[];
  /** Title row of the description block (course name in print). */
  descriptionTitle?: string;
  /** IOF 3-row header (course maps); replaces the single title row. */
  descriptionHeader?: DescriptionSheetHeader | null;
  previewCourses?: Array<{ id: number; name: string }>;
  previewCourseId?: number;
  onPreviewCourseChange?: (courseId: number | undefined) => void;
  templateEditHref?: string;
  onSave: (snapshot: EditorSnapshot) => Promise<void>;
  onClose: () => void;
}

interface HistoryState {
  past: EditorSnapshot[];
  present: EditorSnapshot;
  future: EditorSnapshot[];
}

function cloneSnapshot(value: EditorSnapshot): EditorSnapshot {
  return structuredClone(value);
}

function objectPoint(
  anchor: CourseMapObject["anchor"],
  point: MapPoint,
  frame: CourseMapDocument["mapFrame"],
  window: MapWindow,
): MapPoint {
  return anchor === "map" ? mapToPage(point, frame, window) : point;
}

function objectSize(
  anchor: CourseMapObject["anchor"],
  width: number,
  height: number,
  frame: CourseMapDocument["mapFrame"],
  window: MapWindow,
) {
  return anchor === "map"
    ? {
        width: (width / window.width) * frame.width,
        height: (height / window.height) * frame.height,
      }
    : { width, height };
}

function pathVerticesForPage(
  object: Extract<CourseMapObject, { kind: "path" }>,
  frame: CourseMapDocument["mapFrame"],
  window: MapWindow,
): PathVertex[] {
  return object.points.map((vertex) => {
    const point = objectPoint(object.anchor, vertex, frame, window);
    const handle = (offset: MapPoint | undefined) => {
      if (!offset) return undefined;
      if (object.anchor === "page") return offset;
      const control = mapToPage(
        { x: vertex.x + offset.x, y: vertex.y + offset.y },
        frame,
        window,
      );
      return { x: control.x - point.x, y: control.y - point.y };
    };
    return {
      ...point,
      hIn: handle(vertex.hIn),
      hOut: handle(vertex.hOut),
    };
  });
}

function objectBounds(
  object: CourseMapObject,
  frame: CourseMapDocument["mapFrame"],
  window: MapWindow,
): { x: number; y: number; width: number; height: number } {
  if (object.kind === "text") {
    const point = objectPoint(
      object.anchor,
      { x: object.x, y: object.y },
      frame,
      window,
    );
    return {
      x: point.x,
      y: point.y - object.fontSizeMm,
      width: object.maxWidthMm ?? Math.max(8, object.text.length * object.fontSizeMm * 0.55),
      height: object.fontSizeMm * 1.25,
    };
  }
  if (object.kind === "line") {
    const a = objectPoint(
      object.anchor,
      { x: object.x1, y: object.y1 },
      frame,
      window,
    );
    const b = objectPoint(
      object.anchor,
      { x: object.x2, y: object.y2 },
      frame,
      window,
    );
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      width: Math.max(1, Math.abs(a.x - b.x)),
      height: Math.max(1, Math.abs(a.y - b.y)),
    };
  }
  if (object.kind === "path") {
    const points = object.points.map((point) =>
      objectPoint(object.anchor, point, frame, window),
    );
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    return {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(1, Math.max(...xs) - Math.min(...xs)),
      height: Math.max(1, Math.max(...ys) - Math.min(...ys)),
    };
  }
  const topLeft =
    object.anchor === "map"
      ? mapToPage(
          { x: object.x, y: object.y + object.height },
          frame,
          window,
        )
      : { x: object.x, y: object.y };
  const size = objectSize(
    object.anchor,
    object.width,
    object.height,
    frame,
    window,
  );
  return { ...topLeft, ...size };
}

function objectResizeHandles(
  object: CourseMapObject,
  bounds: MapRect,
  frame: CourseMapDocument["mapFrame"],
  window: MapWindow,
): Array<MapPoint & { handle: ResizeHandle }> {
  if (object.kind === "line") {
    return [
      {
        ...objectPoint(
          object.anchor,
          { x: object.x1, y: object.y1 },
          frame,
          window,
        ),
        handle: "start",
      },
      {
        ...objectPoint(
          object.anchor,
          { x: object.x2, y: object.y2 },
          frame,
          window,
        ),
        handle: "end",
      },
    ];
  }
  if (object.kind === "path") {
    return object.points.map((point, index) => ({
      ...objectPoint(object.anchor, point, frame, window),
      handle: `vertex-${index}`,
    }));
  }
  return [
    { x: bounds.x, y: bounds.y, handle: "nw" },
    { x: bounds.x + bounds.width, y: bounds.y, handle: "ne" },
    { x: bounds.x, y: bounds.y + bounds.height, handle: "sw" },
    {
      x: bounds.x + bounds.width,
      y: bounds.y + bounds.height,
      handle: "se",
    },
  ];
}

/**
 * Collapsible floating card, styled after the course editor's inventory and
 * course panels so the whole editing experience stays coherent. All cards
 * default to collapsed header bars on mobile so the canvas stays visible.
 */
function EditorPanel({
  id,
  title,
  open,
  onToggle,
  children,
}: {
  id: PanelId;
  title: string;
  open: boolean;
  onToggle: (panel: PanelId) => void;
  children: ReactNode;
}) {
  return (
    <section
      data-testid={`map-panel-${id}`}
      className="pointer-events-auto flex min-h-0 shrink-0 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white/95 shadow-sm backdrop-blur-sm"
    >
      <button
        type="button"
        data-testid={`map-panel-${id}-toggle`}
        onClick={() => onToggle(id)}
        className="flex shrink-0 items-center justify-between gap-2 px-3 py-2 text-left text-xs font-semibold text-slate-700"
      >
        {title}
        <span className="text-slate-400">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="min-h-0 overflow-y-auto px-3 pb-3 text-xs">
          {children}
        </div>
      )}
    </section>
  );
}

const FONT_STACKS: Record<MapFontFamily, string> = {
  sans: "Liberation Sans, Arial, sans-serif",
  serif: "Liberation Serif, Times New Roman, serif",
  mono: "Liberation Mono, Courier New, monospace",
  condensed: "Liberation Sans Narrow, Arial Narrow, sans-serif",
};

function renderObject(
  object: CourseMapObject,
  frame: CourseMapDocument["mapFrame"],
  window: MapWindow,
  onPointerDown?: (event: ReactPointerEvent<SVGElement>) => void,
  graphicHref?: (graphicId: number) => string,
  purple = "#a626ff",
): ReactNode {
  const common = {
    "data-object-id": object.id,
    "data-map-editor-target": onPointerDown ? "true" : undefined,
    onPointerDown,
    className: onPointerDown ? "cursor-move" : undefined,
    pointerEvents: onPointerDown ? ("bounding-box" as const) : undefined,
    style: onPointerDown
      ? ({ touchAction: "none", userSelect: "none" } as const)
      : undefined,
  };
  if (object.kind === "image") {
    const bounds = objectBounds(object, frame, window);
    // Mirror the shared print renderer: crop window as a unit-box viewBox,
    // stretched into the frame. Without this, Shift-crop looks like plain
    // scaling in the editor even though the export crops correctly.
    const crop = object.crop ?? { x: 0, y: 0, width: 1, height: 1 };
    return (
      <svg
        key={object.id}
        {...common}
        x={bounds.x}
        y={bounds.y}
        width={bounds.width}
        height={bounds.height}
        viewBox={`${crop.x} ${crop.y} ${crop.width} ${crop.height}`}
        preserveAspectRatio="none"
      >
        <image
          x={0}
          y={0}
          width={1}
          height={1}
          href={graphicHref?.(object.graphicId) ?? undefined}
          preserveAspectRatio="none"
        />
      </svg>
    );
  }
  if (object.kind === "text") {
    const point = objectPoint(
      object.anchor,
      { x: object.x, y: object.y },
      frame,
      window,
    );
    return (
      <text
        key={object.id}
        {...common}
        x={point.x}
        y={point.y}
        fill={object.color}
        fontSize={object.fontSizeMm}
        fontFamily={FONT_STACKS[object.fontFamily ?? "sans"]}
        textAnchor={
          object.align === "center"
            ? "middle"
            : object.align === "right"
              ? "end"
              : "start"
        }
      >
        {object.text}
      </text>
    );
  }
  if (object.kind === "line") {
    const a = objectPoint(
      object.anchor,
      { x: object.x1, y: object.y1 },
      frame,
      window,
    );
    const b = objectPoint(
      object.anchor,
      { x: object.x2, y: object.y2 },
      frame,
      window,
    );
    return (
      <line
        key={object.id}
        {...common}
        x1={a.x}
        y1={a.y}
        x2={b.x}
        y2={b.y}
        stroke={object.stroke}
        strokeWidth={object.strokeWidthMm}
      />
    );
  }
  if (object.kind === "path") {
    const vertices = pathVerticesForPage(object, frame, window);
    const fillMode = object.fillMode ?? "none";
    const patternId = fillMode === "outOfBounds" ? `oob-${object.id}` : null;
    const fill =
      fillMode === "whiteout"
        ? "#ffffff"
        : fillMode === "solid"
          ? object.fill ?? "none"
          : fillMode === "outOfBounds"
            ? `url(#${patternId})`
            : "none";
    const closed =
      object.closed ||
      fillMode === "whiteout" ||
      fillMode === "outOfBounds";
    return (
      <g key={object.id}>
        {patternId && (
          <defs
            dangerouslySetInnerHTML={{
              __html: outOfBoundsPatternDef(
                patternId,
                purple,
                1,
              ),
            }}
          />
        )}
        <path
          {...common}
          d={pathData(vertices, closed)}
          fill={fill}
          stroke={object.stroke ?? "none"}
          strokeWidth={object.strokeWidthMm}
          style={common.style}
        />
      </g>
    );
  }
  if (object.kind === "rectangle") {
    const bounds = objectBounds(object, frame, window);
    const fillMode = object.fillMode ?? "none";
    const patternId = fillMode === "outOfBounds" ? `oob-${object.id}` : null;
    const fill =
      fillMode === "whiteout"
        ? "#ffffff"
        : fillMode === "solid"
          ? object.fill ?? "none"
          : fillMode === "outOfBounds"
            ? `url(#${patternId})`
            : "none";
    return (
      <g key={object.id}>
        {patternId && (
          <defs
            dangerouslySetInnerHTML={{
              __html: outOfBoundsPatternDef(
                patternId,
                purple,
                1,
              ),
            }}
          />
        )}
        <rect
          {...common}
          x={bounds.x}
          y={bounds.y}
          width={bounds.width}
          height={bounds.height}
          fill={fill}
          stroke={object.stroke ?? "none"}
          strokeWidth={object.strokeWidthMm}
          style={common.style}
        />
      </g>
    );
  }
  return null;
}

export function MapLayoutEditor({
  mode = "map",
  nameId,
  mapName,
  document,
  window: initialWindow,
  controls,
  legs,
  allControls = false,
  mapObjects,
  templateObjects,
  textValues,
  descriptionRows = [],
  descriptionTitle,
  descriptionHeader = null,
  previewCourses = [],
  previewCourseId,
  onPreviewCourseChange,
  templateEditHref,
  onSave,
  onClose,
}: MapLayoutEditorProps) {
  const { t } = useTranslation("maps");
  const paper = useMemo(
    () =>
      getPaperDimensions(
        document.paper,
        document.orientation,
        document.paper === "custom"
          ? {
              width: document.paperWidthMm!,
              height: document.paperHeightMm!,
            }
          : undefined,
      ),
    [
      document.orientation,
      document.paper,
      document.paperHeightMm,
      document.paperWidthMm,
    ],
  );
  const printable = printablePageRect(document);
  const initialCenter = {
    x: initialWindow.minX + initialWindow.width / 2,
    y: initialWindow.minY + initialWindow.height / 2,
  };
  const [history, setHistory] = useState<HistoryState>(() => ({
    past: [],
    present: {
      center: initialCenter,
      printScale: document.printScale,
      description: document.description,
      objects: cloneSnapshot({
        center: initialCenter,
        printScale: document.printScale,
        description: document.description,
        objects: mapObjects,
        templateObjects,
      }).objects,
      templateObjects: cloneSnapshot({
        center: initialCenter,
        printScale: document.printScale,
        description: document.description,
        objects: mapObjects,
        templateObjects,
      }).templateObjects,
    },
    future: [],
  }));
  const [tool, setTool] = useState<EditorTool>("select");
  const [placingGraphicId, setPlacingGraphicId] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedVertex, setSelectedVertex] = useState<number | null>(null);
  const [saveStatus, setSaveStatus] = useState<"idle" | "pending" | "saving" | "saved">(
    "idle",
  );
  const [saveError, setSaveError] = useState<string | null>(null);
  const [graphicsError, setGraphicsError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const isCoarsePointer = useMediaQuery("(pointer: coarse)");
  const editorRootRef = useRef<HTMLDivElement>(null);
  const paperSvgRef = useRef<SVGSVGElement>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestSnapshotRef = useRef<EditorSnapshot | null>(null);
  const dirtyRef = useRef(false);
  const [displayedPreview, setDisplayedPreview] = useState<{
    url: string;
    inkUrl: string;
    center: MapPoint;
    printScale: number;
  } | null>(null);
  const [previewErrorUrl, setPreviewErrorUrl] = useState<string | null>(null);
  const [openPanels, setOpenPanels] = useState<Record<PanelId, boolean>>(
    () => ({
      tools: !window.matchMedia("(max-width: 640px)").matches,
      page: false,
      graphics: false,
      objects: false,
      properties: false,
    }),
  );
  const togglePanel = (panel: PanelId) =>
    setOpenPanels((current) => ({ ...current, [panel]: !current[panel] }));
  const [scaleDraft, setScaleDraft] = useState<string | null>(null);
  const [cellSizeDraft, setCellSizeDraft] = useState<string | null>(null);
  const [viewport, setViewport] = useState<EditorViewport>(() =>
    initialEditorViewport(paper),
  );
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const touchGestureRef = useRef<{
    viewport: EditorViewport;
    anchor: MapPoint;
    startMidpoint: MapPoint;
    startClient: MapPoint;
    startDistance: number;
    inverse: { a: number; b: number; c: number; d: number };
  } | null>(null);
  const pendingTouchRef = useRef<{
    midpointX: number;
    midpointY: number;
    distance: number;
  } | null>(null);
  const touchFrameRef = useRef<number | null>(null);
  const lastSingleTouchRef = useRef<MapPoint | null>(null);
  const suppressTouchPointerRef = useRef(false);
  const suppressTouchPointerTimerRef = useRef<number | null>(null);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const previewWindowRef = useRef(initialWindow);
  const dragRef = useRef<{
    kind:
      | "pan"
      | "object"
      | "description"
      | "resize-object"
      | "resize-description"
      | "viewport";
    pointerId: number;
    start: MapPoint;
    snapshot: EditorSnapshot;
    objectId?: string;
    handle?: ResizeHandle;
    viewport?: EditorViewport;
    moved?: boolean;
  } | null>(null);

  useEffect(() => {
    if (mode !== "template" || previewWindowRef.current === initialWindow) {
      return;
    }
    previewWindowRef.current = initialWindow;
    const center = {
      x: initialWindow.minX + initialWindow.width / 2,
      y: initialWindow.minY + initialWindow.height / 2,
    };
    setHistory((current) => ({
      past: [],
      present: { ...current.present, center },
      future: [],
    }));
  }, [initialWindow, mode]);

  const baseMapScale =
    (document.mapFrame.width / initialWindow.width) * document.printScale;
  const rotationDeg = windowRotationDeg(initialWindow);
  const currentWindow = useMemo<MapWindow>(() => {
    const width =
      (document.mapFrame.width * history.present.printScale) / baseMapScale;
    const height =
      (document.mapFrame.height * history.present.printScale) / baseMapScale;
    return {
      minX: history.present.center.x - width / 2,
      minY: history.present.center.y - height / 2,
      width,
      height,
      ...(rotationDeg === 0 ? {} : { rotationDeg }),
    };
  }, [
    baseMapScale,
    document.mapFrame.height,
    document.mapFrame.width,
    history.present.center,
    history.present.printScale,
    rotationDeg,
  ]);

  const [previewState, setPreviewState] = useState(() => ({
    center: initialCenter,
    printScale: document.printScale,
  }));
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPreviewState({
        center: history.present.center,
        printScale: history.present.printScale,
      });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [history.present.center, history.present.printScale]);

  const previewUrls = useMemo(() => {
    const makeUrl = (dpi: number, layer: "full" | "ink") => {
      const params = new URLSearchParams({
        cx: String(previewState.center.x),
        cy: String(previewState.center.y),
        wMm: String(document.mapFrame.width),
        hMm: String(document.mapFrame.height),
        printScale: String(previewState.printScale),
        dpi: String(dpi),
        layer,
      });
      if (rotationDeg !== 0) params.set("rot", rotationDeg.toFixed(2));
      return `/api/maps/${encodeURIComponent(nameId)}/window.png?${params}`;
    };
    const dpiHigh = editorPreviewDpi(document.mapFrame);
    return {
      full: { low: makeUrl(120, "full"), high: makeUrl(dpiHigh, "full") },
      ink: { low: makeUrl(120, "ink"), high: makeUrl(dpiHigh, "ink") },
    };
  }, [document.mapFrame, nameId, previewState, rotationDeg]);
  useEffect(() => {
    let active = true;
    const shown = {
      center: previewState.center,
      printScale: previewState.printScale,
    };
    const apply = (fullUrl: string, inkUrl: string) => {
      if (!active) return;
      setDisplayedPreview({ url: fullUrl, inkUrl, ...shown });
      setPreviewErrorUrl(null);
    };
    const highFull = new Image();
    const highInk = new Image();
    let highPending = 2;
    const loadHigh = () => {
      const done = () => {
        highPending -= 1;
        if (highPending === 0) apply(previewUrls.full.high, previewUrls.ink.high);
      };
      highFull.onload = done;
      highInk.onload = done;
      highFull.onerror = () => {
        if (active) setPreviewErrorUrl(previewUrls.full.high);
      };
      highInk.onerror = done; // ink may be empty; still show full
      highFull.src = previewUrls.full.high;
      highInk.src = previewUrls.ink.high;
    };
    const lowFull = new Image();
    const lowInk = new Image();
    let lowPending = 2;
    const lowDone = () => {
      lowPending -= 1;
      if (lowPending === 0) {
        apply(previewUrls.full.low, previewUrls.ink.low);
        loadHigh();
      }
    };
    lowFull.onload = lowDone;
    lowInk.onload = lowDone;
    lowFull.onerror = () => {
      if (active) setPreviewErrorUrl(previewUrls.full.low);
    };
    lowInk.onerror = lowDone;
    lowFull.src = previewUrls.full.low;
    lowInk.src = previewUrls.ink.low;
    return () => {
      active = false;
      lowFull.onload = null;
      lowFull.onerror = null;
      lowInk.onload = null;
      lowInk.onerror = null;
      highFull.onload = null;
      highFull.onerror = null;
      highInk.onload = null;
      highInk.onerror = null;
    };
    // The shown window is snapshotted when the URLs change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewUrls]);
  const previewReady = displayedPreview?.url === previewUrls.full.high;
  const previewError =
    previewErrorUrl === previewUrls.full.low ||
    previewErrorUrl === previewUrls.full.high;
  const courseOverlaySvg = useMemo(
    () =>
      renderCourseOverlaySvg({
        frame: document.mapFrame,
        window: currentWindow,
        appearance: document.appearance,
        controls,
        legs,
        allControls,
        // ISOM: overprint enlarges with the map (base scale / print scale).
        overprintScale: baseMapScale / history.present.printScale,
      }),
    [
      allControls,
      baseMapScale,
      controls,
      currentWindow,
      document.appearance,
      document.mapFrame,
      history.present.printScale,
      legs,
    ],
  );

  const descriptionRowCount = descriptionRows.length;
  const descriptionHeaderRows = descriptionHeader ? 3 : 1;
  const descriptionSize = descriptionBlockSize(
    descriptionRowCount,
    history.present.description.cellSizeMm,
    descriptionHeaderRows,
  );
  const descriptionBlockSvg = useMemo(
    () =>
      history.present.description.visible
        ? renderDescriptionBlockSvg({
            x: history.present.description.x,
            y: history.present.description.y,
            cellSizeMm: history.present.description.cellSizeMm,
            title: descriptionTitle ?? mapName,
            rows: descriptionRows,
            ...(descriptionHeader ? { header: descriptionHeader } : {}),
            symbolResolver: (key) => IOF_SYMBOLS[key],
          })
        : "",
    [
      descriptionRows,
      descriptionTitle,
      descriptionHeader,
      history.present.description,
      mapName,
    ],
  );

  const utils = trpc.useUtils();
  const graphicsQuery = trpc.graphics.list.useQuery();
  const graphicsMutationOptions = {
    onSuccess: () => {
      setGraphicsError(null);
      void utils.graphics.list.invalidate();
    },
    onError: (cause: { message: string }) => setGraphicsError(cause.message),
  };
  const uploadGraphic = trpc.graphics.upload.useMutation(graphicsMutationOptions);
  const deleteGraphic = trpc.graphics.delete.useMutation(graphicsMutationOptions);
  const saveGraphicToClub = trpc.graphics.saveToClub.useMutation(
    graphicsMutationOptions,
  );
  const graphics = graphicsQuery.data ?? [];
  const graphicHref = (graphicId: number) =>
    `/api/maps/${encodeURIComponent(nameId)}/graphics/${graphicId}`;

  const flushSave = async (snapshot: EditorSnapshot) => {
    setSaveStatus("saving");
    setSaveError(null);
    try {
      await onSave(snapshot);
      dirtyRef.current = false;
      setSaveStatus("saved");
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : t("operationFailed"));
      setSaveStatus("idle");
    }
  };

  const scheduleSave = (snapshot: EditorSnapshot) => {
    latestSnapshotRef.current = snapshot;
    dirtyRef.current = true;
    setSaveStatus("pending");
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      const pending = latestSnapshotRef.current;
      if (pending) void flushSave(pending);
    }, 1000);
  };

  const commit = (next: EditorSnapshot) => {
    const cloned = cloneSnapshot(next);
    setHistory((current) => ({
      past: [...current.past, cloneSnapshot(current.present)].slice(-100),
      present: cloned,
      future: [],
    }));
    scheduleSave(cloned);
  };
  const replace = (next: EditorSnapshot) => {
    const cloned = cloneSnapshot(next);
    setHistory((current) => ({ ...current, present: cloned }));
    // Live drag replaces without committing; autosave waits for finishDrag.
  };
  const undo = () =>
    setHistory((current) => {
      const previous = current.past.at(-1);
      if (!previous) return current;
      scheduleSave(previous);
      return {
        past: current.past.slice(0, -1),
        present: previous,
        future: [cloneSnapshot(current.present), ...current.future],
      };
    });
  const redo = () =>
    setHistory((current) => {
      const next = current.future[0];
      if (!next) return current;
      scheduleSave(next);
      return {
        past: [...current.past, cloneSnapshot(current.present)],
        present: next,
        future: current.future.slice(1),
      };
    });

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(
        globalThis.document.fullscreenElement === editorRootRef.current,
      );
    };
    globalThis.document.addEventListener(
      "fullscreenchange",
      onFullscreenChange,
    );
    return () =>
      globalThis.document.removeEventListener(
        "fullscreenchange",
        onFullscreenChange,
      );
  }, []);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      // Best-effort flush on unmount — fire-and-forget.
      if (dirtyRef.current && latestSnapshotRef.current) {
        void onSave(latestSnapshotRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount only
  }, []);

  const toggleFullscreen = () => {
    const root = editorRootRef.current;
    if (!root) return;
    if (!globalThis.document.fullscreenElement) {
      void root.requestFullscreen().catch(() => {});
    } else {
      void globalThis.document.exitFullscreen().catch(() => {});
    }
  };

  const requestClose = async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (dirtyRef.current && latestSnapshotRef.current) {
      await flushSave(latestSnapshotRef.current);
    }
    onClose();
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && (tool !== "select" || placingGraphicId !== null)) {
        setTool("select");
        setPlacingGraphicId(null);
        return;
      }
      const selectedForDelete =
        mode === "template"
          ? history.present.templateObjects.find(
              (object) => object.id === selectedId,
            )
          : history.present.objects.find((object) => object.id === selectedId);
      if (
        (event.key === "Delete" || event.key === "Backspace") &&
        selectedVertex !== null &&
        selectedForDelete &&
        (selectedForDelete.kind === "path")
      ) {
        event.preventDefault();
        const next = removePolygonVertex(selectedForDelete, selectedVertex);
        const replacePoints = (object: CourseMapObject) =>
          object.id === selectedForDelete.id
            ? ({ ...object, points: next.points } as CourseMapObject)
            : object;
        commit({
          ...history.present,
          objects:
            mode === "map"
              ? history.present.objects.map(replacePoints)
              : history.present.objects,
          templateObjects:
            mode === "template"
              ? history.present.templateObjects.map(replacePoints)
              : history.present.templateObjects,
        });
        setSelectedVertex(
          next.points.length === selectedForDelete.points.length
            ? selectedVertex
            : Math.min(selectedVertex, next.points.length - 1),
        );
        return;
      }
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const clientToPagePoint = useCallback((clientX: number, clientY: number): MapPoint => {
    const svg = paperSvgRef.current;
    const matrix = svg?.getScreenCTM();
    if (svg && matrix) {
      const point = svg.createSVGPoint();
      point.x = clientX;
      point.y = clientY;
      const transformed = point.matrixTransform(matrix.inverse());
      return { x: transformed.x, y: transformed.y };
    }
    const rect = svg?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) {
      return { x: viewportRef.current.x, y: viewportRef.current.y };
    }
    const currentViewport = viewportRef.current;
    return {
      x:
        currentViewport.x +
        ((clientX - rect.left) / rect.width) * currentViewport.width,
      y:
        currentViewport.y +
        ((clientY - rect.top) / rect.height) * currentViewport.height,
    };
  }, []);
  const pagePoint = (
    event:
      | ReactPointerEvent<SVGSVGElement | SVGElement>
      | ReactWheelEvent<SVGSVGElement>,
  ): MapPoint => clientToPagePoint(event.clientX, event.clientY);

  useEffect(() => {
    const svg = paperSvgRef.current;
    if (!svg) return;
    const allowOneFingerPan = isFullscreen || !isCoarsePointer;
    const midpoint = (touches: TouchList) => ({
      x: (touches[0].clientX + touches[1].clientX) / 2,
      y: (touches[0].clientY + touches[1].clientY) / 2,
    });
    const distance = (touches: TouchList) =>
      Math.hypot(
        touches[0].clientX - touches[1].clientX,
        touches[0].clientY - touches[1].clientY,
      );
    const suppressTouchPointers = () => {
      suppressTouchPointerRef.current = true;
      if (suppressTouchPointerTimerRef.current !== null) {
        window.clearTimeout(suppressTouchPointerTimerRef.current);
      }
      suppressTouchPointerTimerRef.current = window.setTimeout(() => {
        suppressTouchPointerRef.current = false;
        suppressTouchPointerTimerRef.current = null;
      }, 500);
    };

    const startPinch = (event: TouchEvent) => {
      const matrix = svg.getScreenCTM();
      if (!matrix || event.touches.length !== 2) return;
      event.preventDefault();
      dragRef.current = null;
      suppressTouchPointers();
      const client = midpoint(event.touches);
      const anchor = clientToPagePoint(client.x, client.y);
      const inverse = matrix.inverse();
      touchGestureRef.current = {
        viewport: viewportRef.current,
        anchor,
        startMidpoint: anchor,
        startClient: client,
        startDistance: Math.max(1, distance(event.touches)),
        inverse: {
          a: inverse.a,
          b: inverse.b,
          c: inverse.c,
          d: inverse.d,
        },
      };
      lastSingleTouchRef.current = null;
    };
    const flushPinch = () => {
      const pending = pendingTouchRef.current;
      const base = touchGestureRef.current;
      if (!pending || !base) return;
      const screenDx = pending.midpointX - base.startClient.x;
      const screenDy = pending.midpointY - base.startClient.y;
      const currentMidpoint = {
        x:
          base.startMidpoint.x +
          base.inverse.a * screenDx +
          base.inverse.c * screenDy,
        y:
          base.startMidpoint.y +
          base.inverse.b * screenDx +
          base.inverse.d * screenDy,
      };
      setViewport(
        pinchEditorViewport(
          base.viewport,
          paper,
          base.anchor,
          base.startMidpoint,
          currentMidpoint,
          pending.distance / base.startDistance,
        ),
      );
    };

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length === 2) {
        startPinch(event);
        return;
      }
      if (event.touches.length !== 1) return;
      if (tool === "pan") {
        // Adjust map owns one-finger movement even in fullscreen; two
        // fingers above remain reserved for inspecting the paper viewport.
        event.preventDefault();
        return;
      }
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("[data-map-editor-target='true']")
      ) {
        return;
      }
      if (allowOneFingerPan) {
        event.preventDefault();
        lastSingleTouchRef.current = {
          x: event.touches[0].clientX,
          y: event.touches[0].clientY,
        };
      }
    };

    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length === 2) {
        event.preventDefault();
        if (!touchGestureRef.current) startPinch(event);
        const gesture = touchGestureRef.current;
        if (!gesture) return;
        const client = midpoint(event.touches);
        pendingTouchRef.current = {
          midpointX: client.x,
          midpointY: client.y,
          distance: distance(event.touches),
        };
        if (touchFrameRef.current === null) {
          touchFrameRef.current = requestAnimationFrame(() => {
            touchFrameRef.current = null;
            flushPinch();
          });
        }
        return;
      }
      if (tool === "pan" && event.touches.length === 1) {
        event.preventDefault();
        return;
      }
      const previous = lastSingleTouchRef.current;
      if (
        event.touches.length !== 1 ||
        !previous ||
        !allowOneFingerPan
      ) {
        return;
      }
      event.preventDefault();
      const current = {
        x: event.touches[0].clientX,
        y: event.touches[0].clientY,
      };
      const inverse = svg.getScreenCTM()?.inverse();
      if (inverse) {
        const screenDx = current.x - previous.x;
        const screenDy = current.y - previous.y;
        setViewport((value) =>
          panEditorViewport(
            value,
            paper,
            inverse.a * screenDx + inverse.c * screenDy,
            inverse.b * screenDx + inverse.d * screenDy,
          ),
        );
      }
      lastSingleTouchRef.current = current;
    };

    const onTouchEnd = (event: TouchEvent) => {
      if (event.touches.length === 1 && touchGestureRef.current) {
        if (touchFrameRef.current !== null) {
          cancelAnimationFrame(touchFrameRef.current);
          touchFrameRef.current = null;
        }
        flushPinch();
        touchGestureRef.current = null;
        pendingTouchRef.current = null;
        suppressTouchPointers();
        lastSingleTouchRef.current = allowOneFingerPan
          ? {
              x: event.touches[0].clientX,
              y: event.touches[0].clientY,
            }
          : null;
      } else if (event.touches.length === 0) {
        if (touchFrameRef.current !== null) {
          cancelAnimationFrame(touchFrameRef.current);
          touchFrameRef.current = null;
        }
        flushPinch();
        touchGestureRef.current = null;
        pendingTouchRef.current = null;
        lastSingleTouchRef.current = null;
      }
    };

    svg.addEventListener("touchstart", onTouchStart, { passive: false });
    svg.addEventListener("touchmove", onTouchMove, { passive: false });
    svg.addEventListener("touchend", onTouchEnd, { passive: false });
    svg.addEventListener("touchcancel", onTouchEnd, { passive: false });
    return () => {
      if (touchFrameRef.current !== null) {
        cancelAnimationFrame(touchFrameRef.current);
        touchFrameRef.current = null;
      }
      if (suppressTouchPointerTimerRef.current !== null) {
        window.clearTimeout(suppressTouchPointerTimerRef.current);
        suppressTouchPointerTimerRef.current = null;
      }
      suppressTouchPointerRef.current = false;
      svg.removeEventListener("touchstart", onTouchStart);
      svg.removeEventListener("touchmove", onTouchMove);
      svg.removeEventListener("touchend", onTouchEnd);
      svg.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [clientToPagePoint, isCoarsePointer, isFullscreen, paper, tool]);

  const beginDrag = (
    kind:
      | "pan"
      | "object"
      | "description"
      | "resize-object"
      | "resize-description"
      | "viewport",
    event: ReactPointerEvent<SVGElement>,
    objectId?: string,
    handle?: ResizeHandle,
  ) => {
    if (
      event.pointerType === "touch" &&
      suppressTouchPointerRef.current
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      kind,
      pointerId: event.pointerId,
      start: pagePoint(event),
      snapshot: cloneSnapshot(history.present),
      objectId,
      handle,
      viewport: kind === "viewport" ? viewport : undefined,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const current = pagePoint(event);
    const dx = current.x - drag.start.x;
    const dy = current.y - drag.start.y;
    if (Math.hypot(dx, dy) >= 0.5) drag.moved = true;
    if (drag.kind === "viewport" && drag.viewport) {
      setViewport(panEditorViewport(drag.viewport, paper, dx, dy));
      return;
    }
    if (drag.kind === "pan") {
      // Convert the page-space drag delta into map space through pageToMap
      // so a rotated window pans along the rotated axes.
      const from = pageToMap(drag.start, document.mapFrame, currentWindow);
      const to = pageToMap(current, document.mapFrame, currentWindow);
      replace({
        ...drag.snapshot,
        center: {
          x: drag.snapshot.center.x - (to.x - from.x),
          y: drag.snapshot.center.y - (to.y - from.y),
        },
      });
    } else if (drag.kind === "description") {
      const size = descriptionBlockSize(
        descriptionRowCount,
        drag.snapshot.description.cellSizeMm,
        descriptionHeaderRows,
      );
      replace({
        ...drag.snapshot,
        description: constrainDescription(
          {
            ...drag.snapshot.description,
            x: drag.snapshot.description.x + dx,
            y: drag.snapshot.description.y + dy,
          },
          size.width,
          size.height,
          printable,
        ),
      });
    } else if (drag.kind === "resize-description") {
      const rows = Math.max(1, descriptionRowCount + descriptionHeaderRows);
      const nextCellSize = Math.max(
        3,
        Math.min(
          15,
          drag.snapshot.description.cellSizeMm +
            Math.max(dx / 8, dy / rows),
        ),
      );
      const size = descriptionBlockSize(
        descriptionRowCount,
        nextCellSize,
        descriptionHeaderRows,
      );
      replace({
        ...drag.snapshot,
        description: constrainDescription(
          { ...drag.snapshot.description, cellSizeMm: nextCellSize },
          size.width,
          size.height,
          printable,
        ),
      });
    } else if (drag.objectId) {
      const update = (object: CourseMapObject) => {
        if (object.id !== drag.objectId) return object;
        if (
          drag.kind === "resize-object" &&
          drag.handle &&
          (object.kind === "path")
        ) {
          const delta = pageDeltaToObject(
            object.anchor,
            dx,
            dy,
            document.mapFrame,
            currentWindow,
          );
          if (drag.handle.startsWith("handle-")) {
            const incoming = drag.handle.startsWith("handle-in-");
            const index = Number(
              drag.handle.replace(incoming ? "handle-in-" : "handle-out-", ""),
            );
            const key = incoming ? "hIn" : "hOut";
            const original = object.points[index]?.[key] ?? { x: 0, y: 0 };
            return updatePolygonHandle(object, index, key, {
              x: original.x + delta.x,
              y: original.y + delta.y,
            });
          }
          if (event.altKey && drag.handle.startsWith("vertex-")) {
            const index = Number(drag.handle.replace("vertex-", ""));
            return updatePolygonHandle(
              updatePolygonHandle(object, index, "hOut", delta),
              index,
              "hIn",
              { x: -delta.x, y: -delta.y },
            );
          }
        }
        const changed =
          drag.kind === "resize-object" && drag.handle
            ? resizeMapObject(
                object,
                drag.handle,
                dx,
                dy,
                document.mapFrame,
                currentWindow,
                {
                  printable,
                  imageMode: event.shiftKey
                    ? "crop"
                    : event.ctrlKey || event.metaKey
                      ? "proportional"
                      : "free",
                },
              )
            : translateMapObject(
                object,
                dx,
                dy,
                document.mapFrame,
                currentWindow,
              );
        // Resize already clamps edges/vertices into the printable area;
        // translating out-of-bounds again would grow the opposite edge.
        if (drag.kind === "resize-object") return changed;
        return constrainMapObject(
          changed,
          printable,
          document.mapFrame,
          currentWindow,
        );
      };
      replace({
        ...drag.snapshot,
        objects:
          mode === "map"
            ? drag.snapshot.objects.map(update)
            : drag.snapshot.objects,
        templateObjects:
          mode === "template"
            ? drag.snapshot.templateObjects.map(update)
            : drag.snapshot.templateObjects,
      });
    }
  };

  const finishDrag = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (drag.kind === "viewport") return;
    if (drag.kind === "object" && !drag.moved && drag.objectId) {
      selectObject(drag.objectId);
      return;
    }
    setHistory((current) => {
      scheduleSave(current.present);
      return {
        past: [...current.past, drag.snapshot].slice(-100),
        present: current.present,
        future: [],
      };
    });
  };

  const addObject = (object: CourseMapObject) => {
    commit({
      ...history.present,
      objects:
        mode === "map"
          ? [...history.present.objects, object]
          : history.present.objects,
      templateObjects:
        mode === "template"
          ? [...history.present.templateObjects, object]
          : history.present.templateObjects,
    });
    selectObject(object.id);
    setTool("select");
    setPlacingGraphicId(null);
  };
  const placeObject = (
    kind: Exclude<EditorTool, "select" | "pan">,
    point: MapPoint,
  ) => {
    addObject(createObjectAt(kind, point, printable));
  };

  const selected =
    mode === "template"
      ? history.present.templateObjects.find(
          (object) => object.id === selectedId,
        )
      : history.present.objects.find((object) => object.id === selectedId);
  /** Select an object and reveal the Properties card. */
  const selectObject = (id: string) => {
    setSelectedId(id);
    setOpenPanels((current) =>
      current.properties ? current : { ...current, properties: true },
    );
  };
  const editableObjects =
    mode === "template"
      ? history.present.templateObjects
      : history.present.objects;
  const objectDragHandler = (
    object: CourseMapObject,
    editable: boolean,
  ) =>
    editable
      ? (event: ReactPointerEvent<SVGElement>) => {
          // Select immediately so handles follow the drag, but reveal
          // Properties only if this pointer ends as a tap.
          setSelectedId(object.id);
          beginDrag("object", event, object.id);
        }
      : undefined;
  const updateSelected = (patch: Partial<CourseMapObject>) => {
    if (!selected) return;
    const update = (object: CourseMapObject) =>
      object.id === selected.id
        ? constrainMapObject(
            { ...object, ...patch } as CourseMapObject,
            printable,
            document.mapFrame,
            currentWindow,
          )
        : object;
    commit({
      ...history.present,
      objects:
        mode === "map"
          ? history.present.objects.map(update)
          : history.present.objects,
      templateObjects:
        mode === "template"
          ? history.present.templateObjects.map(update)
          : history.present.templateObjects,
    });
  };
  const deleteObjectById = (id: string) => {
    commit({
      ...history.present,
      objects: history.present.objects.filter((object) => object.id !== id),
      templateObjects: history.present.templateObjects.filter(
        (object) => object.id !== id,
      ),
    });
    if (selectedId === id) setSelectedId(null);
  };
  const objectListLabel = (object: CourseMapObject): string => {
    if (object.kind === "text") {
      const text = object.text.trim();
      return text === "" ? t("objectKindText") : text;
    }
    if (object.kind === "image") {
      return (
        graphics.find((graphic) => graphic.id === object.graphicId)?.name ??
        t("objectKindImage")
      );
    }
    return objectKindLabel(object);
  };
  const previewObject = (object: CourseMapObject): CourseMapObject =>
    object.kind === "text"
      ? {
          ...object,
          text: expandMapText(object.text, {
            ...textValues,
            scale: `1:${history.present.printScale}`,
          }),
        }
      : object;

  const tools: Array<[EditorTool, string]> = [
    ["select", t("selectTool")],
    ["pan", t("alignMapTool")],
    ["text", t("textTool")],
    ["line", t("pathTool")],
    ["rectangle", t("rectangleTool")],
    ["path", t("polygonTool")],
  ];
  const objectKindLabel = (object: CourseMapObject): string => {
    switch (object.kind) {
      case "text":
        return t("objectKindText");
      case "line":
        return t("objectKindLine");
      case "path":
        return object.fillMode === "whiteout"
          ? t("objectKindWhiteout")
          : object.fillMode === "outOfBounds"
            ? t("objectKindOutOfBounds")
            : object.closed
              ? t("objectKindPolygon")
              : t("objectKindPath");
      case "rectangle":
        return object.fillMode === "whiteout"
          ? t("objectKindWhiteout")
          : object.fillMode === "outOfBounds"
            ? t("objectKindOutOfBounds")
            : t("objectKindRectangle");
      case "image":
        return t("objectKindImage");
    }
  };

  const objectOutOfBounds = (object: CourseMapObject): boolean => {
    // Map-anchored objects are clipped to the map frame in print — being
    // outside the printable area is fine and not worth a warning.
    if (object.anchor === "map") return false;
    const bounds = courseMapObjectPageBounds(
      object,
      document.mapFrame,
      currentWindow,
    );
    return bounds !== null && !rectInside(bounds, printable);
  };

  const saveStatusLabel =
    saveStatus === "saving"
      ? t("autosaving")
      : saveStatus === "pending"
        ? t("autosavePending")
        : saveStatus === "saved"
          ? t("autosaved")
          : null;

  return (
    <div
      ref={editorRootRef}
      data-testid="map-layout-editor"
      className="fixed inset-0 z-50 flex flex-col bg-slate-100"
    >
      <header className="flex flex-wrap items-center gap-1.5 border-b border-slate-200 bg-white px-3 py-1.5 shadow-sm">
        <h2 className="mr-1 truncate text-sm font-semibold text-slate-900">
          {t("editorTitle")}: {mapName}
        </h2>
        <EditorHelp
          testId="map-editor-help"
          label={t("editorHelpAria")}
          hint={t(mode === "template" ? "editorHelpTemplate" : "editorHelpMap")}
        />
        <span className="mx-1 hidden h-4 w-px bg-slate-200 sm:inline-block" />
        <button
          type="button"
          data-testid="map-editor-undo"
          disabled={history.past.length === 0}
          onClick={undo}
          title={t("undo")}
          className={`rounded-md px-2 py-1.5 text-lg leading-none transition-colors ${
            history.past.length > 0
              ? "cursor-pointer text-slate-500 hover:bg-slate-100 hover:text-slate-700"
              : "cursor-not-allowed text-slate-300"
          }`}
        >
          ⟲
        </button>
        <button
          type="button"
          data-testid="map-editor-redo"
          disabled={history.future.length === 0}
          onClick={redo}
          title={t("redo")}
          className={`rounded-md px-2 py-1.5 text-lg leading-none transition-colors ${
            history.future.length > 0
              ? "cursor-pointer text-slate-500 hover:bg-slate-100 hover:text-slate-700"
              : "cursor-not-allowed text-slate-300"
          }`}
        >
          ⟳
        </button>
        <div className="flex items-center rounded-md border border-slate-200">
          <button
            type="button"
            title={t("zoomOut")}
            onClick={() =>
              setViewport((current) =>
                zoomEditorViewport(
                  current,
                  paper,
                  {
                    x: current.x + current.width / 2,
                    y: current.y + current.height / 2,
                  },
                  current.zoom / 1.25,
                ),
              )
            }
            className="px-2 py-1 text-sm text-slate-600 hover:bg-slate-50"
          >
            −
          </button>
          <button
            type="button"
            data-testid="map-zoom-reset"
            title={t("resetZoom")}
            onClick={() => setViewport(initialEditorViewport(paper))}
            className="border-x border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
          >
            {Math.round(viewport.zoom * 100)}%
          </button>
          <button
            type="button"
            title={t("zoomIn")}
            onClick={() =>
              setViewport((current) =>
                zoomEditorViewport(
                  current,
                  paper,
                  {
                    x: current.x + current.width / 2,
                    y: current.y + current.height / 2,
                  },
                  current.zoom * 1.25,
                ),
              )
            }
            className="px-2 py-1 text-sm text-slate-600 hover:bg-slate-50"
          >
            +
          </button>
        </div>
        {mode === "template" && onPreviewCourseChange && (
          <label className="ml-1 flex items-center gap-1.5 text-xs font-medium text-slate-600">
            {t("previewCourse")}
            <select
              data-testid="map-template-preview-course"
              value={previewCourseId ?? ""}
              onChange={(event) =>
                onPreviewCourseChange(
                  event.target.value
                    ? Number(event.target.value)
                    : undefined,
                )
              }
              className="rounded-md border border-slate-200 px-2 py-1 text-sm"
            >
              <option value="">{t("noPreviewCourse")}</option>
              {previewCourses.map((course) => (
                <option key={course.id} value={course.id}>
                  {course.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {!previewReady && !previewError && (
            <span
              data-testid="map-preview-loading"
              className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-600"
            >
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-blue-600" />
              {t("previewLoading")}
            </span>
          )}
          {saveStatusLabel && (
            <span
              data-testid="map-layout-save-status"
              className="text-xs text-slate-500"
            >
              {saveStatusLabel}
            </span>
          )}
          {saveError && (
            <span className="text-xs text-red-600" role="alert">
              {saveError}
            </span>
          )}
          <button
            type="button"
            data-testid="map-editor-fullscreen"
            onClick={toggleFullscreen}
            title={isFullscreen ? t("exitFullscreen") : t("enterFullscreen")}
            aria-label={
              isFullscreen ? t("exitFullscreen") : t("enterFullscreen")
            }
            className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
          >
            {isFullscreen ? (
              <IconFullscreenExit className="h-4 w-4" />
            ) : (
              <IconFullscreenEnter className="h-4 w-4" />
            )}
          </button>
          <button
            type="button"
            data-testid="map-editor-close"
            onClick={() => void requestClose()}
            title={t("closeEditor")}
            aria-label={t("closeEditor")}
            className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
      </header>

      <div className="relative min-h-0 flex-1 overflow-hidden bg-slate-100">
        <div className="pointer-events-none absolute bottom-3 left-3 top-3 z-10 flex w-64 max-w-[calc(100vw-1.5rem)] flex-col gap-2">
          <EditorPanel
            id="tools"
            title={t("toolsPanel")}
            open={openPanels.tools}
            onToggle={togglePanel}
          >
            <div className="grid gap-1">
              {tools.map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  data-testid={`map-tool-${id}`}
                  onClick={() => {
                    setTool(id);
                    setPlacingGraphicId(null);
                  }}
                  className={`rounded px-3 py-1.5 text-left text-sm ${
                    tool === id && placingGraphicId === null
                      ? "bg-blue-100 font-medium text-blue-800"
                      : "text-slate-700 hover:bg-slate-100"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {tool !== "select" && tool !== "pan" && (
              <p className="mt-2 text-xs text-blue-700">
                {t("placeObjectHint")}
              </p>
            )}
          </EditorPanel>

          <EditorPanel
            id="page"
            title={t("pagePanel")}
            open={openPanels.page}
            onToggle={togglePanel}
          >
            <label className="block text-xs font-medium text-slate-600">
              {t("printScale")}
              <input
                data-testid="map-print-scale"
                type="number"
                list="map-editor-common-scales"
                min={1000}
                max={100000}
                step={500}
                value={scaleDraft ?? String(history.present.printScale)}
                onChange={(event) => setScaleDraft(event.target.value)}
                onBlur={() => {
                  if (scaleDraft !== null) {
                    commit({
                      ...history.present,
                      printScale: parseClampedNumberDraft(
                        scaleDraft,
                        history.present.printScale,
                        1000,
                        100000,
                      ),
                    });
                  }
                  setScaleDraft(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
                className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
              />
              <datalist id="map-editor-common-scales">
                <option value="4000" />
                <option value="5000" />
                <option value="7500" />
                <option value="10000" />
                <option value="15000" />
              </datalist>
            </label>
            <label className="mt-4 flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={history.present.description.visible}
                onChange={(event) =>
                  commit({
                    ...history.present,
                    description: {
                      ...history.present.description,
                      visible: event.target.checked,
                    },
                  })
                }
              />
              {t("descriptionVisible")}
            </label>
            {history.present.description.visible && (
              <label className="mt-3 block text-xs font-medium text-slate-600">
                {t("descriptionCellSize")}
                <input
                  type="number"
                  min={3}
                  max={15}
                  step={0.5}
                  value={
                    cellSizeDraft ??
                    String(history.present.description.cellSizeMm)
                  }
                  onChange={(event) => setCellSizeDraft(event.target.value)}
                  onBlur={() => {
                    const cellSizeMm = parseClampedNumberDraft(
                      cellSizeDraft ?? "",
                      history.present.description.cellSizeMm,
                      3,
                      15,
                    );
                    const size = descriptionBlockSize(
                      descriptionRowCount,
                      cellSizeMm,
                      descriptionHeaderRows,
                    );
                    commit({
                      ...history.present,
                      description: constrainDescription(
                        {
                          ...history.present.description,
                          cellSizeMm,
                        },
                        size.width,
                        size.height,
                        printable,
                      ),
                    });
                    setCellSizeDraft(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
                />
              </label>
            )}
          </EditorPanel>

          <EditorPanel
            id="graphics"
            title={t("graphicsPanel")}
            open={openPanels.graphics}
            onToggle={togglePanel}
          >
            <label className="flex cursor-pointer items-center justify-center gap-1.5 rounded border border-blue-200 px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-50">
              <input
                type="file"
                data-testid="map-graphic-upload"
                accept=".svg,.png,image/svg+xml,image/png"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (!file) return;
                  void fileToBase64(file)
                    .then((fileDataBase64) =>
                      uploadGraphic.mutateAsync({
                        name: file.name.replace(/\.(svg|png)$/i, "") || file.name,
                        scope: "event",
                        fileDataBase64,
                      }),
                    )
                    .catch(() => {
                      // Mutation errors surface via graphicsError.
                    });
                }}
              />
              {uploadGraphic.isPending ? t("uploading") : t("uploadGraphic")}
            </label>
            {graphicsError && (
              <p role="alert" className="mt-2 text-red-600">
                {graphicsError}
              </p>
            )}
            {graphics.length === 0 ? (
              <p className="mt-2 text-slate-400">{t("noGraphics")}</p>
            ) : (
              <ul className="mt-2 grid gap-1" data-testid="map-graphics-list">
                {graphics.map((graphic) => (
                  <li
                    key={graphic.id}
                    className={`flex items-center gap-1 rounded ${
                      placingGraphicId === graphic.id
                        ? "bg-blue-100"
                        : "hover:bg-slate-100"
                    }`}
                  >
                    <button
                      type="button"
                      data-testid={`map-graphic-place-${graphic.id}`}
                      title={t("placeGraphic")}
                      onClick={() => {
                        setTool("select");
                        setPlacingGraphicId(
                          placingGraphicId === graphic.id ? null : graphic.id,
                        );
                      }}
                      className="flex min-w-0 flex-1 items-center gap-2 px-1.5 py-1 text-left"
                    >
                      <img
                        src={graphicHref(graphic.id)}
                        alt=""
                        className="h-6 w-6 shrink-0 object-contain"
                      />
                      <span className="truncate text-slate-700">
                        {graphic.name}
                      </span>
                      {graphic.club && (
                        <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
                          {t("clubGraphicBadge")}
                        </span>
                      )}
                    </button>
                    {!graphic.club && (
                      <button
                        type="button"
                        data-testid={`map-graphic-save-club-${graphic.id}`}
                        title={t("saveGraphicToClub")}
                        onClick={() =>
                          void saveGraphicToClub.mutateAsync({
                            id: graphic.id,
                          })
                        }
                        className="shrink-0 rounded p-1 text-slate-400 hover:bg-blue-50 hover:text-blue-700"
                      >
                        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 16V4m0 0L8 8m4-4l4 4M5 14v5h14v-5" />
                        </svg>
                      </button>
                    )}
                    <button
                      type="button"
                      data-testid={`map-graphic-delete-${graphic.id}`}
                      title={t("deleteGraphic")}
                      onClick={() => {
                        if (
                          window.confirm(
                            t("deleteGraphicConfirm", { name: graphic.name }),
                          )
                        ) {
                          void deleteGraphic.mutateAsync({ id: graphic.id });
                        }
                      }}
                      className="shrink-0 rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                    >
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.9 12.1A2 2 0 0116.1 21H7.9a2 2 0 01-2-1.9L5 7m5 4v6m4-6v6m1-10V4H9v3M4 7h16" />
                      </svg>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {placingGraphicId !== null && (
              <p className="mt-2 text-blue-700">{t("placeObjectHint")}</p>
            )}
          </EditorPanel>

          <EditorPanel
            id="objects"
            title={`${t("objectsPanel")} (${editableObjects.length})`}
            open={openPanels.objects}
            onToggle={togglePanel}
          >
            {editableObjects.length === 0 ? (
              <p className="text-slate-400">{t("noObjects")}</p>
            ) : (
              <ul className="grid gap-0.5" data-testid="map-object-list">
                {editableObjects.map((object) => {
                  const outOfBounds = objectOutOfBounds(object);
                  return (
                  <li
                    key={object.id}
                    className={`flex items-center gap-1 rounded ${
                      selectedId === object.id
                        ? "bg-blue-100"
                        : "hover:bg-slate-100"
                    }`}
                  >
                    <button
                      type="button"
                      data-testid={`map-object-list-item-${object.id}`}
                      onClick={() => {
                        selectObject(object.id);
                        setSelectedVertex(null);
                      }}
                      className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1 text-left"
                    >
                      <span className="shrink-0 text-[10px] uppercase tracking-wide text-slate-400">
                        {objectKindLabel(object)}
                      </span>
                      <span className="truncate text-slate-700">
                        {objectListLabel(object)}
                      </span>
                      {outOfBounds && (
                        <span
                          data-testid={`map-object-warning-${object.id}`}
                          title={t("objectOutsidePage")}
                          className="shrink-0 text-amber-600"
                          aria-label={t("objectOutsidePage")}
                        >
                          ⚠
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      data-testid={`map-object-list-delete-${object.id}`}
                      title={t("deleteObject")}
                      onClick={() => deleteObjectById(object.id)}
                      className="shrink-0 rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                    >
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.9 12.1A2 2 0 0116.1 21H7.9a2 2 0 01-2-1.9L5 7m5 4v6m4-6v6m1-10V4H9v3M4 7h16" />
                      </svg>
                    </button>
                  </li>
                  );
                })}
              </ul>
            )}
            {mode === "map" &&
              history.present.templateObjects.some(objectOutOfBounds) && (
                <div
                  data-testid="map-template-object-warning"
                  className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-amber-800"
                >
                  <p>
                    ⚠{" "}
                    {t("templateObjectsOutside", {
                      count:
                        history.present.templateObjects.filter(
                          objectOutOfBounds,
                        ).length,
                    })}
                  </p>
                  {templateEditHref && (
                    <a
                      href={templateEditHref}
                      className="mt-1 inline-block font-medium text-blue-700"
                    >
                      {t("editAssignedTemplate")}
                    </a>
                  )}
                </div>
              )}
          </EditorPanel>

          <EditorPanel
            id="properties"
            title={t("properties")}
            open={openPanels.properties}
            onToggle={togglePanel}
          >
            {mode === "map" && templateObjects.length > 0 && (
              <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
                <p>{t("templateObjectsLocked")}</p>
                {templateEditHref && (
                  <a
                    href={templateEditHref}
                    className="mt-2 inline-block font-medium text-blue-700"
                  >
                    {t("editAssignedTemplate")}
                  </a>
                )}
              </div>
            )}
            {selected ? (
              <div className="space-y-3" data-testid="map-object-properties">
                <label className="block text-xs font-medium text-slate-600">
                  {t("anchor")}
                  <select
                    value={selected.anchor}
                    onChange={(event) =>
                      updateSelected({
                        anchor: event.target.value as "page" | "map",
                      })
                    }
                    className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
                  >
                    <option value="page">{t("anchorPage")}</option>
                    <option value="map">{t("anchorMap")}</option>
                  </select>
                </label>
                {selected.kind === "text" && (
                  <>
                    <label className="block text-xs font-medium text-slate-600">
                      {t("objectText")}
                      <textarea
                        ref={textAreaRef}
                        data-testid="map-object-text"
                        value={selected.text}
                        onChange={(event) =>
                          updateSelected({ text: event.target.value })
                        }
                        className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
                      />
                    </label>
                    <div>
                      <span className="block text-xs font-medium text-slate-600">
                        {t("variables")}
                      </span>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {MAP_TEXT_PLACEHOLDERS.map((variable) => (
                          <button
                            key={variable}
                            type="button"
                            data-testid={`map-variable-${variable}`}
                            onClick={() => {
                              const area = textAreaRef.current;
                              const hasSelection =
                                area !== null &&
                                globalThis.document.activeElement === area;
                              const start = hasSelection
                                ? area.selectionStart
                                : selected.text.length;
                              const end = hasSelection
                                ? area.selectionEnd
                                : start;
                              const token = `{${variable}}`;
                              updateSelected({
                                text:
                                  selected.text.slice(0, start) +
                                  token +
                                  selected.text.slice(end),
                              });
                              window.setTimeout(() => {
                                textAreaRef.current?.focus();
                                textAreaRef.current?.setSelectionRange(
                                  start + token.length,
                                  start + token.length,
                                );
                              }, 0);
                            }}
                            className="rounded bg-slate-100 px-1.5 py-1 text-[11px] text-slate-700 hover:bg-blue-100"
                          >
                            {`{${variable}}`}
                          </button>
                        ))}
                      </div>
                    </div>
                    <label className="block text-xs font-medium text-slate-600">
                      {t("fontSize")}
                      <input
                        type="number"
                        min={1}
                        max={100}
                        step={0.5}
                        value={selected.fontSizeMm}
                        onChange={(event) =>
                          updateSelected({
                            fontSizeMm: Number(event.target.value),
                          })
                        }
                        className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
                      />
                    </label>
                    <label className="block text-xs font-medium text-slate-600">
                      {t("fontFamily")}
                      <select
                        data-testid="map-text-font"
                        value={selected.fontFamily ?? "sans"}
                        onChange={(event) =>
                          updateSelected({
                            fontFamily: event.target.value as MapFontFamily,
                          })
                        }
                        className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
                      >
                        <option value="sans">{t("fontSans")}</option>
                        <option value="serif">{t("fontSerif")}</option>
                        <option value="condensed">{t("fontCondensed")}</option>
                        <option value="mono">{t("fontMono")}</option>
                      </select>
                    </label>
                  </>
                )}
                {selected.kind === "image" && (
                  <p className="text-xs text-slate-500">
                    {graphics.find(
                      (graphic) => graphic.id === selected.graphicId,
                    )?.name ?? t("objectKindImage")}
                  </p>
                )}
                {selected.kind === "text" && (
                  <label className="block text-xs font-medium text-slate-600">
                    {t("color")}
                    <input
                      type="color"
                      value={selected.color}
                      onChange={(event) =>
                        updateSelected({ color: event.target.value })
                      }
                      className="mt-1 h-9 w-full rounded border border-slate-300"
                    />
                  </label>
                )}
                {selected.kind === "path" && (
                  <>
                    <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
                      <input
                        type="checkbox"
                        checked={selected.closed}
                        onChange={(event) =>
                          updateSelected({ closed: event.target.checked })
                        }
                      />
                      {t("closePath")}
                    </label>
                    <p className="text-xs text-slate-500">{t("curveHint")}</p>
                  </>
                )}
                {(selected.kind === "path") &&
                  selectedVertex !== null && (
                    <button
                      type="button"
                      data-testid="map-remove-vertex"
                      onClick={() => {
                        const next = removePolygonVertex(
                          selected,
                          selectedVertex,
                        );
                        updateSelected({ points: next.points });
                        setSelectedVertex(
                          Math.min(selectedVertex, next.points.length - 1),
                        );
                      }}
                      className="w-full rounded border border-slate-200 px-3 py-2 text-sm text-slate-700"
                    >
                      {t("removeVertex")}
                    </button>
                  )}
                {(selected.kind === "rectangle" ||
                  selected.kind === "path") && (
                  <>
                    <label className="block text-xs font-medium text-slate-600">
                      {t("fillMode")}
                      <select
                        data-testid="map-object-fill-mode"
                        value={selected.fillMode ?? "none"}
                        onChange={(event) => {
                          const fillMode = event.target
                            .value as MapFillMode;
                          updateSelected({
                            fillMode,
                            ...(fillMode === "solid" && !selected.fill
                              ? { fill: "#ffffff" }
                              : {}),
                            ...(selected.kind === "path" &&
                            (fillMode === "outOfBounds" ||
                              fillMode === "whiteout")
                              ? { closed: true }
                              : {}),
                          });
                        }}
                        className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
                      >
                        <option value="none">{t("fillModeNone")}</option>
                        <option value="solid">{t("fillModeSolid")}</option>
                        <option value="whiteout">{t("fillModeWhiteout")}</option>
                        <option value="outOfBounds">
                          {t("fillModeOutOfBounds")}
                        </option>
                      </select>
                    </label>
                    {selected.fillMode === "solid" && (
                      <label className="block text-xs font-medium text-slate-600">
                        {t("fillColor")}
                        <input
                          type="color"
                          data-testid="map-object-fill-color"
                          value={selected.fill ?? "#ffffff"}
                          onChange={(event) =>
                            updateSelected({ fill: event.target.value })
                          }
                          className="mt-1 h-9 w-full rounded border border-slate-300"
                        />
                      </label>
                    )}
                    <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
                      <input
                        type="checkbox"
                        data-testid="map-object-border"
                        checked={selected.stroke !== undefined}
                        onChange={(event) =>
                          updateSelected(
                            event.target.checked
                              ? {
                                  stroke: selected.stroke ?? "#000000",
                                  strokeWidthMm:
                                    selected.strokeWidthMm ?? 0.35,
                                }
                              : {
                                  stroke: undefined,
                                  strokeWidthMm: undefined,
                                },
                          )
                        }
                      />
                      {t("showBorder")}
                    </label>
                  </>
                )}
                {(selected.kind === "line" ||
                  ((selected.kind === "path" ||
                    selected.kind === "rectangle") &&
                    selected.stroke !== undefined)) && (
                  <>
                    <label className="block text-xs font-medium text-slate-600">
                      {t("strokeColor")}
                      <input
                        type="color"
                        value={
                          selected.kind === "line"
                            ? selected.stroke
                            : (selected.stroke ?? "#000000")
                        }
                        onChange={(event) =>
                          updateSelected({ stroke: event.target.value })
                        }
                        className="mt-1 h-9 w-full rounded border border-slate-300"
                      />
                    </label>
                    <label className="block text-xs font-medium text-slate-600">
                      {t("strokeWidth")}
                      <input
                        type="number"
                        min={0.1}
                        max={20}
                        step={0.1}
                        value={
                          selected.kind === "line"
                            ? selected.strokeWidthMm
                            : (selected.strokeWidthMm ?? 0.35)
                        }
                        onChange={(event) =>
                          updateSelected({
                            strokeWidthMm: Number(event.target.value),
                          })
                        }
                        className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
                      />
                    </label>
                  </>
                )}
                <button
                  type="button"
                  data-testid="map-object-delete"
                  onClick={() => deleteObjectById(selected.id)}
                  className="w-full rounded border border-red-200 px-3 py-2 text-sm text-red-700 hover:bg-red-50"
                >
                  {t("deleteObject")}
                </button>
              </div>
            ) : (
              <p className="text-sm text-slate-500">{t("noSelection")}</p>
            )}
            {saveError && (
              <p className="mt-4 text-sm text-red-600" role="alert">
                {saveError}
              </p>
            )}
          </EditorPanel>
        </div>

        <main className="absolute inset-0 overflow-hidden p-4">
          {previewError && (
            <div
              role="alert"
              className="mx-auto mb-3 flex max-w-5xl items-center justify-between rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700"
            >
              {t("previewError")}
              <button
                type="button"
                onClick={() => setPreviewErrorUrl(null)}
                className="font-medium"
              >
                {t("dismiss")}
              </button>
            </div>
          )}
          <div className="h-full w-full">
            <svg
              ref={paperSvgRef}
              data-testid="map-paper"
              viewBox={`${viewport.x} ${viewport.y} ${viewport.width} ${viewport.height}`}
              width="100%"
              height="100%"
              preserveAspectRatio="xMidYMid meet"
              onPointerMove={onPointerMove}
              onPointerUp={finishDrag}
              onPointerCancel={finishDrag}
              onPointerDownCapture={(event) => {
                if (placingGraphicId !== null) {
                  event.preventDefault();
                  event.stopPropagation();
                  addObject(
                    createImageObjectAt(
                      placingGraphicId,
                      pagePoint(event),
                      printable,
                    ),
                  );
                  return;
                }
                if (tool === "select" || tool === "pan") return;
                event.preventDefault();
                event.stopPropagation();
                placeObject(tool, pagePoint(event));
              }}
              onWheel={(event) => {
                event.preventDefault();
                const anchor = pagePoint(event);
                setViewport((current) =>
                  zoomEditorViewport(
                    current,
                    paper,
                    anchor,
                    current.zoom * (event.deltaY > 0 ? 0.9 : 1.1),
                  ),
                );
              }}
              onPointerDown={(event) => {
                // Native non-passive touch handlers own empty-canvas
                // gestures; pointer events remain responsible for objects.
                if (event.pointerType === "touch") {
                  if (tool === "pan") beginDrag("pan", event);
                  return;
                }
                if (tool === "pan") beginDrag("pan", event);
                else {
                  setSelectedId(null);
                  setSelectedVertex(null);
                  if (tool === "select" && viewport.zoom > 1) {
                    beginDrag("viewport", event);
                  }
                }
              }}
              className={`h-full w-full bg-transparent ${
                placingGraphicId !== null ||
                (tool !== "select" && tool !== "pan")
                  ? "cursor-crosshair"
                  : tool === "pan" || (tool === "select" && viewport.zoom > 1)
                  ? "cursor-grab"
                  : "cursor-default"
              }`}
              style={{
                touchAction:
                  tool === "pan"
                    ? "none"
                    : isCoarsePointer && !isFullscreen
                      ? "pan-y"
                      : "none",
              }}
            >
              <defs>
                <filter
                  id="map-paper-shadow"
                  x="-20%"
                  y="-20%"
                  width="140%"
                  height="140%"
                >
                  <feDropShadow
                    dx="0"
                    dy="2"
                    stdDeviation="3"
                    floodColor="#0f172a"
                    floodOpacity="0.2"
                  />
                </filter>
                <clipPath id="map-editor-frame">
                  <rect
                    x={document.mapFrame.x}
                    y={document.mapFrame.y}
                    width={document.mapFrame.width}
                    height={document.mapFrame.height}
                  />
                </clipPath>
              </defs>
              <rect
                data-testid="map-paper-sheet"
                width={paper.width}
                height={paper.height}
                fill="#ffffff"
                filter="url(#map-paper-shadow)"
              />
              <g clipPath="url(#map-editor-frame)">
                {displayedPreview &&
                  (() => {
                    // Reposition the displayed raster through the current
                    // window so map and course overlay move as one while
                    // dragging; the fresh raster then swaps in seamlessly.
                    const placement = displayedPreviewPlacement(
                      displayedPreview,
                      history.present.printScale,
                      document.mapFrame,
                      currentWindow,
                    );
                    return (
                      <>
                        <image
                          data-testid="map-preview-image"
                          href={displayedPreview.url}
                          x={placement.x}
                          y={placement.y}
                          width={placement.width}
                          height={placement.height}
                          preserveAspectRatio="none"
                        />
                        <g
                          data-testid="map-course-overlay-lower"
                          pointerEvents="none"
                          style={{ userSelect: "none" }}
                          dangerouslySetInnerHTML={{
                            __html: courseOverlaySvg.lower,
                          }}
                        />
                        <image
                          data-testid="map-preview-ink"
                          href={displayedPreview.inkUrl}
                          x={placement.x}
                          y={placement.y}
                          width={placement.width}
                          height={placement.height}
                          preserveAspectRatio="none"
                          pointerEvents="none"
                        />
                      </>
                    );
                  })()}
                <g opacity={mode === "map" ? 0.65 : 1}>
                  {history.present.templateObjects
                    .filter(
                      (object) =>
                        object.anchor === "map" &&
                        isWhiteoutObject(object),
                    )
                    .map((object) =>
                      renderObject(
                        previewObject(object),
                        document.mapFrame,
                        currentWindow,
                        objectDragHandler(object, mode === "template"),
                        graphicHref,
                        document.appearance.purple,
                      ),
                    )}
                </g>
                {history.present.objects
                  .filter(
                    (object) =>
                      object.anchor === "map" &&
                      isWhiteoutObject(object),
                  )
                  .map((object) =>
                    renderObject(
                      previewObject(object),
                      document.mapFrame,
                      currentWindow,
                      objectDragHandler(object, mode === "map"),
                      graphicHref,
                      document.appearance.purple,
                    ),
                  )}
              </g>
              <g opacity={mode === "map" ? 0.65 : 1}>
                {history.present.templateObjects
                  .filter(
                    (object) =>
                      object.anchor === "page" &&
                      isWhiteoutObject(object),
                  )
                  .map((object) =>
                    renderObject(
                      previewObject(object),
                      document.mapFrame,
                      currentWindow,
                      objectDragHandler(object, mode === "template"),
                      graphicHref,
                      document.appearance.purple,
                    ),
                  )}
              </g>
              {history.present.objects
                .filter(
                  (object) =>
                    object.anchor === "page" &&
                    isWhiteoutObject(object),
                )
                .map((object) =>
                  renderObject(
                    previewObject(object),
                    document.mapFrame,
                    currentWindow,
                    objectDragHandler(object, mode === "map"),
                    graphicHref,
                    document.appearance.purple,
                  ),
                )}
              <g clipPath="url(#map-editor-frame)">
                {/* Generated from validated colours and escaped labels only.
                    pointer-events/user-select off: clicking overlay text
                    otherwise places a blinking text caret in the SVG. */}
                <g
                  data-testid="map-course-overlay"
                  pointerEvents="none"
                  style={{ userSelect: "none" }}
                  dangerouslySetInnerHTML={{ __html: courseOverlaySvg.upper }}
                />
                <g opacity={mode === "map" ? 0.65 : 1}>
                  {history.present.templateObjects
                    .filter(
                      (object) =>
                        object.anchor === "map" &&
                        !isWhiteoutObject(object),
                    )
                    .map((object) =>
                      renderObject(
                        previewObject(object),
                        document.mapFrame,
                        currentWindow,
                        objectDragHandler(object, mode === "template"),
                        graphicHref,
                        document.appearance.purple,
                      ),
                    )}
                </g>
                {history.present.objects
                  .filter(
                    (object) =>
                      object.anchor === "map" &&
                      !isWhiteoutObject(object),
                  )
                  .map((object) =>
                    renderObject(
                      previewObject(object),
                      document.mapFrame,
                      currentWindow,
                      objectDragHandler(object, mode === "map"),
                      graphicHref,
                      document.appearance.purple,
                    ),
                  )}
              </g>
              <g opacity={mode === "map" ? 0.65 : 1}>
                {history.present.templateObjects
                  .filter(
                    (object) =>
                      object.anchor === "page" &&
                      !isWhiteoutObject(object),
                  )
                  .map((object) =>
                    renderObject(
                      previewObject(object),
                      document.mapFrame,
                      currentWindow,
                      objectDragHandler(object, mode === "template"),
                      graphicHref,
                      document.appearance.purple,
                    ),
                  )}
              </g>
              {history.present.objects
                .filter(
                  (object) =>
                    object.anchor === "page" &&
                    !isWhiteoutObject(object),
                )
                .map((object) =>
                  renderObject(
                    previewObject(object),
                    document.mapFrame,
                    currentWindow,
                    objectDragHandler(object, mode === "map"),
                    graphicHref,
                    document.appearance.purple,
                  ),
                )}
              {history.present.description.visible && (
                <g
                  data-testid="map-description-block"
                  data-map-editor-target="true"
                  onPointerDown={(event) => beginDrag("description", event)}
                  className="cursor-move"
                  style={{ touchAction: "none" }}
                >
                  {/* Shared renderer output: escaped labels + IOF symbol
                      fragments only, same markup as the printed PDF.
                      user-select off so clicking text can't place a caret. */}
                  <g
                    style={{ userSelect: "none" }}
                    dangerouslySetInnerHTML={{ __html: descriptionBlockSvg }}
                  />
                  <rect
                    x={history.present.description.x}
                    y={history.present.description.y}
                    width={descriptionSize.width}
                    height={descriptionSize.height}
                    fill="transparent"
                    stroke="none"
                  />
                  {isCoarsePointer && (
                    <circle
                      cx={history.present.description.x + descriptionSize.width}
                      cy={history.present.description.y + descriptionSize.height}
                      r={5}
                      fill="transparent"
                      data-map-editor-target="true"
                      onPointerDown={(event) =>
                        beginDrag("resize-description", event)
                      }
                      style={{ touchAction: "none" }}
                    />
                  )}
                  <circle
                    data-testid="map-description-resize"
                    data-map-editor-target="true"
                    cx={history.present.description.x + descriptionSize.width}
                    cy={history.present.description.y + descriptionSize.height}
                    r={1.4}
                    fill="#ffffff"
                    stroke="#2563eb"
                    strokeWidth={0.45}
                    onPointerDown={(event) =>
                      beginDrag("resize-description", event)
                    }
                    className="cursor-nwse-resize"
                    style={{ touchAction: "none" }}
                  />
                </g>
              )}
              {selected &&
                (() => {
                  const bounds = objectBounds(
                    selected,
                    document.mapFrame,
                    currentWindow,
                  );
                  return (
                    <g>
                      <rect
                        x={bounds.x - 1}
                        y={bounds.y - 1}
                        width={bounds.width + 2}
                        height={bounds.height + 2}
                        fill="none"
                        stroke="#2563eb"
                        strokeWidth={0.5}
                        strokeDasharray="2 1"
                        pointerEvents="none"
                      />
                      {objectResizeHandles(
                        selected,
                        bounds,
                        document.mapFrame,
                        currentWindow,
                      )
                        // Event callbacks access dragRef only after pointer-down.
                        .map(({ x, y, handle }) => (
                          <g key={handle}>
                          {isCoarsePointer && (
                            <circle
                              cx={x}
                              cy={y}
                              r={5}
                              fill="transparent"
                              data-map-editor-target="true"
                              onPointerDown={(event) => {
                                if (handle.startsWith("vertex-")) {
                                  setSelectedVertex(
                                    Number(handle.replace("vertex-", "")),
                                  );
                                }
                                beginDrag(
                                  "resize-object",
                                  event,
                                  selected.id,
                                  handle,
                                );
                              }}
                              style={{ touchAction: "none" }}
                            />
                          )}
                          <circle
                            data-testid={`map-resize-${handle}`}
                            data-map-editor-target="true"
                            cx={x}
                            cy={y}
                            r={1.2}
                            fill="#ffffff"
                            stroke="#2563eb"
                            strokeWidth={0.45}
                            onPointerDown={(event) => {
                              if (handle.startsWith("vertex-")) {
                                setSelectedVertex(
                                  Number(handle.replace("vertex-", "")),
                                );
                              }
                              beginDrag(
                                "resize-object",
                                event,
                                selected.id,
                                handle,
                              );
                            }}
                            className="cursor-nwse-resize"
                            style={{ touchAction: "none" }}
                          />
                          </g>
                        ))}
                      {(selected.kind === "path") &&
                        (() => {
                          const vertices = pathVerticesForPage(
                            selected,
                            document.mapFrame,
                            currentWindow,
                          );
                          const closed = selected.closed;
                          const edgeCount = closed
                            ? vertices.length
                            : vertices.length - 1;
                          return (
                            <>
                              {Array.from({ length: edgeCount }, (_, index) => {
                                const a = vertices[index];
                                const b =
                                  vertices[(index + 1) % vertices.length];
                                return (
                                  <g key={`edge-${index}`}>
                                  {isCoarsePointer && (
                                    <circle
                                      cx={(a.x + b.x) / 2}
                                      cy={(a.y + b.y) / 2}
                                      r={5}
                                      fill="transparent"
                                      data-map-editor-target="true"
                                      onPointerDown={(event) => {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        const next = insertPolygonVertex(
                                          selected,
                                          index,
                                        );
                                        updateSelected({ points: next.points });
                                        setSelectedVertex(index + 1);
                                      }}
                                      style={{ touchAction: "none" }}
                                    />
                                  )}
                                  <circle
                                    data-testid={`map-add-vertex-${index}`}
                                    data-map-editor-target="true"
                                    cx={(a.x + b.x) / 2}
                                    cy={(a.y + b.y) / 2}
                                    r={0.9}
                                    fill="#ffffff"
                                    stroke="#60a5fa"
                                    strokeWidth={0.35}
                                    style={{ touchAction: "none" }}
                                    onPointerDown={(event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      const next = insertPolygonVertex(
                                        selected,
                                        index,
                                      );
                                      updateSelected({ points: next.points });
                                      setSelectedVertex(index + 1);
                                    }}
                                  />
                                  </g>
                                );
                              })}
                              {selectedVertex !== null &&
                                (() => {
                                  const vertex = vertices[selectedVertex];
                                  if (!vertex) return null;
                                  return (["hIn", "hOut"] as const).map(
                                    (key) => {
                                      const offset = vertex[key];
                                      if (!offset) return null;
                                      const x = vertex.x + offset.x;
                                      const y = vertex.y + offset.y;
                                      const handle =
                                        `${key === "hIn" ? "handle-in" : "handle-out"}-${selectedVertex}` as ResizeHandle;
                                      return (
                                        <g key={handle}>
                                          <line
                                            x1={vertex.x}
                                            y1={vertex.y}
                                            x2={x}
                                            y2={y}
                                            stroke="#60a5fa"
                                            strokeWidth={0.3}
                                            pointerEvents="none"
                                          />
                                          {isCoarsePointer && (
                                            <circle
                                              cx={x}
                                              cy={y}
                                              r={5}
                                              fill="transparent"
                                              data-map-editor-target="true"
                                              onPointerDown={(event) =>
                                                beginDrag(
                                                  "resize-object",
                                                  event,
                                                  selected.id,
                                                  handle,
                                                )
                                              }
                                              style={{ touchAction: "none" }}
                                            />
                                          )}
                                          <circle
                                            data-testid={`map-resize-${handle}`}
                                            data-map-editor-target="true"
                                            cx={x}
                                            cy={y}
                                            r={1}
                                            fill="#dbeafe"
                                            stroke="#2563eb"
                                            strokeWidth={0.35}
                                            style={{ touchAction: "none" }}
                                            onPointerDown={(event) =>
                                              beginDrag(
                                                "resize-object",
                                                event,
                                                selected.id,
                                                handle,
                                              )
                                            }
                                          />
                                        </g>
                                      );
                                    },
                                  );
                                })()}
                            </>
                          );
                        })()}
                    </g>
                  );
                })()}
              <rect
                data-testid="map-printable-area"
                x={printable.x}
                y={printable.y}
                width={printable.width}
                height={printable.height}
                fill="none"
                stroke="#ef4444"
                strokeWidth={0.35}
                strokeDasharray="2 1"
                pointerEvents="none"
              />
            </svg>
          </div>
        </main>

      </div>
    </div>
  );
}

export type { EditorSnapshot as MapLayoutSnapshot };
