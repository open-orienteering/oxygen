import {
  IOF_SYMBOLS,
  getPaperDimensions,
  isWhiteoutObject,
  renderCourseOverlaySvg,
  renderDescriptionBlockSvg,
  renderMapObjectsSvg,
  windowBoundingBox,
  windowRotationDeg,
  type CourseMapDocument,
  type CourseOverlayControl,
  type CourseOverlayLeg,
  type DescriptionRow,
  type MapRect,
  type MapTextValues,
  type MapWindow,
  type ResolvedMapGraphic,
} from "@oxygen/shared";
import {
  windowViewBox,
  type ViewBox,
} from "../map-window.js";

export interface BaseMapSvg {
  svg: string;
  rootViewBox: ViewBox;
  /** OCAD native units (1/100 mm), y-up. */
  ocadBounds: number[];
}

export interface ComposeMapPageOptions {
  document: CourseMapDocument;
  window: MapWindow;
  /** Full opaque base map. */
  baseMap: BaseMapSvg;
  /**
   * Transparent ink layer (black/brown/blue 100% lines and points) drawn
   * above lower purple. Null when the colour stack found nothing above.
   */
  inkMap?: BaseMapSvg | null;
  controls: CourseOverlayControl[];
  legs: CourseOverlayLeg[];
  descriptionRows: DescriptionRow[];
  title: string;
  textValues: MapTextValues;
  allControls?: boolean;
  /** ISOM overprint enlargement (mapScale / printScale); default 1. */
  overprintScale?: number;
  resolveGraphic?: (
    graphicId: number,
  ) => ResolvedMapGraphic | null | undefined;
}

export function svgInner(svg: string): string {
  const start = svg.indexOf(">");
  const end = svg.lastIndexOf("</svg>");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("Base map SVG has no root element");
  }
  return svg.slice(start + 1, end);
}

function svgRootFill(svg: string): string {
  const end = svg.indexOf(">");
  if (end < 0) return "transparent";
  const root = svg.slice(0, end + 1);
  return /\sfill=(["'])(.*?)\1/i.exec(root)?.[2] ?? "transparent";
}

/**
 * SVG fragment placing the base map crop for `window` into `frame` (page
 * mm). A rotated window is cropped from the bounding box of the rotated
 * rect and wrapped in a rotate about the frame centre, so display north
 * points up while map-vs-course alignment is untouched (the overlay uses
 * the same rotation via `mapToPage`).
 */
export function renderBaseMapWindow(
  baseMap: BaseMapSvg,
  window: MapWindow,
  frame: MapRect,
  options: { dataLayer?: string; forceTransparentFill?: boolean } = {},
): string {
  const rotation = windowRotationDeg(window);
  const bbox = windowBoundingBox(window);
  const viewBox = windowViewBox(baseMap.rootViewBox, baseMap.ocadBounds, {
    minX: bbox.minX * 100,
    minY: bbox.minY * 100,
    maxX: (bbox.minX + bbox.width) * 100,
    maxY: (bbox.minY + bbox.height) * 100,
  });
  if (!viewBox) {
    throw new Error("Base map SVG viewBox does not match its OCAD bounds");
  }
  const scale = frame.width / window.width;
  const crop = {
    x: frame.x + frame.width / 2 - (bbox.width * scale) / 2,
    y: frame.y + frame.height / 2 - (bbox.height * scale) / 2,
    width: bbox.width * scale,
    height: bbox.height * scale,
  };
  const fill = options.forceTransparentFill
    ? "transparent"
    : svgRootFill(baseMap.svg);
  const layerAttr = options.dataLayer
    ? ` data-map-layer="${options.dataLayer}"`
    : "";
  const nested = `<svg${layerAttr} x="${crop.x}" y="${crop.y}" width="${crop.width}" height="${crop.height}" viewBox="${viewBox}" fill="${fill}" preserveAspectRatio="none">
      ${svgInner(baseMap.svg)}
    </svg>`;
  if (rotation === 0) return nested;
  const cx = frame.x + frame.width / 2;
  const cy = frame.y + frame.height / 2;
  return `<g transform="rotate(${rotation}, ${cx}, ${cy})">${nested}</g>`;
}

export function composeMapPageSvg(options: ComposeMapPageOptions): string {
  const { document, window } = options;
  const paper = getPaperDimensions(
    document.paper,
    document.orientation,
    document.paper === "custom"
      ? {
          width: document.paperWidthMm!,
          height: document.paperHeightMm!,
        }
      : undefined,
  );
  const mapWhiteouts = document.objects.filter(
    (object) => object.anchor === "map" && isWhiteoutObject(object),
  );
  const pageWhiteouts = document.objects.filter(
    (object) => object.anchor === "page" && isWhiteoutObject(object),
  );
  const mapForeground = document.objects.filter(
    (object) => object.anchor === "map" && !isWhiteoutObject(object),
  );
  const pageForeground = document.objects.filter(
    (object) => object.anchor === "page" && !isWhiteoutObject(object),
  );
  const frame = document.mapFrame;
  const overprintScale = options.overprintScale;
  const purple = document.appearance.purple;
  const objectOpts = {
    frame,
    window,
    textValues: options.textValues,
    resolveGraphic: options.resolveGraphic,
    overprintScale,
    purple,
  };
  const course = renderCourseOverlaySvg({
    frame,
    window,
    appearance: document.appearance,
    controls: options.controls,
    legs: options.legs,
    allControls: options.allControls,
    overprintScale,
  });
  const descriptions = document.description.visible
    ? renderDescriptionBlockSvg({
        x: document.description.x,
        y: document.description.y,
        cellSizeMm: document.description.cellSizeMm,
        title: options.title,
        rows: options.descriptionRows,
        symbolResolver: (key) => IOF_SYMBOLS[key],
      })
    : "";
  const ink = options.inkMap
    ? renderBaseMapWindow(options.inkMap, window, frame, {
        dataLayer: "map-ink",
        forceTransparentFill: true,
      })
    : "";

  // IOF digital stack: full map → lower purple → ink → whiteouts →
  // upper purple → descriptions → foreground layout objects.
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${paper.width}mm" height="${paper.height}mm" viewBox="0 0 ${paper.width} ${paper.height}">
  <rect width="${paper.width}" height="${paper.height}" fill="#ffffff"/>
  <defs>
    <clipPath id="map-frame-clip"><rect x="${frame.x}" y="${frame.y}" width="${frame.width}" height="${frame.height}"/></clipPath>
  </defs>
  <g clip-path="url(#map-frame-clip)">
    ${renderBaseMapWindow(options.baseMap, window, frame, { dataLayer: "map-full" })}
    ${course.lower}
    ${ink}
  </g>
  <g clip-path="url(#map-frame-clip)">
    ${renderMapObjectsSvg({ ...objectOpts, objects: mapWhiteouts })}
  </g>
  ${renderMapObjectsSvg({ ...objectOpts, objects: pageWhiteouts })}
  <g clip-path="url(#map-frame-clip)">
    ${course.upper}
  </g>
  ${descriptions}
  <g clip-path="url(#map-frame-clip)">
    ${renderMapObjectsSvg({ ...objectOpts, objects: mapForeground })}
  </g>
  ${renderMapObjectsSvg({ ...objectOpts, objects: pageForeground })}
</svg>`;
}
