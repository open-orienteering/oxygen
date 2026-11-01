/**
 * Input and output types of the course layer (docs/course-layer.md §2).
 *
 * Coordinates are paper mm at the base map's scale, y-up — the frame of
 * `controls.xpos/ypos`, of course GeoJSON and of map-anchored layout
 * objects. Circle gaps are compass degrees (0° = +y, clockwise; the gap
 * sweeps clockwise from `start` to `end`), leg gaps fractions 0..1 of the
 * leg — the conventions of the OCD importer and `overprint-cuts.ts`.
 */

import { type MapAppearance, type CourseMapObject, type MapPoint, defaultMapAppearance } from "../course-maps/schema.js";
import type { MapTextValues } from "../course-maps/text.js";
import type { AngularGap, FractionGap } from "../course-maps/overlay-geometry.js";
import type { DocumentColour } from "../map-document/header.js";
import type { RenderSymbol } from "../render/symbol.js";
import type { FilterRegion } from "../render/filter-region.js";
import type { RenderObject } from "../render/symbolise.js";
import type { SymbolLibraryId } from "../symbol-library/index.js";
import type { CourseLayerObject } from "./objects.js";

export type { AngularGap, FractionGap };

/** A control site: one `controls` row (08 §4.2). */
export interface CourseSite {
  id: string;
  /** Display code (first punch code, else name / seq). */
  code: string;
  kind: "control" | "start" | "finish";
  x: number;
  y: number;
  /** `controls.circle_gaps`: authored circle cuts, compass degrees. A non-empty list replaces the automatic cuts (course-layer.md §6.4). */
  circleGaps?: AngularGap[];
}

/** The stored `LegProps` the layer reads (08 §4.3): authored gaps of the leg *into* an item; they replace the automatic ones. */
export interface CourseLegProps {
  gaps?: FractionGap[];
}

export interface CourseItem {
  siteId: string;
  /** How the item is drawn; default the site's kind (`firstAsStart` / `lastAsFinish` set it). */
  role?: CourseSite["kind"];
  leg?: CourseLegProps;
  /** Hide this visit's number (08 §4.2); the site stays an obstacle-free label-less circle. */
  numberHidden?: boolean;
}

/** v1: today's linear sequence (08 §4.3 item shape; variations and insets are slice D). */
export interface CourseStructure {
  version: 1;
  /** Carried into object refs and the GeoJSON; any stable id (the course uuid). */
  id: string;
  orderMode: "ordered" | "free_order";
  /** Start … finish, in order. */
  items: CourseItem[];
  /** Manual number positions: centre = site + offset, paper mm (`course_controls` label offsets). */
  labelOffsets?: Record<string, { dx: number; dy: number }>;
}

/** Multipliers of the library dimensions (1 = the spec). */
export interface CourseAppearance {
  /** 701, 703, 706 geometry. */
  circle?: number;
  /** Every 7xx line width. */
  line?: number;
  /** 704 digit height. */
  number?: number;
  /** `spec` (default): 704 as the library draws it. `knockout`: upper purple with a 0.15 mm upper-white outline. */
  numberStyle?: "spec" | "knockout";
}

export interface CourseViewOptions {
  /** Draw every site, not only the course's. Labels are codes. */
  allControls?: boolean;
  /** Default `sequence` for one ordered course, else `code`. */
  labelMode?: "sequence" | "code";
  /**
   * Print enlargement `mapScale / printScale`. Only map-anchored layout
   * objects read it: their sizes are page mm, so they are divided by it
   * (the page transform enlarges the whole layer). Default 1.
   */
  overprintScale?: number;
  /** Outer ring of white-out-outside objects: the map frame as a paper-mm polygon. */
  window?: MapPoint[];
  /** Placeholder values for map-anchored text (`{course}` …). */
  textValues?: MapTextValues;
}

/** One compact point feature the overprint is cut around, paper mm. */
export interface CutFeature {
  x: number;
  y: number;
  /** Radius of the symbol the map draws there, paper mm (course-layer.md §3.4); default `DEFAULT_FEATURE_RADIUS_MM`. */
  r?: number;
}

/** What the layer needs from the map document. */
export interface CourseDocumentContext {
  /** The document's aligned colour stack (`header.colours`). */
  colours: readonly DocumentColour[];
  libraryId: SymbolLibraryId;
  /** Library reference scale / map scale × symbol scale (03 §6.6). */
  documentFactor: number;
}

export interface CourseLayerInput {
  /** One course, several highlighted courses, or none (all-controls view). */
  structure: CourseStructure | readonly CourseStructure[] | null;
  sites: readonly CourseSite[];
  /**
   * A sheet's layout objects (only `anchor: "map"` ones are drawn) and the
   * course objects in scope (§8): `filter_region` objects join `regions`.
   */
  objects: readonly (CourseMapObject | CourseLayerObject)[];
  appearance: CourseAppearance;
  viewOptions: CourseViewOptions;
  document: CourseDocumentContext;
  /** Features for automatic cuts (`cutFeaturesOfDocument`, or C5's legacy adapter). Absent = no automatic cuts. */
  cutFeatures?: readonly CutFeature[];
  /** Filter regions over the map (`map-rendering.md` §4.11; 08 §4.5 `filter_region`). */
  regions?: readonly CourseFilterRegion[];
}

/**
 * A filter region as the course layer takes it: paper mm, y-up. `symbols`
 * are document symbol indices, colours the document's own stack indices
 * (re-indexed onto the completed stack by the layer).
 */
export interface CourseFilterRegion {
  /** Outer ring first, then holes; each ring a polygon (closed implicitly). */
  rings: readonly (readonly MapPoint[])[];
  mode: FilterRegion["mode"];
  symbols: FilterRegion["symbols"];
  /** Complement of `symbols`: "show only these symbols inside". */
  invert?: boolean;
}

export type CourseRefKind = "site" | "leg" | "number" | "leader" | "extra" | "object";

/** Which input an output object came from (hit-testing and per-object hide in C4). */
export interface CourseRef {
  kind: CourseRefKind;
  /** Site id, layout object id, or `<courseId>:<index>` for legs and extras. */
  id: string;
}

export interface CourseRenderObject extends RenderObject {
  ref: CourseRef;
}

export interface DerivedSite {
  id: string;
  code: string;
  role: CourseSite["kind"];
  x: number;
  y: number;
  /** Effective circle gaps (authored or automatic), compass degrees; controls only. */
  cuts: AngularGap[];
  /** Number centre and leader, paper mm y-up. */
  label?: { text: string; x: number; y: number; leader?: { x1: number; y1: number; x2: number; y2: number } };
  /** 701 rotation, degrees counter-clockwise (apex towards the first control). */
  angleDeg?: number;
}

export interface DerivedLeg {
  from: string;
  to: string;
  /** Centre-to-centre polyline. */
  points: MapPoint[];
  /** Effective gaps (authored or automatic). */
  gaps: FractionGap[];
  /** What is drawn: after gaps and circle clipping. */
  pieces: MapPoint[][];
}

export interface DerivedCourse {
  id: string;
  orderMode: CourseStructure["orderMode"];
  /** Positioned items in order: site id + role. */
  sequence: { siteId: string; role: CourseSite["kind"] }[];
  legs: DerivedLeg[];
}

/** The geometry the course-setting rules produce, before symbols (§3). */
export interface CourseDerivation {
  sites: DerivedSite[];
  courses: DerivedCourse[];
}

export interface CourseLayerImage {
  object: Extract<CourseMapObject, { kind: "image" }>;
  /** Paper µm, y-up: lower-left corner and size. */
  rectUm: { x: number; y: number; width: number; height: number };
}

export interface CourseLayerWarning {
  code: "WINDOW_MISSING";
  ref: CourseRef;
  message: string;
}

export interface CourseLayer {
  /** The document stack, completed: upper white inserted when absent, rows for layout-object colours on top. */
  colours: DocumentColour[];
  /** Document colour index → index in `colours`; `null` when the document's indices are unchanged. */
  remap: number[] | null;
  symbols: RenderSymbol[];
  objects: CourseRenderObject[];
  /** Map-anchored images: not in the pass stream, drawn by the page backends. */
  images: CourseLayerImage[];
  derivation: CourseDerivation;
  warnings: CourseLayerWarning[];
  /** The input's filter regions in paper µm, colours on `colours`; they act on the document's objects only. */
  regions: FilterRegion[];
}

/** A template's stored appearance as multipliers of the library dimensions (`defaultMapAppearance` = 1). */
export function appearanceFromTemplate(a: Pick<MapAppearance, "circleRadiusMm" | "lineWidthMm" | "numberHeightMm">): CourseAppearance {
  const d = defaultMapAppearance;
  return { circle: a.circleRadiusMm / d.circleRadiusMm, line: a.lineWidthMm / d.lineWidthMm, number: a.numberHeightMm / d.numberHeightMm };
}
