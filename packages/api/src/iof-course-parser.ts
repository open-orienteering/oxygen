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
  type: "Start" | "Control" | "Finish";
  lat: number;          // WGS84 latitude
  lng: number;          // WGS84 longitude
  mapX: number;         // map position X in mm
  mapY: number;         // map position Y in mm
  cuts?: SlitGap[];     // Optional gap angles for OCAD circle masking
}

export interface ParsedCourseControl {
  controlId: string;
  type: "Start" | "Control" | "Finish";
  legLength: number;    // meters
}

export interface ParsedCourse {
  name: string;
  length: number;       // meters
  climb: number;
  controls: ParsedCourseControl[];
}

export interface ClassAssignment {
  className: string;
  courseName: string;
}

export interface ParsedCourseData {
  controls: ParsedControl[];
  courses: ParsedCourse[];
  classAssignments: ClassAssignment[];
  mapScale: number;
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
    return arrayPaths.includes(jpath);
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
    const type = safeStr(rc["@_type"]) as ParsedControl["type"] || "Control";
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
    for (const cc of Array.isArray(rawCCs) ? rawCCs : [rawCCs]) {
      courseControls.push({
        controlId: safeStr(cc.Control),
        type: safeStr(cc["@_type"]) as ParsedCourseControl["type"] || "Control",
        legLength: safeFloat(cc.LegLength),
      });
    }

    courses.push({ name, length, climb, controls: courseControls });
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

    // Legs (straight lines)
    for (let i = 0; i < course.controls.length - 1; i++) {
      const fromId = course.controls[i].controlId;
      const toId = course.controls[i + 1].controlId;
      const fromP = posById.get(fromId);
      const toP = posById.get(toId);
      if (!fromP || !toP) continue;

      features.push({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [fromP.xMm, fromP.yMm],
            [toP.xMm, toP.yMm],
          ],
        },
        properties: { symbolType: "leg", from: fromId, to: toId, isDoglegFrom: false, isDoglegTo: false },
      });
    }

    result[course.name] = { type: "FeatureCollection", features };
  }

  return result;
}

export const parseIOFCourseDataWithGeometry = parseIOFCourseData;
