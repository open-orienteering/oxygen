import type {
  MapPoint,
  MapRect,
  MapWindow,
  PaperOrientation,
  PaperSize,
} from "./schema.js";

export interface PaperDimensions {
  width: number;
  height: number;
}

const PAPER_DIMENSIONS: Record<Exclude<PaperSize, "custom">, PaperDimensions> = {
  A3: { width: 297, height: 420 },
  A4: { width: 210, height: 297 },
  A5: { width: 148, height: 210 },
};

export function getPaperDimensions(
  paper: PaperSize,
  orientation: PaperOrientation,
  custom?: PaperDimensions,
): PaperDimensions {
  const base = paper === "custom" ? custom : PAPER_DIMENSIONS[paper];
  if (!base || base.width <= 0 || base.height <= 0) {
    throw new Error("Custom paper dimensions must be positive");
  }
  const portrait =
    base.width <= base.height
      ? base
      : { width: base.height, height: base.width };
  return orientation === "portrait"
    ? portrait
    : { width: portrait.height, height: portrait.width };
}

export function defaultMapFrame(
  paper: PaperDimensions,
  marginMm: number,
): MapRect {
  if (marginMm < 0) throw new Error("Margin cannot be negative");
  const width = paper.width - marginMm * 2;
  const height = paper.height - marginMm * 2;
  if (width <= 0 || height <= 0) {
    throw new Error("Margin leaves no printable map area");
  }
  return { x: marginMm, y: marginMm, width, height };
}

export function printScaleRatio(
  baseMapScale: number,
  printScale: number,
): number {
  if (baseMapScale <= 0 || printScale <= 0) {
    throw new Error("Map scales must be positive");
  }
  return baseMapScale / printScale;
}

export function mapWindowForFrame(
  frame: MapRect,
  center: MapPoint,
  baseMapScale: number,
  printScale: number,
  rotationDeg = 0,
): MapWindow {
  const ratio = printScaleRatio(baseMapScale, printScale);
  const width = frame.width / ratio;
  const height = frame.height / ratio;
  return {
    minX: center.x - width / 2,
    minY: center.y - height / 2,
    width,
    height,
    ...(rotationDeg === 0 ? {} : { rotationDeg }),
  };
}

/** Effective page-space rotation of a window, treating tiny angles as 0. */
export function windowRotationDeg(window: MapWindow): number {
  const rotation = window.rotationDeg ?? 0;
  return Math.abs(rotation) < 0.05 ? 0 : rotation;
}

/** Rotate `point` about `center` by `deg` in page space (y-down, CW+). */
function rotatePagePoint(
  point: MapPoint,
  center: MapPoint,
  deg: number,
): MapPoint {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos,
  };
}

/**
 * Axis-aligned map-space window covering the rotated window. Used to crop
 * the base map SVG so that after rotation the whole frame is covered.
 */
export function windowBoundingBox(window: MapWindow): MapWindow {
  const rotation = windowRotationDeg(window);
  if (rotation === 0) {
    return {
      minX: window.minX,
      minY: window.minY,
      width: window.width,
      height: window.height,
    };
  }
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const width = window.width * cos + window.height * sin;
  const height = window.width * sin + window.height * cos;
  const cx = window.minX + window.width / 2;
  const cy = window.minY + window.height / 2;
  return {
    minX: cx - width / 2,
    minY: cy - height / 2,
    width,
    height,
  };
}

/**
 * Map coordinates use a conventional y-up axis. Page SVG coordinates use
 * y-down, hence the vertical inversion. When the window carries a
 * `rotationDeg`, the result is additionally rotated about the frame centre
 * (the map content is drawn rotated so display north points up).
 */
export function mapToPage(
  point: MapPoint,
  frame: MapRect,
  window: MapWindow,
): MapPoint {
  const base = {
    x: frame.x + ((point.x - window.minX) / window.width) * frame.width,
    y:
      frame.y +
      ((window.minY + window.height - point.y) / window.height) *
        frame.height,
  };
  const rotation = windowRotationDeg(window);
  if (rotation === 0) return base;
  return rotatePagePoint(
    base,
    { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 },
    rotation,
  );
}

export function pageToMap(
  point: MapPoint,
  frame: MapRect,
  window: MapWindow,
): MapPoint {
  const rotation = windowRotationDeg(window);
  const unrotated =
    rotation === 0
      ? point
      : rotatePagePoint(
          point,
          { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 },
          -rotation,
        );
  return {
    x: window.minX + ((unrotated.x - frame.x) / frame.width) * window.width,
    y:
      window.minY +
      window.height -
      ((unrotated.y - frame.y) / frame.height) * window.height,
  };
}

export function pointInWindow(point: MapPoint, window: MapWindow): boolean {
  if (windowRotationDeg(window) !== 0) {
    // Visibility under rotation = the point's page position lands inside
    // the frame. Reuse mapToPage against a unit frame so both paths share
    // one transform.
    const frame = { x: 0, y: 0, width: window.width, height: window.height };
    const page = mapToPage(point, frame, window);
    return (
      page.x >= 0 &&
      page.x <= frame.width &&
      page.y >= 0 &&
      page.y <= frame.height
    );
  }
  return (
    point.x >= window.minX &&
    point.x <= window.minX + window.width &&
    point.y >= window.minY &&
    point.y <= window.minY + window.height
  );
}

export function rectInside(
  rect: MapRect,
  bounds: PaperDimensions | MapRect,
): boolean {
  const x = "x" in bounds ? bounds.x : 0;
  const y = "y" in bounds ? bounds.y : 0;
  return (
    rect.x >= x &&
    rect.y >= y &&
    rect.x + rect.width <= x + bounds.width &&
    rect.y + rect.height <= y + bounds.height
  );
}
