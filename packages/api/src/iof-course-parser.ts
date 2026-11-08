/**
 * IOF 3.0 CourseData XML parser.
 *
 * Parses controls, courses, and class-course assignments from
 * IOF 3.0 CourseData XML (as exported by OCAD, Purple Pen, Condes, etc.)
 *
 * Also generates straight-line GeoJSON geometry from control positions
 * so the rendering layer always works identically regardless of import source.
 */

import { XMLParser } from "fast-xml-parser";
import type { ControlDescription } from "@oxygen/shared";
// ─── GeoJSON types (subset) ─────────────────────────────────────────────────

export interface GeoJSONPoint {
  type: "Point";
  coordinates: [number, number]; // [x_mm, y_mm]
}

export interface GeoJSONLineString {
  type: "LineString";
  coordinates: [number, number][]; // [[x_mm, y_mm], ...]
}

export interface GeoJSONMultiLineString {
  type: "MultiLineString";
  coordinates: [number, number][][];
}

export interface GeoJSONPolygon {
  type: "Polygon";
  coordinates: [number, number][][]; // [[[x_mm, y_mm], ...], ...]
}

export interface GeoJSONFeature {
  type: "Feature";
  geometry: GeoJSONPoint | GeoJSONLineString | GeoJSONMultiLineString | GeoJSONPolygon;
  properties: Record<string, any>;
}

export interface GeoJSONFeatureCollection {
  type: "FeatureCollection";
  features: GeoJSONFeature[];
}

/** A manual or automatic slit in a control circle. */
export interface SlitGap {
  start: number; // degrees CW from North
  end: number;   // degrees CW from North
}

export interface ParsedControl {
  id: string;           // "31", "STA1", "FIN1"
  /** `CrossingPoint`: an IOF crossing point, imported as a `crossing_point` site (F9). */
  type: "Start" | "Control" | "Finish" | "CrossingPoint";
  lat: number;          // WGS84 latitude
  lng: number;          // WGS84 longitude
  mapX: number;         // map position X in mm
  mapY: number;         // map position Y in mm
  cuts?: SlitGap[];     // Optional gap angles for OCAD circle masking
  /** IOF control description (OCD imports only — parsed from 702000 text). */
  description?: ControlDescription;
  /** Oxygen's IOF `Extensions` map-exchange marker (docs/iof-coursedata-export.md). */
  mapExchange?: true;
}

export interface ParsedCourseControl {
  controlId: string;
  type: "Start" | "Control" | "Finish";
  legLength: number;    // meters
  /** IOF `randomOrder="true"` — free-order block member. */
  randomOrder?: boolean;
  /**
   * The crossing point the leg into this row runs through (a folded IOF
   * `CrossingPoint` row: its control id; `section` for a passage).
   */
  crossing?: { controlId: string; section?: true };
  /** IOF `TapedRoute` / `FunnelTapedRoute` on the leg into this row. */
  style?: "marked_route";
  /**
   * The bends of the leg into this row (Purple Pen `<leg>`), paper mm in
   * the file's frame. `buildStraightLineGeometry` draws them into the leg
   * feature, which the import alignment moves; the importer reads them
   * from there (course-import-structure.ts `legBendsOfFeatures`).
   */
  bends?: Array<{ x: number; y: number }>;
}

export interface ParsedCourse {
  name: string;
  /** IOF `CourseFamily` (a variant's root, for the import preview). */
  family?: string;
  length: number;       // meters
  climb: number;
  controls: ParsedCourseControl[];
  /**
   * Visit-order mode. Set to `free_order` when every Control-type
   * CourseControl carries `randomOrder="true"` (Purple Pen / Condes
   * whole-course pattern). Partial runs stay `ordered`.
   */
  orderMode?: "ordered" | "free_order";
}

export interface ClassAssignment {
  className: string;
  courseName: string;
}

/**
 * The map file a course file was set on, when the format records it.
 *
 * Only Purple Pen does. It matters because paper-mm coordinates are
 * anchored to one specific map file's paper origin: importing them
 * against a different map of the same terrain puts every control off
 * by the two maps' georeference difference. See `course-import-align.ts`.
 */
export interface SourceMapInfo {
  /** Base file name as recorded in the course file, e.g. "Brotorp.ocd". */
  fileName: string;
  /** "OCAD", "PDF", "Bitmap", … as recorded by the course setter's tool. */
  kind: string;
  /** Map scale denominator the coordinates are expressed at. */
  scale: number;
}

export interface ParsedCourseData {
  controls: ParsedControl[];
  courses: ParsedCourse[];
  classAssignments: ClassAssignment[];
  mapScale: number;
  /** Present only for formats that name their map file (.ppen). */
  sourceMap?: SourceMapInfo;
  /** Per-course GeoJSON geometry. Key = course name (e.g., "A", "B"). */
  courseGeometry: Record<string, GeoJSONFeatureCollection>;
  /** General map features (restricted areas, leg cuts). */
  mapFeatures: GeoJSONFeature[];
  /** Source identifier for the geometry priority system. */
  geometrySource: "ocd" | "xml";
}

// ─── Extended ParsedCourseData ───────────────────────────────────────────────

/** Alias for backward compatibility or specific XML usage if needed. */
export type ParsedIOFCourseData = ParsedCourseData;

// ─── Parser ─────────────────────────────────────────────────

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (_name, jpath) => {
    const arrayPaths = [
      "CourseData.RaceCourseData.Control",
      "CourseData.RaceCourseData.Course",
      "CourseData.RaceCourseData.Course.CourseControl",
      "CourseData.RaceCourseData.ClassCourseAssignment",
    ];
    return arrayPaths.includes(String(jpath));
  },
});

function safeFloat(val: unknown): number {
  if (val === undefined || val === null || val === "") return 0;
  if (typeof val === "object" && val !== null && "#text" in (val as Record<string, unknown>)) {
    return safeFloat((val as Record<string, unknown>)["#text"]);
  }
  const n = parseFloat(String(val));
  return isNaN(n) ? 0 : n;
}

function safeStr(val: unknown): string {
  if (val === undefined || val === null) return "";
  if (typeof val === "object" && val !== null && "#text" in (val as Record<string, unknown>)) {
    return String((val as Record<string, unknown>)["#text"]);
  }
  return String(val);
}

/**
 * Whether a `Control`'s `Extensions` carry the map-exchange marker
 * (`<ox:MapExchange>true</ox:MapExchange>`, under whatever prefix the
 * writer bound Oxygen's namespace to).
 */
function hasMapExchangeMarker(extensions: unknown): boolean {
  if (!extensions || typeof extensions !== "object") return false;
  return Object.entries(extensions as Record<string, unknown>).some(
    ([key, value]) => (key === "MapExchange" || key.endsWith(":MapExchange")) && safeStr(value).trim().toLowerCase() === "true",
  );
}

export function parseIOFCourseData(xmlContent: string): ParsedCourseData {
  const parsed = parser.parse(xmlContent);
  const courseData = parsed.CourseData;
  if (!courseData) {
    throw new Error("Invalid IOF CourseData XML: missing <CourseData> root element");
  }

  const raceCourseData = courseData.RaceCourseData;
  if (!raceCourseData) {
    throw new Error("Invalid IOF CourseData XML: missing <RaceCourseData>");
  }

  // Parse map scale
  const mapScale = safeFloat(raceCourseData.Map?.Scale) || 15000;

  // Parse controls
  const rawControls = raceCourseData.Control ?? [];
  const controls: ParsedControl[] = [];
  for (const rc of Array.isArray(rawControls) ? rawControls : [rawControls]) {
    const rawType = safeStr(rc["@_type"]) || "Control";
    // An end-of-marked-route point has no Oxygen site kind: its rows fold
    // into the leg (below), the point itself is not imported.
    if (rawType === "EndOfMarkedRoute") continue;
    const type = rawType as ParsedControl["type"];
    const id = safeStr(rc.Id);
    if (!id) continue;

    const pos = rc.Position ?? {};
    const mapPos = rc.MapPosition ?? {};

    controls.push({
      id,
      type,
      lat: safeFloat(pos["@_lat"]),
      lng: safeFloat(pos["@_lng"]),
      mapX: safeFloat(mapPos["@_x"]),
      mapY: safeFloat(mapPos["@_y"]),
      ...(hasMapExchangeMarker(rc.Extensions) ? { mapExchange: true as const } : {}),
    });
  }

  // Parse courses
  const rawCourses = raceCourseData.Course ?? [];
  const courses: ParsedCourse[] = [];
  for (const rc of Array.isArray(rawCourses) ? rawCourses : [rawCourses]) {
    const name = safeStr(rc.Name);
    if (!name) continue;

    const length = safeFloat(rc.Length);
    const climb = safeFloat(rc.Climb);

    const rawCCs = rc.CourseControl ?? [];
    const courseControls: ParsedCourseControl[] = [];
    // What the rows folded since the last kept one carry into the next leg:
    // a `CrossingPoint` / `EndOfMarkedRoute` row is a point on a leg, not
    // a control of the course (docs/iof-coursedata-export.md).
    let pending: Pick<ParsedCourseControl, "crossing" | "style"> & { legLength: number } = { legLength: 0 };
    for (const cc of Array.isArray(rawCCs) ? rawCCs : [rawCCs]) {
      const rowType = safeStr(cc["@_type"]) || "Control";
      const instruction = safeStr(cc["@_specialInstruction"]);
      const taped = instruction === "TapedRoute" || instruction === "FunnelTapedRoute";
      if (rowType === "CrossingPoint" || rowType === "EndOfMarkedRoute") {
        pending.legLength += safeFloat(cc.LegLength);
        if (taped) pending.style = "marked_route";
        if (rowType === "CrossingPoint" && !pending.crossing && safeStr(cc.Control)) {
          pending.crossing = {
            controlId: safeStr(cc.Control),
            ...(instruction === "MandatoryOutOfBoundsAreaPassage" ? { section: true as const } : {}),
          };
        }
        continue;
      }
      // IOF / Purple Pen emit randomOrder="true"; also accept bare/empty
      // boolean forms from older exporters.
      const rawRo = cc["@_randomOrder"];
      const randomOrder =
        rawRo === true ||
        rawRo === "" ||
        safeStr(rawRo).toLowerCase() === "true";
      // A row before the course's first one joins no leg.
      const first = courseControls.length === 0;
      courseControls.push({
        controlId: safeStr(cc.Control),
        type: rowType as ParsedCourseControl["type"],
        legLength: safeFloat(cc.LegLength) + (first ? 0 : pending.legLength),
        ...(randomOrder ? { randomOrder: true } : {}),
        ...(!first && pending.crossing ? { crossing: pending.crossing } : {}),
        ...(taped || (!first && pending.style) ? { style: "marked_route" as const } : {}),
      });
      pending = { legLength: 0 };
    }

    // Whole-course free order: every Control-type row has randomOrder.
    // Partial runs (some true, some false) stay ordered — documented
    // limitation until per-block support lands.
    const regular = courseControls.filter((c) => c.type === "Control");
    const orderMode: "ordered" | "free_order" =
      regular.length > 0 && regular.every((c) => c.randomOrder)
        ? "free_order"
        : "ordered";

    const family = safeStr(rc.CourseFamily).trim();
    courses.push({ name, ...(family ? { family } : {}), length, climb, controls: courseControls, orderMode });
  }

  // Parse class-course assignments
  const rawAssignments = raceCourseData.ClassCourseAssignment ?? [];
  const classAssignments: ClassAssignment[] = [];
  for (const ra of Array.isArray(rawAssignments) ? rawAssignments : [rawAssignments]) {
    const className = safeStr(ra.ClassName);
    const courseName = safeStr(ra.CourseName);
    if (className && courseName) {
      classAssignments.push({ className, courseName });
    }
  }

  const base = { controls, courses, classAssignments, mapScale };
  const courseGeometry = buildStraightLineGeometry(controls, courses);

  return {
    ...base,
    courseGeometry,
    mapFeatures: [],
    geometrySource: "xml"
  };
}

// ─── Straight-line GeoJSON builder ───────────────────────────────────────────

/**
 * Build straight-line GeoJSON FeatureCollections for each course.
 * Uses the mapX/mapY positions stored on controls (populated from IOF XML).
 * This is the "xml" source geometry — lower priority than OCD routed geometry.
 */
export function buildStraightLineGeometry(
  controls: ParsedControl[],
  courses: ParsedCourse[],
): Record<string, GeoJSONFeatureCollection> {
  // Build a position lookup by control ID
  const posById = new Map<string, { xMm: number; yMm: number }>();
  for (const c of controls) {
    if (c.mapX !== 0 || c.mapY !== 0) {
      posById.set(c.id, { xMm: c.mapX, yMm: c.mapY });
    }
  }

  const result: Record<string, GeoJSONFeatureCollection> = {};

  for (const course of courses) {
    const features: GeoJSONFeature[] = [];

    // Points
    for (const cc of course.controls) {
      const p = posById.get(cc.controlId);
      if (!p) continue;
      const symType = cc.type === "Start" ? "start" : cc.type === "Finish" ? "finish" : "control";
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [p.xMm, p.yMm] },
        properties: { symbolType: symType, code: cc.controlId },
      });
    }

    // Legs (straight lines, through the file's bends where it has them)
    for (let i = 0; i < course.controls.length - 1; i++) {
      const fromId = course.controls[i].controlId;
      const toId = course.controls[i + 1].controlId;
      const fromP = posById.get(fromId);
      const toP = posById.get(toId);
      if (!fromP || !toP) continue;
      const bends = course.controls[i + 1].bends ?? [];

      features.push({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [fromP.xMm, fromP.yMm],
            ...bends.map((b): [number, number] => [b.x, b.y]),
            [toP.xMm, toP.yMm],
          ],
        },
        properties: {
          symbolType: "leg", from: fromId, to: toId, isDoglegFrom: false, isDoglegTo: false,
          ...(bends.length > 0 ? { bent: true } : {}),
        },
      });
    }

    result[course.name] = { type: "FeatureCollection", features };
  }

  return result;
}

export const parseIOFCourseDataWithGeometry = parseIOFCourseData;
