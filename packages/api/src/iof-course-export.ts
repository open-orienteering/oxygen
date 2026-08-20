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
 */

import { XMLBuilder } from "fast-xml-parser";

export interface ExportControlSite {
  /**
   * Identifier written as `<Id>` and referenced by course controls —
   * the control's primary punch code (name/seq for start/finish rows).
   */
  id: string;
  type: "Start" | "Control" | "Finish";
  /** Paper mm. (0, 0) means "not placed" and is skipped. */
  xMm: number;
  yMm: number;
  lat?: number | null;
  lng?: number | null;
}

export interface ExportCourseControl {
  /** Matches an `ExportControlSite.id`. */
  controlId: string;
  type: "Start" | "Control" | "Finish";
  /** Terrain meters of the leg leading to this control. */
  legLengthM?: number | null;
}

export interface ExportCourse {
  name: string;
  lengthM: number;
  climbM: number;
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
    return node;
  });

  const courseNodes = input.courses.map((course) => {
    const node: Record<string, unknown> = { Name: course.name };
    if (course.lengthM > 0) node.Length = round(course.lengthM, 1);
    if (course.climbM > 0) node.Climb = round(course.climbM, 1);
    node.CourseControl = course.controls
      .filter((cc) => byId.has(cc.controlId))
      .map((cc) => {
        const n: Record<string, unknown> = {
          "@_type": cc.type,
          Control: cc.controlId,
        };
        if (cc.legLengthM != null && cc.legLengthM > 0) {
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
  });
  const body = builder.build({
    CourseData: {
      "@_xmlns": "http://www.orienteering.org/datastandard/3.0",
      "@_xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
      "@_iofVersion": "3.0",
      "@_createTime": input.createTime ?? new Date().toISOString(),
      "@_creator": "Oxygen",
      Event: { Name: input.eventName },
      RaceCourseData: raceCourseData,
    },
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n${body}`;
}
