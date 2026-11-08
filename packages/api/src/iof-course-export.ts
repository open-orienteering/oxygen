/**
 * IOF 3.0 CourseData XML writer.
 *
 * The counterpart to `iof-course-parser.ts`: turns Oxygen's controls,
 * courses and class assignments into a CourseData document that Condes,
 * Purple Pen and OCAD can read — the practical route to printed maps
 * until Oxygen prints them itself — and that round-trips through our own
 * importer without loss.
 *
 * Pure: takes plain data, returns a string. The DB → input mapping lives
 * in `course-export.ts`.
 *
 * Coordinates are paper mm (the unit of `controls.xpos/ypos` and of all
 * course geometry), written to `MapPosition` with `unit="mm"`.
 *
 * The course structure (slice F, row F9; docs/iof-coursedata-export.md):
 * a variant is a `Course` with its root's name as `CourseFamily`; a
 * crossing point is a `CrossingPoint` control and an unnumbered row before
 * the leg's end row; a marked route is `specialInstruction="TapedRoute"` on
 * the leg's end row; the map exchange — which IOF 3.0 has no field for —
 * is an `Extensions` marker on the exchange's `Control`.
 */

import { XMLBuilder } from "fast-xml-parser";

/** The namespace of Oxygen's `Extensions` elements (the map-exchange marker). */
export const OXYGEN_IOF_EXTENSIONS_NS = "urn:oxygen:iof:extensions";

/** IOF 3.0 `CourseControl@specialInstruction` values Oxygen writes. */
export type ExportSpecialInstruction =
  | "TapedRoute"
  | "MandatoryCrossingPoint"
  | "MandatoryOutOfBoundsAreaPassage";

export interface ExportControlSite {
  /**
   * Identifier written as `<Id>` and referenced by course controls —
   * the control's primary punch code (name/seq for start/finish rows).
   */
  id: string;
  type: "Start" | "Control" | "Finish" | "CrossingPoint";
  /** Paper mm. (0, 0) means "not placed" and is skipped. */
  xMm: number;
  yMm: number;
  lat?: number | null;
  lng?: number | null;
  /** A map-exchange site (course-layer.md §11): `Extensions/ox:MapExchange`. */
  mapExchange?: boolean;
}

export interface ExportCourseControl {
  /** Matches an `ExportControlSite.id`. */
  controlId: string;
  /** `CrossingPoint`: the unnumbered row of the crossing point the next row's leg runs through. */
  type: "Start" | "Control" | "Finish" | "CrossingPoint";
  /** Terrain meters of the leg leading to this control. */
  legLengthM?: number | null;
  /** `TapedRoute` on a marked route's end row; a crossing kind on a `CrossingPoint` row. */
  specialInstruction?: ExportSpecialInstruction;
  /** Metres of the taped route (`TapedRoute` only). */
  tapedRouteLengthM?: number;
  /** The bends of the leg into this row, paper mm, handles as offsets (F13) — Purple Pen's `<leg>`; IOF has no field. */
  bends?: ReadonlyArray<{ x: number; y: number; hIn?: { x: number; y: number }; hOut?: { x: number; y: number } }>;
}

export interface ExportCourse {
  name: string;
  /** `CourseFamily`: the root's name for a materialised variant (course-layer.md §12). */
  family?: string;
  lengthM: number;
  climbM: number;
  /** Visit-order mode — free-order emits `randomOrder="true"` on Controls. */
  orderMode?: "ordered" | "free_order";
  /** Full display sequence: start, controls, finish. */
  controls: ExportCourseControl[];
}

export interface CourseDataExport {
  eventName: string;
  /** Map denominator, e.g. 10000 for 1:10 000. */
  mapScale: number;
  controls: ExportControlSite[];
  courses: ExportCourse[];
  classAssignments: Array<{ className: string; courseName: string }>;
  /** `createTime` attribute; defaults to now. Injectable for tests. */
  createTime?: string;
}

/** Round to `d` decimals without exponent notation. */
function round(n: number, d: number): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

/**
 * Build an IOF 3.0 CourseData document.
 *
 * Every *placed* control is exported, not just the ones a course uses, so
 * re-importing the file restores the whole control bank. Course controls
 * referring to unplaced controls are dropped — a leg to nowhere is worse
 * than a shorter course.
 */
export function buildCourseDataXml(input: CourseDataExport): string {
  const placed = input.controls.filter((c) => c.xMm !== 0 || c.yMm !== 0);
  // Ids are the reference keys in the document; a duplicate would make
  // course controls ambiguous, so first one wins.
  const byId = new Map<string, ExportControlSite>();
  for (const c of placed) if (!byId.has(c.id)) byId.set(c.id, c);
  const sites = [...byId.values()];

  const controlNodes = sites.map((c) => {
    const node: Record<string, unknown> = { "@_type": c.type, Id: c.id };
    if (c.lat != null && c.lng != null) {
      node.Position = { "@_lat": round(c.lat, 7), "@_lng": round(c.lng, 7) };
    }
    node.MapPosition = {
      "@_x": round(c.xMm, 2),
      "@_y": round(c.yMm, 2),
      "@_unit": "mm",
    };
    // IOF 3.0 has no map-exchange field (no ControlType value, no
    // CourseControl attribute): the site carries Oxygen's marker.
    if (c.mapExchange) node.Extensions = { "ox:MapExchange": "true" };
    return node;
  });

  const courseNodes = input.courses.map((course) => {
    // Schema order: Name, CourseFamily, Length, Climb, CourseControl.
    const node: Record<string, unknown> = { Name: course.name };
    if (course.family) node.CourseFamily = course.family;
    if (course.lengthM > 0) node.Length = round(course.lengthM, 1);
    if (course.climbM > 0) node.Climb = round(course.climbM, 1);
    const freeOrder = course.orderMode === "free_order";
    node.CourseControl = course.controls
      .filter((cc) => byId.has(cc.controlId))
      .map((cc) => {
        const n: Record<string, unknown> = {
          "@_type": cc.type,
          Control: cc.controlId,
        };
        if (freeOrder && cc.type === "Control") {
          // Valued attr (builder has suppressBooleanAttributes: false) so
          // XMLParser round-trips; bare `randomOrder` is dropped on parse.
          n["@_randomOrder"] = "true";
        }
        if (cc.specialInstruction) {
          n["@_specialInstruction"] = cc.specialInstruction;
          if (cc.specialInstruction === "TapedRoute" && cc.tapedRouteLengthM != null && cc.tapedRouteLengthM > 0) {
            n["@_tapedRouteLength"] = round(cc.tapedRouteLengthM, 1);
          }
        }
        // Free-order courses have no meaningful legs — omit LegLength.
        if (
          !freeOrder &&
          cc.legLengthM != null &&
          cc.legLengthM > 0
        ) {
          n.LegLength = round(cc.legLengthM, 1);
        }
        return n;
      });
    return node;
  });

  const exportedCourseNames = new Set(input.courses.map((c) => c.name));
  const assignmentNodes = input.classAssignments
    .filter((a) => exportedCourseNames.has(a.courseName))
    .map((a) => ({ ClassName: a.className, CourseName: a.courseName }));

  // `Map` requires the image corners in the schema. We ship no image, so
  // the control extent stands in for them — consumers that care about the
  // map itself read the OCD file, not this.
  const mapNode: Record<string, unknown> = {
    Scale: round(input.mapScale > 0 ? input.mapScale : 15000, 0),
  };
  if (sites.length > 0) {
    const xs = sites.map((c) => c.xMm);
    const ys = sites.map((c) => c.yMm);
    mapNode.MapPositionTopLeft = {
      "@_x": round(Math.min(...xs), 2),
      "@_y": round(Math.min(...ys), 2),
      "@_unit": "mm",
    };
    mapNode.MapPositionBottomRight = {
      "@_x": round(Math.max(...xs), 2),
      "@_y": round(Math.max(...ys), 2),
      "@_unit": "mm",
    };
  }

  const raceCourseData: Record<string, unknown> = { Map: mapNode };
  if (controlNodes.length > 0) raceCourseData.Control = controlNodes;
  if (courseNodes.length > 0) raceCourseData.Course = courseNodes;
  if (assignmentNodes.length > 0) {
    raceCourseData.ClassCourseAssignment = assignmentNodes;
  }

  const builder = new XMLBuilder({
    ignoreAttributes: false,
    format: true,
    suppressEmptyNode: true,
    // Keep randomOrder="true" (and other boolean attrs) valued so
    // XMLParser round-trips them — bare `randomOrder` is dropped on parse.
    suppressBooleanAttributes: false,
  });
  const body = builder.build({
    CourseData: {
      "@_xmlns": "http://www.orienteering.org/datastandard/3.0",
      "@_xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
      "@_xmlns:ox": OXYGEN_IOF_EXTENSIONS_NS,
      "@_iofVersion": "3.0",
      "@_createTime": input.createTime ?? new Date().toISOString(),
      "@_creator": "Oxygen",
      Event: { Name: input.eventName },
      RaceCourseData: raceCourseData,
    },
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n${body}`;
}
