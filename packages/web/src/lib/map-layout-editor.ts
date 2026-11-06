import {
  courseMapObjectPageBounds,
  mapToPage,
  pageToMap,
  rectInside,
  OUT_OF_BOUNDS_BORDER_MM,
  type CourseMapObject,
  type DescriptionBlockSettings,
  type MapFillMode,
  type MapPoint,
  type MapRect,
  type MapWindow,
} from "@oxygen/shared";

export type ResizeHandle =
  | "nw"
  | "ne"
  | "sw"
  | "se"
  | "start"
  | "end"
  | `vertex-${number}`
  | `edge-${number}`
  | `handle-in-${number}`
  | `handle-out-${number}`;

export type PlaceableMapObjectKind =
  | "text"
  | "line"
  | "rectangle"
  | "path";

/** Uploaded graphic placed at `point`, clamped inside the printable area. */
export function createImageObjectAt(
  graphicId: number,
  point: MapPoint,
  printable: MapRect,
): CourseMapObject {
  const width = Math.min(30, printable.width);
  const height = Math.min(30, printable.height);
  const x = Math.max(
    printable.x,
    Math.min(printable.x + printable.width - width, point.x - width / 2),
  );
  const y = Math.max(
    printable.y,
    Math.min(printable.y + printable.height - height, point.y - height / 2),
  );
  return {
    id: crypto.randomUUID(),
    kind: "image",
    anchor: "page",
    graphicId,
    x,
    y,
    width,
    height,
  };
}

export function createObjectAt(
  kind: PlaceableMapObjectKind,
  point: MapPoint,
  printable: MapRect,
): CourseMapObject {
  const x = Math.max(printable.x, Math.min(printable.x + printable.width, point.x));
  const y = Math.max(printable.y, Math.min(printable.y + printable.height, point.y));
  const id = crypto.randomUUID();
  if (kind === "text") {
    return {
      id,
      kind,
      anchor: "page",
      x: Math.min(x, printable.x + printable.width - 20),
      y,
      text: "{course}",
      fontSizeMm: 4,
      color: "#000000",
      fontFamily: "sans",
    };
  }
  if (kind === "line") {
    const half = Math.min(15, printable.width / 2);
    const centerX = Math.max(
      printable.x + half,
      Math.min(printable.x + printable.width - half, x),
    );
    return {
      id,
      kind: "path",
      anchor: "page",
      points: [
        { x: centerX - half, y },
        { x: centerX + half, y },
      ],
      stroke: "#000000",
      strokeWidthMm: 0.35,
      fillMode: "none",
      closed: false,
    };
  }
  const halfWidth = Math.min(15, printable.width / 2);
  const halfHeight = Math.min(8, printable.height / 2);
  const centerX = Math.max(
    printable.x + halfWidth,
    Math.min(printable.x + printable.width - halfWidth, x),
  );
  const centerY = Math.max(
    printable.y + halfHeight,
    Math.min(printable.y + printable.height - halfHeight, y),
  );
  if (kind === "rectangle") {
    return {
      id,
      kind,
      anchor: "page",
      x: centerX - halfWidth,
      y: centerY - halfHeight,
      width: halfWidth * 2,
      height: halfHeight * 2,
      stroke: "#000000",
      strokeWidthMm: 0.35,
      fillMode: "none",
    };
  }
  return {
    id,
    kind: "path",
    anchor: "page",
    points: [
      { x: centerX - halfWidth, y: centerY - halfHeight },
      { x: centerX + halfWidth, y: centerY - halfHeight },
      { x: centerX + halfWidth * 0.8, y: centerY + halfHeight },
      { x: centerX - halfWidth * 0.8, y: centerY + halfHeight },
    ],
    stroke: "#000000",
    strokeWidthMm: 0.35,
    fillMode: "none",
    closed: true,
  };
}

function pageDeltaToObject(
  anchor: CourseMapObject["anchor"],
  pageDx: number,
  pageDy: number,
  frame: MapRect,
  window: MapWindow,
): MapPoint {
  return anchor === "map"
    ? {
        x: (pageDx / frame.width) * window.width,
        y: (-pageDy / frame.height) * window.height,
      }
    : { x: pageDx, y: pageDy };
}

export function translateMapObject(
  object: CourseMapObject,
  pageDx: number,
  pageDy: number,
  frame: MapRect,
  window: MapWindow,
): CourseMapObject {
  const delta = pageDeltaToObject(object.anchor, pageDx, pageDy, frame, window);
  switch (object.kind) {
    case "text":
    case "rectangle":
    case "image":
      return { ...object, x: object.x + delta.x, y: object.y + delta.y };
    case "line":
      return {
        ...object,
        x1: object.x1 + delta.x,
        y1: object.y1 + delta.y,
        x2: object.x2 + delta.x,
        y2: object.y2 + delta.y,
      };
    case "path":
      return {
        ...object,
        points: object.points.map((point) => ({
          ...point,
          x: point.x + delta.x,
          y: point.y + delta.y,
        })),
      };
  }
}

const MIN_SIZE_MM = 2;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function resizedBounds(
  bounds: MapRect,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  printable?: MapRect,
): MapRect {
  let left = bounds.x;
  let right = bounds.x + bounds.width;
  let top = bounds.y;
  let bottom = bounds.y + bounds.height;
  const minX = printable?.x ?? -Infinity;
  const maxX = printable ? printable.x + printable.width : Infinity;
  const minY = printable?.y ?? -Infinity;
  const maxY = printable ? printable.y + printable.height : Infinity;
  if (handle.includes("w")) {
    left = clamp(left + dx, minX, right - MIN_SIZE_MM);
  }
  if (handle.includes("e")) {
    right = clamp(right + dx, left + MIN_SIZE_MM, maxX);
  }
  if (handle.includes("n")) {
    top = clamp(top + dy, minY, bottom - MIN_SIZE_MM);
  }
  if (handle.includes("s")) {
    bottom = clamp(bottom + dy, top + MIN_SIZE_MM, maxY);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Clamp a page-space point into the printable area. */
export function clampPagePoint(point: MapPoint, printable: MapRect): MapPoint {
  return {
    x: clamp(point.x, printable.x, printable.x + printable.width),
    y: clamp(point.y, printable.y, printable.y + printable.height),
  };
}

function pagePointToNative(
  object: CourseMapObject,
  point: MapPoint,
  frame: MapRect,
  window: MapWindow,
): MapPoint {
  return object.anchor === "page" ? point : pageToMap(point, frame, window);
}

export type ImageResizeMode = "proportional" | "free" | "crop";

export interface ResizeMapObjectOptions {
  printable?: MapRect;
  /** Image-only: default free; Ctrl/Cmd = proportional; Shift = crop. */
  imageMode?: ImageResizeMode;
}

/**
 * Apply a page-space resize. When `printable` is set, moving edges and
 * vertices are clamped so the object cannot grow out the opposite side.
 */
export function resizeMapObject(
  object: CourseMapObject,
  handle: ResizeHandle,
  pageDx: number,
  pageDy: number,
  frame: MapRect,
  window: MapWindow,
  options: ResizeMapObjectOptions = {},
): CourseMapObject {
  const { printable, imageMode = "free" } = options;

  if (object.kind === "line") {
    const pageStart =
      object.anchor === "page"
        ? { x: object.x1, y: object.y1 }
        : mapToPage({ x: object.x1, y: object.y1 }, frame, window);
    const pageEnd =
      object.anchor === "page"
        ? { x: object.x2, y: object.y2 }
        : mapToPage({ x: object.x2, y: object.y2 }, frame, window);
    let moved =
      handle === "start"
        ? { x: pageStart.x + pageDx, y: pageStart.y + pageDy }
        : { x: pageEnd.x + pageDx, y: pageEnd.y + pageDy };
    if (printable) moved = clampPagePoint(moved, printable);
    const native = pagePointToNative(object, moved, frame, window);
    return handle === "start"
      ? { ...object, x1: native.x, y1: native.y }
      : { ...object, x2: native.x, y2: native.y };
  }

  if (object.kind === "path") {
    const index =
      handle === "start"
        ? 0
        : handle === "end"
          ? object.points.length - 1
          : Number(handle.replace("vertex-", ""));
    if (!Number.isInteger(index) || !object.points[index]) return object;
    const point = object.points[index];
    const pagePoint =
      object.anchor === "page"
        ? { x: point.x, y: point.y }
        : mapToPage({ x: point.x, y: point.y }, frame, window);
    let moved = { x: pagePoint.x + pageDx, y: pagePoint.y + pageDy };
    if (printable) moved = clampPagePoint(moved, printable);
    const native = pagePointToNative(object, moved, frame, window);
    return {
      ...object,
      points: object.points.map((entry, pointIndex) =>
        pointIndex === index ? { ...entry, x: native.x, y: native.y } : entry,
      ),
    };
  }

  const bounds = courseMapObjectPageBounds(object, frame, window);
  if (!bounds) return object;

  if (object.kind === "text") {
    const next = resizedBounds(bounds, handle, pageDx, pageDy, printable);
    return {
      ...object,
      maxWidthMm: next.width,
      fontSizeMm: Math.max(1, Math.min(100, next.height / 1.25)),
    };
  }

  if (object.kind === "image" && imageMode === "crop") {
    return cropImageObject(object, bounds, handle, pageDx, pageDy, printable);
  }

  let next = resizedBounds(bounds, handle, pageDx, pageDy, printable);
  if (object.kind === "image" && imageMode === "proportional") {
    next = proportionalBounds(bounds, next, handle, printable);
  }

  if (object.anchor === "page") {
    return { ...object, x: next.x, y: next.y, width: next.width, height: next.height };
  }
  const topLeft = pagePointToNative(object, { x: next.x, y: next.y }, frame, window);
  const bottomRight = pagePointToNative(
    object,
    { x: next.x + next.width, y: next.y + next.height },
    frame,
    window,
  );
  return {
    ...object,
    x: topLeft.x,
    y: bottomRight.y,
    width: bottomRight.x - topLeft.x,
    height: topLeft.y - bottomRight.y,
  };
}

/** Keep aspect ratio while clamping the result inside `printable`. */
function proportionalBounds(
  original: MapRect,
  proposed: MapRect,
  handle: ResizeHandle,
  printable?: MapRect,
): MapRect {
  const aspect = original.width / Math.max(original.height, 0.001);
  let width = proposed.width;
  let height = proposed.height;
  // Prefer the dominant axis of the drag.
  if (Math.abs(proposed.width - original.width) >= Math.abs(proposed.height - original.height)) {
    height = width / aspect;
  } else {
    width = height * aspect;
  }
  width = Math.max(MIN_SIZE_MM, width);
  height = Math.max(MIN_SIZE_MM, height);

  let x = original.x;
  let y = original.y;
  if (handle.includes("w")) x = original.x + original.width - width;
  else if (!handle.includes("e")) x = original.x + (original.width - width) / 2;
  if (handle.includes("n")) y = original.y + original.height - height;
  else if (!handle.includes("s")) y = original.y + (original.height - height) / 2;

  if (printable) {
    if (x < printable.x) x = printable.x;
    if (y < printable.y) y = printable.y;
    if (x + width > printable.x + printable.width) {
      width = printable.x + printable.width - x;
      height = width / aspect;
    }
    if (y + height > printable.y + printable.height) {
      height = printable.y + printable.height - y;
      width = height * aspect;
    }
    width = Math.max(MIN_SIZE_MM, width);
    height = Math.max(MIN_SIZE_MM, height);
    if (handle.includes("w")) x = original.x + original.width - width;
    if (handle.includes("n")) y = original.y + original.height - height;
  }
  return { x, y, width, height };
}

/**
 * Shift-drag: move the frame edge and shrink the crop window so the visible
 * content stays put relative to the page.
 */
function cropImageObject(
  object: Extract<CourseMapObject, { kind: "image" }>,
  bounds: MapRect,
  handle: ResizeHandle,
  pageDx: number,
  pageDy: number,
  printable?: MapRect,
): CourseMapObject {
  const crop = object.crop ?? { x: 0, y: 0, width: 1, height: 1 };
  const next = resizedBounds(bounds, handle, pageDx, pageDy, printable);
  const dxFrac = (next.x - bounds.x) / Math.max(bounds.width, 0.001);
  const dyFrac = (next.y - bounds.y) / Math.max(bounds.height, 0.001);
  const dwFrac = (next.width - bounds.width) / Math.max(bounds.width, 0.001);
  const dhFrac = (next.height - bounds.height) / Math.max(bounds.height, 0.001);

  let cropX = crop.x;
  let cropY = crop.y;
  let cropW = crop.width;
  let cropH = crop.height;
  if (handle.includes("w")) {
    cropX = clamp(crop.x + dxFrac * crop.width, 0, crop.x + crop.width - 0.05);
    cropW = crop.x + crop.width - cropX;
  }
  if (handle.includes("e")) {
    cropW = clamp(crop.width + dwFrac * crop.width, 0.05, 1 - crop.x);
  }
  if (handle.includes("n")) {
    cropY = clamp(crop.y + dyFrac * crop.height, 0, crop.y + crop.height - 0.05);
    cropH = crop.y + crop.height - cropY;
  }
  if (handle.includes("s")) {
    cropH = clamp(crop.height + dhFrac * crop.height, 0.05, 1 - crop.y);
  }

  if (object.anchor === "page") {
    return {
      ...object,
      x: next.x,
      y: next.y,
      width: next.width,
      height: next.height,
      crop: { x: cropX, y: cropY, width: cropW, height: cropH },
    };
  }
  return {
    ...object,
    crop: { x: cropX, y: cropY, width: cropW, height: cropH },
  };
}

export function constrainMapObject(
  object: CourseMapObject,
  printable: MapRect,
  frame: MapRect,
  window: MapWindow,
): CourseMapObject {
  const bounds = courseMapObjectPageBounds(object, frame, window);
  if (!bounds || rectInside(bounds, printable)) return object;
  let dx = 0;
  let dy = 0;
  if (bounds.x < printable.x) dx = printable.x - bounds.x;
  if (bounds.x + bounds.width > printable.x + printable.width) {
    dx = printable.x + printable.width - (bounds.x + bounds.width);
  }
  if (bounds.y < printable.y) dy = printable.y - bounds.y;
  if (bounds.y + bounds.height > printable.y + printable.height) {
    dy = printable.y + printable.height - (bounds.y + bounds.height);
  }
  return translateMapObject(object, dx, dy, frame, window);
}

export function constrainDescription(
  description: DescriptionBlockSettings,
  width: number,
  height: number,
  printable: MapRect,
): DescriptionBlockSettings {
  return {
    ...description,
    x: Math.min(
      printable.x + Math.max(0, printable.width - width),
      Math.max(printable.x, description.x),
    ),
    y: Math.min(
      printable.y + Math.max(0, printable.height - height),
      Math.max(printable.y, description.y),
    ),
  };
}

export function parseClampedNumberDraft(
  draft: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (draft.trim() === "") return fallback;
  const value = Number(draft);
  return Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
}

type FillableObject = Extract<CourseMapObject, { kind: "path" | "rectangle" }>;

/**
 * Patch applied when the user changes Fill mode on a rect/path. Locks
 * out-of-bounds borders to the course purple at 0.4 mm, closes paths for
 * area fills, and seeds a solid fill colour when needed.
 */
export function fillModePatch(
  object: FillableObject,
  fillMode: MapFillMode,
  purple: string,
): Partial<FillableObject> {
  const patch: Record<string, unknown> = { fillMode };
  if (object.kind === "path" && (
    fillMode === "outOfBounds" ||
    fillMode === "whiteout" ||
    fillMode === "whiteoutInverted"
  )) {
    patch.closed = true;
  }
  if (fillMode === "solid" && !object.fill) {
    patch.fill = "#ffffff";
  }
  if (fillMode === "outOfBounds") {
    patch.stroke = purple;
    patch.strokeWidthMm = OUT_OF_BOUNDS_BORDER_MM;
  }
  return patch as Partial<FillableObject>;
}

