/**
 * The page model (docs/course-print.md §4; research 05 §5.1): what a page
 * is made of before it becomes PDF operators — the sheet, the map layer
 * under `T_map`, the page layer, and (empty in slice C) the marks layer.
 *
 * Page space here is page µm, y-up, origin bottom-left (PDF's own
 * orientation); the templates' page mm are y-down from the top-left and
 * are flipped once, on the way in (`flipPageObject`).
 */

import type { CourseMapObject, MapPoint, MapRect, MapWindow, PathVertex } from "../course-maps/schema.js";
import { windowRotationDeg } from "../course-maps/geometry.js";
import type { MapTextValues } from "../course-maps/text.js";
import type { CourseAppearance, CourseDocumentContext, CourseSite, CourseStructure, CourseViewOptions, CutFeature } from "../course/types.js";
import type { DocumentColour } from "../map-document/header.js";
import type { PaperFrame } from "../geo/projection.js";
import type { Pass, PassStream, RenderPath } from "../render/pass-stream.js";
import type { RenderSymbol } from "../render/symbol.js";
import type { RenderObject } from "../render/symbolise.js";
import type { DescriptionBlockInput } from "./description.js";

/** Page mm → page µm. */
const um = (mm: number) => Math.round(mm * 1000);

/** Everything one page needs; `resolveSheet` (api) builds it from template, sheet and course rows. */
export interface PageInput {
  /** Paper size, mm. */
  paper: { widthMm: number; heightMm: number };
  /** The map frame, page mm, y-down from the top-left (the template's convention). */
  frame: MapRect;
  /** The map window, paper mm y-up; `rotationDeg` clockwise on the page (`mapWindowForFrame`). */
  window: MapWindow;
  /** The pinned document's objects near the window and its symbols (`documentRenderInput`). */
  map: {
    objects: RenderObject[];
    symbols: RenderSymbol[];
    context: CourseDocumentContext;
    cutFeatures?: readonly CutFeature[];
  };
  /** The course layer's input without the document (docs/course-layer.md §2). */
  course: {
    structure: CourseStructure | readonly CourseStructure[] | null;
    sites: readonly CourseSite[];
    appearance: CourseAppearance;
    viewOptions: Pick<CourseViewOptions, "allControls" | "labelMode" | "overprintScale">;
  };
  /** Layout objects of both anchors (template + sheet). */
  objects: readonly CourseMapObject[];
  textValues: MapTextValues;
  /** The description block, or null when the template hides it. */
  description: DescriptionBlockInput | null;
  /** Page label and outline title (course or map name). */
  label: string;
  /** Georeferencing of the document for `/Measure /GEO`; null / absent = none. */
  geo?: PaperFrame | null;
}

/** Placement of the map layer on the page: paper µm relative to `originUm` → page µm. */
export interface MapLayerTransform {
  /** `frame.width / window.width` = map scale ÷ print scale. */
  scaleRatio: number;
  /** Counter-clockwise on the y-up page (= −window rotation). */
  rotationDeg: number;
  /** Window centre, paper µm. */
  originUm: [number, number];
  /** Frame centre, page µm (y-up). */
  atUm: [number, number];
}

/** A raster graphic on the page (PNG bytes come from the caller, by `graphicId`). */
export interface PageImage {
  layer: "map" | "page";
  graphicId: number;
  /** Lower-left corner and size in the layer's space (paper µm for `map`, page µm for `page`). */
  rectUm: { x: number; y: number; width: number; height: number };
  /** Visible part of the source as fractions, top-left origin (schema `crop`); absent = all. */
  crop?: { x: number; y: number; width: number; height: number };
}

export interface PageWarning {
  code: string;
  message: string;
}

/** `/Measure /GEO` of one frame (05 §5.9): the frame and its four corners in WGS 84. */
export interface GeoViewport {
  /** Frame, page µm y-up: `[llx, lly, urx, ury]`. */
  bboxUm: [number, number, number, number];
  /** Lat / long of the frame corners in `lpts` order. */
  gpts: [number, number][];
  /** The corners as unit-square points of the bbox (lower-left, upper-left, upper-right, lower-right). */
  lpts: [number, number][];
}

/** One page, composed: layers in draw order and the colour table both layers index. */
export interface ComposedPage {
  paper: { widthMm: number; heightMm: number };
  /** The map frame, page µm y-up. */
  frameUm: { x: number; y: number; width: number; height: number };
  /** Map stack ⊕ upper white ⊕ layout-object colours ⊕ page colours (both layers index it). */
  colours: DocumentColour[];
  mapLayer: { stream: PassStream; transform: MapLayerTransform };
  pageLayer: { stream: PassStream };
  /** Offset-printing marks (bleed, crop marks): empty until print profiles (course-print.md §2). */
  marksLayer: null;
  images: PageImage[];
  geo: GeoViewport | null;
  label: string;
  warnings: PageWarning[];
}

/** The frame in page µm, y-up. */
export function frameRectUm(frame: MapRect, paperHeightMm: number): ComposedPage["frameUm"] {
  return { x: um(frame.x), y: um(paperHeightMm - frame.y - frame.height), width: um(frame.width), height: um(frame.height) };
}

/**
 * `T_map` (05 §5.1; today's `mapToPage`): window centre → frame centre,
 * scale `frame.width / window.width`, rotation −window rotation (the
 * window's clockwise page rotation is counter-clockwise negative on the
 * y-up page), y already up on both sides.
 */
export function mapLayerTransform(frame: MapRect, window: MapWindow, paperHeightMm: number): MapLayerTransform {
  const rotation = windowRotationDeg(window);
  return {
    scaleRatio: frame.width / window.width,
    rotationDeg: rotation === 0 ? 0 : -rotation,
    originUm: [um(window.minX + window.width / 2), um(window.minY + window.height / 2)],
    atUm: [um(frame.x + frame.width / 2), um(paperHeightMm - frame.y - frame.height / 2)],
  };
}

/** A paper-µm point through `T_map` into page µm (y-up). */
export function mapPointToPage(t: MapLayerTransform, xUm: number, yUm: number): [number, number] {
  const a = (t.rotationDeg * Math.PI) / 180;
  const c = Math.cos(a) * t.scaleRatio, s = Math.sin(a) * t.scaleRatio;
  const dx = xUm - t.originUm[0], dy = yUm - t.originUm[1];
  return [t.atUm[0] + c * dx - s * dy, t.atUm[1] + s * dx + c * dy];
}

/** A page-µm point back to paper µm (inverse of `mapPointToPage`). */
export function pagePointToMap(t: MapLayerTransform, xUm: number, yUm: number): [number, number] {
  const a = (-t.rotationDeg * Math.PI) / 180;
  const c = Math.cos(a) / t.scaleRatio, s = Math.sin(a) / t.scaleRatio;
  const dx = xUm - t.atUm[0], dy = yUm - t.atUm[1];
  return [t.originUm[0] + c * dx - s * dy, t.originUm[1] + s * dx + c * dy];
}

/** The frame's corners in paper mm (y-up): the white-out-outside ring of the map layer. */
export function frameInMap(t: MapLayerTransform, frameUm: ComposedPage["frameUm"]): MapPoint[] {
  const { x, y, width, height } = frameUm;
  return [[x, y], [x + width, y], [x + width, y + height], [x, y + height]].map(([px, py]) => {
    const [mx, my] = pagePointToMap(t, px, py);
    return { x: mx / 1000, y: my / 1000 };
  });
}

/**
 * A page-anchored object in y-up page mm, re-anchored as `map` so the
 * course layer's object builder (C0, `layoutObjects`) draws it in page
 * space unchanged: points `y → H − y`, Bézier handles negated in y,
 * rectangles by their lower-left corner.
 */
export function flipPageObject(o: CourseMapObject, paperHeightMm: number): CourseMapObject {
  const H = paperHeightMm;
  const v = (p: PathVertex): PathVertex => ({
    x: p.x,
    y: H - p.y,
    ...(p.hIn ? { hIn: { x: p.hIn.x, y: -p.hIn.y } } : {}),
    ...(p.hOut ? { hOut: { x: p.hOut.x, y: -p.hOut.y } } : {}),
  });
  switch (o.kind) {
    case "text":
      return { ...o, anchor: "map", y: H - o.y };
    case "line":
      return { ...o, anchor: "map", y1: H - o.y1, y2: H - o.y2 };
    case "path":
      return { ...o, anchor: "map", points: o.points.map(v) };
    case "rectangle":
    case "image":
      return { ...o, anchor: "map", y: H - o.y - o.height };
  }
}

/** A path through a similarity transform (rounded to integer µm); flags and slices stay valid (Béziers are affine-invariant). */
function transformPath(p: RenderPath, f: (x: number, y: number) => [number, number]): RenderPath {
  const coords = new Int32Array(p.coords.length);
  for (let i = 0; i < p.coords.length; i += 2) {
    const [x, y] = f(p.coords[i], p.coords[i + 1]);
    coords[i] = Math.round(x);
    coords[i + 1] = Math.round(y);
  }
  return { coords, flags: p.flags, closed: p.closed };
}

/**
 * A pass stream through `T_map` into page µm: what the PDF does with one
 * `cm`, done to the geometry — for the reference raster of a page (the
 * page goldens), which has no transform of its own. Widths, sizes,
 * spacings × scale; glyph instances and text angles turned; a hatch's
 * offset moved with the translation along its new normal so the lines
 * land where the transformed lines would. Glyph meshes are glyph-local and
 * stay as they are.
 */
export function transformPassStream(stream: PassStream, t: MapLayerTransform): PassStream {
  const k = t.scaleRatio;
  const rad = (t.rotationDeg * Math.PI) / 180;
  const cr = Math.cos(rad), sr = Math.sin(rad);
  const f = (x: number, y: number) => mapPointToPage(t, x, y);
  // Translation part of the transform (image of the paper origin).
  const [tx, ty] = f(0, 0);
  const pass = (p: Pass): Pass => {
    switch (p.kind) {
      case "fill":
        return { ...p, path: transformPath(p.path, f) };
      case "stroke":
        return {
          ...p,
          path: transformPath(p.path, f),
          widthUm: p.widthUm * k,
          ...(p.taper ? { taper: { ...(p.taper.startUm !== undefined ? { startUm: p.taper.startUm * k } : {}), ...(p.taper.endUm !== undefined ? { endUm: p.taper.endUm * k } : {}) } } : {}),
        };
      case "glyph": {
        const inst = new Float32Array(p.instances.length);
        for (let i = 0; i < inst.length; i += 5) {
          const [x, y] = f(p.instances[i], p.instances[i + 1]);
          const c = p.instances[i + 2], s = p.instances[i + 3];
          inst[i] = x;
          inst[i + 1] = y;
          inst[i + 2] = c * cr - s * sr;
          inst[i + 3] = s * cr + c * sr;
          inst[i + 4] = p.instances[i + 4] * k;
        }
        return { ...p, instances: inst, ...(p.clip ? { clip: transformPath(p.clip, f) } : {}) };
      }
      case "hatch": {
        const angleDeg = p.angleDeg + t.rotationDeg;
        const a = (angleDeg * Math.PI) / 180;
        // New normal (−sin, cos): offset' = k·offset + n'·translation.
        const offsetUm = p.offsetUm * k + (-Math.sin(a) * tx + Math.cos(a) * ty);
        return { ...p, path: transformPath(p.path, f), widthUm: p.widthUm * k, spacingUm: p.spacingUm * k, offsetUm, angleDeg };
      }
      case "text": {
        const positions = new Float32Array(p.positions.length);
        for (let i = 0; i < positions.length; i += 2) {
          const [x, y] = f(p.positions[i], p.positions[i + 1]);
          positions[i] = x;
          positions[i + 1] = y;
        }
        let angles = p.angles;
        if (t.rotationDeg !== 0) {
          angles = new Float32Array(p.glyphs.length);
          for (let i = 0; i < angles.length; i++) angles[i] = (p.angles?.[i] ?? 0) + t.rotationDeg;
        }
        return {
          ...p,
          positions,
          sizeUm: p.sizeUm * k,
          ...(angles ? { angles } : {}),
          ...(p.haloWidthUm !== undefined ? { haloWidthUm: p.haloWidthUm * k } : {}),
        };
      }
    }
  };
  return { ...stream, passes: stream.passes.map(pass) };
}
