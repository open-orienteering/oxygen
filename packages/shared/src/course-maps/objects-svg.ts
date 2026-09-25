import { mapToPage } from "./geometry.js";
import {
  isWhiteoutObject,
  type CourseMapObject,
  type MapFillMode,
  type MapPoint,
  type MapRect,
  type MapWindow,
  type PathVertex,
} from "./schema.js";
import {
  escapeSvgText,
  expandMapText,
  type MapTextValues,
} from "./text.js";

/**
 * How an image object's graphic is embedded. `href` covers URLs and data
 * URIs (web editor, PNG in PDF); `svg` inlines vector content as a nested
 * `<svg>` so librsvg renders it without loading external resources.
 */
export type ResolvedMapGraphic =
  | { kind: "href"; href: string }
  | {
      kind: "svg";
      svg: string;
      viewBox: string;
      /** Root xmlns:* attributes carried from the uploaded SVG. */
      rootAttrs?: string;
    };

export interface RenderMapObjectsOptions {
  objects: CourseMapObject[];
  frame: MapRect;
  window: MapWindow;
  textValues?: MapTextValues;
  resolveGraphic?: (
    graphicId: number,
  ) => ResolvedMapGraphic | null | undefined;
  /**
   * ISOM overprint enlargement (`mapScale / printScale`). Used for the
   * 709 hatch pattern dimensions so the stripes enlarge with the map.
   * Default 1.
   */
  overprintScale?: number;
  /** Purple for ISOM 709 hatch; defaults to `#a626ff`. */
  purple?: string;
}

/** ISOM 2017-2 symbol 709 (2022 revision) at 1:15 000. */
export const OUT_OF_BOUNDS_LINE_MM = 0.2;
export const OUT_OF_BOUNDS_GAP_MM = 1.2;
/** ISOM 709 bounding line width (Feb 2024 revision). */
export const OUT_OF_BOUNDS_BORDER_MM = 0.4;

const FONT_STACKS = {
  sans: "Liberation Sans, Arial, sans-serif",
  serif: "Liberation Serif, Times New Roman, serif",
  mono: "Liberation Mono, Courier New, monospace",
  condensed: "Liberation Sans Narrow, Arial Narrow, sans-serif",
} as const;

function pointFor(
  anchor: CourseMapObject["anchor"],
  point: MapPoint,
  frame: MapRect,
  window: MapWindow,
): MapPoint {
  return anchor === "map" ? mapToPage(point, frame, window) : point;
}

function sizeFor(
  anchor: CourseMapObject["anchor"],
  width: number,
  height: number,
  frame: MapRect,
  window: MapWindow,
): { width: number; height: number } {
  if (anchor === "page") return { width, height };
  return {
    width: (width / window.width) * frame.width,
    height: (height / window.height) * frame.height,
  };
}

function pathVertexFor(
  anchor: CourseMapObject["anchor"],
  vertex: PathVertex,
  frame: MapRect,
  window: MapWindow,
): PathVertex {
  const point = pointFor(anchor, vertex, frame, window);
  const handleFor = (handle: MapPoint | undefined): MapPoint | undefined => {
    if (!handle) return undefined;
    if (anchor === "page") return handle;
    const control = mapToPage(
      { x: vertex.x + handle.x, y: vertex.y + handle.y },
      frame,
      window,
    );
    return { x: control.x - point.x, y: control.y - point.y };
  };
  return {
    ...point,
    hIn: handleFor(vertex.hIn),
    hOut: handleFor(vertex.hOut),
  };
}

export function pathData(points: PathVertex[], closed = false): string {
  if (points.length === 0) return "";
  const commands = [`M ${points[0].x} ${points[0].y}`];
  const appendSegment = (start: PathVertex, end: PathVertex): void => {
    if (start.hOut || end.hIn) {
      const c1 = start.hOut
        ? { x: start.x + start.hOut.x, y: start.y + start.hOut.y }
        : start;
      const c2 = end.hIn
        ? { x: end.x + end.hIn.x, y: end.y + end.hIn.y }
        : end;
      commands.push(
        `C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${end.x} ${end.y}`,
      );
    } else {
      commands.push(`L ${end.x} ${end.y}`);
    }
  };
  for (let index = 1; index < points.length; index += 1) {
    appendSegment(points[index - 1], points[index]);
  }
  if (closed && points.length > 1) {
    appendSegment(points[points.length - 1], points[0]);
    commands.push("Z");
  }
  return commands.join(" ");
}

function resolveFill(
  fillMode: MapFillMode,
  fill: string | undefined,
  patternId: string | null,
): string {
  switch (fillMode) {
    case "solid":
      return fill ?? "none";
    case "whiteout":
    case "whiteoutInverted":
      return "#ffffff";
    case "outOfBounds":
      return patternId ? `url(#${patternId})` : "none";
    case "none":
    default:
      return "none";
  }
}

function strokeAttrs(
  stroke: string | undefined,
  strokeWidthMm: number | undefined,
): string {
  if (!stroke || strokeWidthMm === undefined) {
    return `stroke="none"`;
  }
  return `stroke="${stroke}" stroke-width="${strokeWidthMm}"`;
}

/**
 * Resolve stroke for a rect/path. Out-of-bounds borders always use the
 * course purple (ISOM 709), ignoring any stored stroke colour.
 */
export function resolveObjectStroke(
  fillMode: MapFillMode | undefined,
  stroke: string | undefined,
  strokeWidthMm: number | undefined,
  purple: string,
): { stroke: string | undefined; strokeWidthMm: number | undefined } {
  if (!stroke || strokeWidthMm === undefined) {
    return { stroke: undefined, strokeWidthMm: undefined };
  }
  if (fillMode === "outOfBounds") {
    return { stroke: purple, strokeWidthMm };
  }
  return { stroke, strokeWidthMm };
}

function frameRingPath(frame: MapRect): string {
  const { x, y, width, height } = frame;
  return `M ${x} ${y} L ${x + width} ${y} L ${x + width} ${y + height} L ${x} ${y + height} Z`;
}

function rectPathData(x: number, y: number, width: number, height: number): string {
  return `M ${x} ${y} L ${x + width} ${y} L ${x + width} ${y + height} L ${x} ${y + height} Z`;
}

function isClosedFill(fillMode: MapFillMode): boolean {
  return (
    fillMode === "whiteout" ||
    fillMode === "whiteoutInverted" ||
    fillMode === "outOfBounds"
  );
}

/**
 * ISOM 709 purple cross-hatch pattern. Dimensions are at the base map
 * scale and multiplied by `overprintScale` so they enlarge with the map.
 */
export function outOfBoundsPatternDef(
  id: string,
  purple: string,
  overprintScale: number,
): string {
  const scale =
    Number.isFinite(overprintScale) && overprintScale > 0 ? overprintScale : 1;
  const line = OUT_OF_BOUNDS_LINE_MM * scale;
  const gap = OUT_OF_BOUNDS_GAP_MM * scale;
  // Centre-to-centre spacing = line + gap; rotate 45° for the classic
  // diamond cross-hatch used by ISOM 709.
  const size = line + gap;
  return `<pattern id="${escapeSvgText(id)}" patternUnits="userSpaceOnUse" width="${size}" height="${size}" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="${size}" y2="0" stroke="${purple}" stroke-width="${line}"/>
      <line x1="0" y1="0" x2="0" y2="${size}" stroke="${purple}" stroke-width="${line}"/>
    </pattern>`;
}

function renderObject(
  object: CourseMapObject,
  options: RenderMapObjectsOptions,
  defs: string[],
): string {
  const common = `data-object-id="${escapeSvgText(object.id)}"`;
  const purple = options.purple ?? "#a626ff";
  const overprintScale = options.overprintScale ?? 1;

  switch (object.kind) {
    case "text": {
      const p = pointFor(
        object.anchor,
        { x: object.x, y: object.y },
        options.frame,
        options.window,
      );
      const align = object.align ?? "left";
      const anchor =
        align === "center"
          ? "middle"
          : align === "right"
            ? "end"
            : "start";
      const text = escapeSvgText(
        expandMapText(object.text, options.textValues ?? {}),
      );
      const fontFamily = FONT_STACKS[object.fontFamily ?? "sans"];
      return `<text ${common} x="${p.x}" y="${p.y}" font-family="${fontFamily}" font-size="${object.fontSizeMm}" text-anchor="${anchor}" fill="${object.color}">${text}</text>`;
    }
    case "line": {
      const p1 = pointFor(
        object.anchor,
        { x: object.x1, y: object.y1 },
        options.frame,
        options.window,
      );
      const p2 = pointFor(
        object.anchor,
        { x: object.x2, y: object.y2 },
        options.frame,
        options.window,
      );
      return `<line ${common} x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="${object.stroke}" stroke-width="${object.strokeWidthMm}" fill="none"/>`;
    }
    case "path": {
      const points = object.points.map((point) =>
        pathVertexFor(object.anchor, point, options.frame, options.window),
      );
      const fillMode = object.fillMode ?? "none";
      const patternId =
        fillMode === "outOfBounds" ? `oob-${object.id}` : null;
      if (patternId) {
        defs.push(outOfBoundsPatternDef(patternId, purple, overprintScale));
      }
      const fill = resolveFill(fillMode, object.fill, patternId);
      const closed = object.closed || isClosedFill(fillMode);
      const shapePath = pathData(points, closed);
      const resolved = resolveObjectStroke(
        fillMode,
        object.stroke,
        object.strokeWidthMm,
        purple,
      );
      if (fillMode === "whiteoutInverted") {
        const ring = `${frameRingPath(options.frame)} ${shapePath}`;
        const border =
          resolved.stroke !== undefined
            ? `<path d="${shapePath}" fill="none" ${strokeAttrs(resolved.stroke, resolved.strokeWidthMm)}/>`
            : "";
        return `<g ${common}><path d="${ring}" fill="${fill}" fill-rule="evenodd" stroke="none"/>${border}</g>`;
      }
      return `<path ${common} d="${shapePath}" ${strokeAttrs(resolved.stroke, resolved.strokeWidthMm)} fill="${fill}"/>`;
    }
    case "rectangle": {
      const p =
        object.anchor === "map"
          ? mapToPage(
              { x: object.x, y: object.y + object.height },
              options.frame,
              options.window,
            )
          : { x: object.x, y: object.y };
      const size = sizeFor(
        object.anchor,
        object.width,
        object.height,
        options.frame,
        options.window,
      );
      const fillMode = object.fillMode ?? "none";
      const patternId =
        fillMode === "outOfBounds" ? `oob-${object.id}` : null;
      if (patternId) {
        defs.push(outOfBoundsPatternDef(patternId, purple, overprintScale));
      }
      const fill = resolveFill(fillMode, object.fill, patternId);
      const resolved = resolveObjectStroke(
        fillMode,
        object.stroke,
        object.strokeWidthMm,
        purple,
      );
      if (fillMode === "whiteoutInverted") {
        const shapePath = rectPathData(p.x, p.y, size.width, size.height);
        const ring = `${frameRingPath(options.frame)} ${shapePath}`;
        const border =
          resolved.stroke !== undefined
            ? `<path d="${shapePath}" fill="none" ${strokeAttrs(resolved.stroke, resolved.strokeWidthMm)}/>`
            : "";
        return `<g ${common}><path d="${ring}" fill="${fill}" fill-rule="evenodd" stroke="none"/>${border}</g>`;
      }
      return `<rect ${common} x="${p.x}" y="${p.y}" width="${size.width}" height="${size.height}" fill="${fill}" ${strokeAttrs(resolved.stroke, resolved.strokeWidthMm)}/>`;
    }
    case "image": {
      const p =
        object.anchor === "map"
          ? mapToPage(
              { x: object.x, y: object.y + object.height },
              options.frame,
              options.window,
            )
          : { x: object.x, y: object.y };
      const size = sizeFor(
        object.anchor,
        object.width,
        object.height,
        options.frame,
        options.window,
      );
      const graphic = options.resolveGraphic?.(object.graphicId);
      if (!graphic) return "";
      const crop = object.crop ?? { x: 0, y: 0, width: 1, height: 1 };
      // Unit-box content + crop viewBox so we never need pixel dimensions.
      const cropView = `${crop.x} ${crop.y} ${crop.width} ${crop.height}`;
      const content =
        graphic.kind === "svg"
          ? `<svg ${graphic.rootAttrs ?? ""} x="0" y="0" width="1" height="1" viewBox="${escapeSvgText(graphic.viewBox)}" preserveAspectRatio="none">${graphic.svg}</svg>`
          : `<image x="0" y="0" width="1" height="1" href="${escapeSvgText(graphic.href)}" preserveAspectRatio="none"/>`;
      return `<svg ${common} x="${p.x}" y="${p.y}" width="${size.width}" height="${size.height}" viewBox="${cropView}" preserveAspectRatio="none">${content}</svg>`;
    }
  }
}

export function renderMapObjectsSvg(
  options: RenderMapObjectsOptions,
): string {
  // White-outs must be below lines, rectangles and text regardless of the
  // order in which the objects were authored.
  const ordered = [...options.objects].sort((a, b) => {
    const aWhite = isWhiteoutObject(a) ? 0 : 1;
    const bWhite = isWhiteoutObject(b) ? 0 : 1;
    return aWhite - bWhite;
  });
  const defs: string[] = [];
  const body = ordered
    .map((object) => renderObject(object, options, defs))
    .join("");
  const defsBlock =
    defs.length > 0 ? `<defs>${defs.join("")}</defs>` : "";
  return `<g data-map-layer="layout-objects">${defsBlock}${body}</g>`;
}
