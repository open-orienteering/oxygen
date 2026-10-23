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
import type { RenderObject } from "../render/symbolise.js";
import type { SymbolLibraryId } from "../symbol-library/index.js";

export type { AngularGap, FractionGap };

/** A control site: one `controls` row (08 §4.2). */
export interface CourseSite {
  id: string;
  /** Display code (first punch code, else name / seq). */
  code: string;
  kind: "control" | "start" | "finish";
  x: number;
  y: number;
}

/** File-authored geometry of the leg *into* an item (imported `ocd` courses; retired by D's `LegProps.path`). */
export interface CourseLegInput {
  /** Leg polyline from the previous site to this one, bends included. Default: the straight line. */
  path?: MapPoint[];
  /** 705 pieces as the file drew them: drawn as given, never clipped or gapped. */
  pieces?: MapPoint[][];
  /** Authored gaps along `path`; replace the automatic ones. */
  gaps?: FractionGap[];
}

export interface CourseItem {
  siteId: string;
  /** How the item is drawn; default the site's kind (`firstAsStart` / `lastAsFinish` set it). */
  role?: CourseSite["kind"];
  leg?: CourseLegInput;
  /** File-authored circle gaps; replace the automatic cuts for this circle. */
  circleGaps?: AngularGap[];
}

/** Course-level lines and areas of imported geometry that belong to no leg. */
export interface CourseExtra {
  kind: "marked_route" | "restricted_line" | "forbidden_route" | "oob_area";
  /** Polyline, or the ring of an `oob_area`. */
  points: MapPoint[];
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
  extras?: CourseExtra[];
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
  /** Layout objects; only `anchor: "map"` ones are drawn. */
  objects: readonly CourseMapObject[];
  appearance: CourseAppearance;
  viewOptions: CourseViewOptions;
  document: CourseDocumentContext;
  /** Features for automatic cuts (`cutFeaturesOfDocument`, or C5's legacy adapter). Absent = no automatic cuts. */
  cutFeatures?: readonly CutFeature[];
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
  /** Centre-to-centre polyline (or the authored path). */
  points: MapPoint[];
  /** Effective gaps (authored or automatic). */
  gaps: FractionGap[];
  /** What is drawn: after gaps and circle clipping, or the authored pieces. */
  pieces: MapPoint[][];
  preclipped: boolean;
}

export interface DerivedCourse {
  id: string;
  orderMode: CourseStructure["orderMode"];
  /** Positioned items in order: site id + role. */
  sequence: { siteId: string; role: CourseSite["kind"] }[];
  legs: DerivedLeg[];
  extras: CourseExtra[];
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
  code: "WINDOW_MISSING" | "FONT_SUBSTITUTED";
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
}

/** A template's stored appearance as multipliers of the library dimensions (`defaultMapAppearance` = 1). */
export function appearanceFromTemplate(a: Pick<MapAppearance, "circleRadiusMm" | "lineWidthMm" | "numberHeightMm">): CourseAppearance {
  const d = defaultMapAppearance;
  return { circle: a.circleRadiusMm / d.circleRadiusMm, line: a.lineWidthMm / d.lineWidthMm, number: a.numberHeightMm / d.numberHeightMm };
}
