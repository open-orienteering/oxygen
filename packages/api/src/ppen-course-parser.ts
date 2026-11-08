/**
 * Purple Pen (.ppen) course parser.
 *
 * `.ppen` is the CourseScribe XML format Purple Pen saves natively:
 * a flat `<course-scribe-event>` with sibling `<control>`, `<course>`
 * and `<course-control>` elements. Coordinates are paper millimetres —
 * the same unit as Oxygen's `controls.xpos/ypos` and IOF MapPosition.
 *
 * Emits the shared `ParsedCourseData` shape so the existing
 * previewImport / importCourses pipeline can consume it unchanged.
 *
 * v1 supports `kind="normal"` courses only. Relay variations (branching
 * `<next>` links) and score courses are rejected with a clear error.
 */

import { XMLParser } from "fast-xml-parser";
import {
  buildStraightLineGeometry,
  type ParsedControl,
  type ParsedCourse,
  type ParsedCourseControl,
  type ParsedCourseData,
  type SourceMapInfo,
} from "./iof-course-parser.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name, jpath) => {
    const arrayPaths = [
      "course-scribe-event.control",
      "course-scribe-event.course",
      "course-scribe-event.course-control",
      "course-scribe-event.course-control.next",
      "course-scribe-event.control.location",
      "course-scribe-event.control.description",
      "course-scribe-event.leg",
      "course-scribe-event.leg.bends.location",
    ];
    if (arrayPaths.includes(String(jpath))) return true;
    // `<next>` may appear once or many times under a course-control.
    return name === "next" || name === "control" || name === "course" ||
      name === "course-control";
  },
});

function safeFloat(val: unknown): number {
  if (val === undefined || val === null || val === "") return 0;
  if (typeof val === "object" && val !== null && "#text" in (val as Record<string, unknown>)) {
    return safeFloat((val as Record<string, unknown>)["#text"]);
  }
  const n = parseFloat(String(val));
  return Number.isFinite(n) ? n : 0;
}

function safeStr(val: unknown): string {
  if (val === undefined || val === null) return "";
  if (typeof val === "object" && val !== null && "#text" in (val as Record<string, unknown>)) {
    return String((val as Record<string, unknown>)["#text"]);
  }
  return String(val);
}

/** True when the payload looks like a Purple Pen `.ppen` document. */
export function isPpenContent(xmlContent: string): boolean {
  return /<course-scribe-event[\s>]/i.test(xmlContent);
}

/** Strip a Windows or POSIX directory prefix from a recorded map path. */
export function mapFileBaseName(path: string): string {
  return path.trim().split(/[\\/]/).pop()?.trim() ?? "";
}

type RawControl = Record<string, unknown>;
type RawCourse = Record<string, unknown>;
type RawCourseControl = Record<string, unknown>;

function controlKind(raw: RawControl): ParsedCourseControl["type"] | null {
  const kind = safeStr(raw["@_kind"]).toLowerCase();
  if (kind === "start") return "Start";
  if (kind === "finish") return "Finish";
  if (kind === "normal" || kind === "") return "Control";
  // map-issue, crossing, etc. — not punchable SI controls. Skip them
  // from the control bank; course walks still follow their links.
  return null;
}

function firstLocation(raw: RawControl): { x: number; y: number } {
  const locs = raw.location;
  const list = Array.isArray(locs) ? locs : locs ? [locs] : [];
  const loc = (list[0] ?? {}) as Record<string, unknown>;
  return { x: safeFloat(loc["@_x"]), y: safeFloat(loc["@_y"]) };
}

/**
 * Parse a Purple Pen `.ppen` (CourseScribe) document into `ParsedCourseData`.
 */
export function parsePpenCourseData(xmlContent: string): ParsedCourseData {
  if (!isPpenContent(xmlContent)) {
    throw new Error(
      "Invalid Purple Pen file: missing <course-scribe-event> root element",
    );
  }

  const parsed = parser.parse(xmlContent);
  const root = parsed["course-scribe-event"];
  if (!root || typeof root !== "object") {
    throw new Error(
      "Invalid Purple Pen file: missing <course-scribe-event> root element",
    );
  }

  const event = (root.event ?? {}) as Record<string, unknown>;
  const map = (event.map ?? {}) as Record<string, unknown>;
  const mapScale = safeFloat(map["@_scale"]) || 15000;

  // The relative path is what the course setter's project used; the
  // absolute path is a fallback for files saved without one.
  const mapFileName =
    mapFileBaseName(safeStr(map["#text"])) ||
    mapFileBaseName(safeStr(map["@_absolute-path"]));
  const sourceMap: SourceMapInfo | undefined = mapFileName
    ? {
        fileName: mapFileName,
        kind: safeStr(map["@_kind"]) || "OCAD",
        scale: mapScale,
      }
    : undefined;

  const rawControls: RawControl[] = Array.isArray(root.control)
    ? root.control
    : root.control
      ? [root.control]
      : [];
  const rawCourses: RawCourse[] = Array.isArray(root.course)
    ? root.course
    : root.course
      ? [root.course]
      : [];
  const rawCCs: RawCourseControl[] = Array.isArray(root["course-control"])
    ? root["course-control"]
    : root["course-control"]
      ? [root["course-control"]]
      : [];

  // Internal ppen control id → public ParsedControl id / type / position.
  // Non-punchable kinds (map-issue, …) are recorded as skippable so the
  // course walk can still follow their links without inventing a code.
  const byInternalId = new Map<
    string,
    | { skip: true }
    | { skip?: false; publicId: string; type: ParsedCourseControl["type"]; mapX: number; mapY: number }
  >();
  const controls: ParsedControl[] = [];
  let startN = 0;
  let finishN = 0;

  for (const raw of rawControls) {
    const internalId = safeStr(raw["@_id"]);
    if (!internalId) continue;
    const type = controlKind(raw);
    if (type === null) {
      byInternalId.set(internalId, { skip: true });
      continue;
    }
    const { x, y } = firstLocation(raw);

    let publicId: string;
    if (type === "Start") {
      startN += 1;
      publicId = `STA${startN}`;
    } else if (type === "Finish") {
      finishN += 1;
      publicId = `FIN${finishN}`;
    } else {
      publicId = safeStr(raw.code).trim();
      if (!publicId) {
        throw new Error(
          `Purple Pen control ${internalId} (normal) has no <code>`,
        );
      }
    }

    byInternalId.set(internalId, { publicId, type, mapX: x, mapY: y });
    controls.push({
      id: publicId,
      type,
      lat: 0,
      lng: 0,
      mapX: x,
      mapY: y,
    });
  }

  // `<leg start-control end-control>`: the bends of the leg between two
  // controls (internal ids), for every course that runs it (row F9).
  // `<flagging>` and `<gaps>` are not read (docs/ppen-import-export.md).
  const rawLegs: Record<string, unknown>[] = Array.isArray(root.leg) ? root.leg : root.leg ? [root.leg] : [];
  const bendsByLeg = new Map<string, Array<{ x: number; y: number }>>();
  for (const leg of rawLegs) {
    const bendsNode = leg.bends as Record<string, unknown> | undefined;
    const locs = bendsNode?.location;
    const list = (Array.isArray(locs) ? locs : locs ? [locs] : []) as Record<string, unknown>[];
    const points = list.map((l) => ({ x: safeFloat(l["@_x"]), y: safeFloat(l["@_y"]) }));
    const key = `${safeStr(leg["@_start-control"])}>${safeStr(leg["@_end-control"])}`;
    if (points.length > 0 && !bendsByLeg.has(key)) bendsByLeg.set(key, points);
  }

  const ccById = new Map<string, RawCourseControl>();
  for (const cc of rawCCs) {
    const id = safeStr(cc["@_id"]);
    if (id) ccById.set(id, cc);
  }

  const courses: ParsedCourse[] = [];
  for (const raw of rawCourses) {
    const name = safeStr(raw.name).trim();
    if (!name) continue;

    const kind = safeStr(raw["@_kind"]).toLowerCase() || "normal";
    if (kind !== "normal") {
      throw new Error(
        `Purple Pen course "${name}" has unsupported kind "${kind}" ` +
          `(only kind="normal" is supported)`,
      );
    }

    const first = raw.first as Record<string, unknown> | undefined;
    const firstId = safeStr(first?.["@_course-control"]);
    if (!firstId) {
      throw new Error(`Purple Pen course "${name}" has no <first> course-control`);
    }

    const sequence: ParsedCourseControl[] = [];
    let currentId: string | null = firstId;
    const seen = new Set<string>();
    /** The internal id of the last kept control: a `<leg>`'s start. */
    let prevInternal: string | null = null;

    while (currentId) {
      if (seen.has(currentId)) {
        throw new Error(
          `Purple Pen course "${name}" has a cycle in course-control links`,
        );
      }
      seen.add(currentId);

      const cc = ccById.get(currentId);
      if (!cc) {
        throw new Error(
          `Purple Pen course "${name}" references missing course-control ${currentId}`,
        );
      }

      const controlInternal = safeStr(cc["@_control"]);
      const site = byInternalId.get(controlInternal);
      if (!site) {
        throw new Error(
          `Purple Pen course "${name}" references missing control ${controlInternal}`,
        );
      }

      const nextsRaw = cc.next;
      const nexts = Array.isArray(nextsRaw)
        ? nextsRaw
        : nextsRaw
          ? [nextsRaw]
          : [];
      if (nexts.length > 1) {
        throw new Error(
          `Purple Pen course "${name}" has branching <next> links ` +
            `(relay/variation courses are not supported)`,
        );
      }

      if (!site.skip) {
        let legLength = 0;
        const bends = prevInternal !== null ? bendsByLeg.get(`${prevInternal}>${controlInternal}`) : undefined;
        if (sequence.length > 0 && mapScale > 0) {
          const prevSite = controls.find(
            (c) => c.id === sequence[sequence.length - 1].controlId,
          );
          if (prevSite) {
            // Along the bends (F1's rule, course-layer.md §10.1).
            const points = [{ x: prevSite.mapX, y: prevSite.mapY }, ...(bends ?? []), { x: site.mapX, y: site.mapY }];
            let mm = 0;
            for (let i = 1; i < points.length; i++) mm += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
            legLength = Math.round((mm * mapScale) / 1000);
          }
        }

        sequence.push({
          controlId: site.publicId,
          type: site.type,
          legLength,
          ...(bends && sequence.length > 0 ? { bends } : {}),
        });
        prevInternal = controlInternal;
      }

      const next = nexts[0] as Record<string, unknown> | undefined;
      currentId = next ? safeStr(next["@_course-control"]) || null : null;
    }

    const length = sequence
      .slice(1)
      .reduce((sum, cc) => sum + (cc.legLength || 0), 0);

    courses.push({
      name,
      length,
      climb: 0,
      controls: sequence,
    });
  }

  return {
    controls,
    courses,
    classAssignments: [],
    mapScale,
    ...(sourceMap ? { sourceMap } : {}),
    courseGeometry: buildStraightLineGeometry(controls, courses),
    mapFeatures: [],
    geometrySource: "xml",
  };
}
