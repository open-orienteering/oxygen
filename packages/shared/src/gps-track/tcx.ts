/**
 * TCX (Garmin Training Center XML v2) → tracks in WGS 84 (docs/map-gps-tracks.md §2.4), the same result as
 * `parseGpx` so the import treats both alike. Streams over the import's tokenizer like the GPX parser.
 * `parseTrackFile` reads either, by the root element.
 */

import { parseXml, XmlParseError } from "../import/xml.js";
import { finiteOrNull, GpxParseError, localName, parseGpx, parseGpxTime, type GpxFile, type ParsedTrack } from "./gpx.js";
import { quantiseDeg, quantiseEle } from "./track.js";

/** Where an `Activity` sits: `Activities`, or a multisport session's legs (`Activities/MultiSportSession/FirstSport|NextSport`). */
const ACTIVITY_PARENTS = new Set(["Activities", "FirstSport", "NextSport"]);

interface Run {
  lat: number[];
  lng: number[];
  time: (number | null)[];
  ele: (number | null)[];
  skipped: number;
}

/**
 * Parse a TCX document. One track per `Activity` (every `Lap`'s `Track`s joined in file order: a watch's auto-laps
 * and pauses do not cut a recording), timed, unnamed; one untimed track per `Course`, named after its `Name`.
 * A `Trackpoint` without a `Position` (a sensor-only sample) is not a point; one with an unreadable or out-of-range
 * position is skipped and counted. `CoursePoint`s count as waypoints. Throws `GpxParseError`: `malformed`, `not-tcx`
 * (the root is not `TrainingCenterDatabase`), `no-points`.
 */
export function parseTcx(text: string): GpxFile {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const tracks: ParsedTrack[] = [];
  const path: string[] = [];
  let rootSeen = false;
  let creator: string | null = null;
  let waypoints = 0, skippedPoints = 0, skippedSegments = 0, activities = 0, courses = 0;
  let skipDepth = -1;
  /** The open Activity or Course. */
  let run: Run | null = null;
  let courseName: string | null = null;
  let pt: { lat?: string; lng?: string; time?: string; ele?: string; position: boolean } | null = null;
  let capture: string | null = null;

  const emit = (source: "trk" | "rte", trackIndex: number, r: Run, name: string | null) => {
    skippedPoints += r.skipped;
    if (r.lat.length < 2) {
      skippedSegments++;
      return;
    }
    tracks.push({
      name,
      points: {
        lat: r.lat,
        lng: r.lng,
        time: source === "trk" && r.time.some((t) => t !== null) ? r.time : null,
        ele: r.ele.some((e) => e !== null) ? r.ele : null,
      },
      source,
      trackIndex,
      segmentIndex: 0,
    });
  };

  try {
    parseXml(src, {
      start(rawName) {
        const name = localName(rawName);
        path.push(name);
        const depth = path.length;
        if (skipDepth >= 0) return;
        if (depth === 1) {
          if (name !== "TrainingCenterDatabase") throw new GpxParseError("not-tcx", `Not a TCX file (the root element is <${rawName}>)`);
          rootSeen = true;
          return;
        }
        if (name === "Extensions") {
          skipDepth = depth;
          return;
        }
        const parent = path[depth - 2];
        if ((name === "Activity" && ACTIVITY_PARENTS.has(parent)) || (name === "Course" && parent === "Courses")) {
          run = { lat: [], lng: [], time: [], ele: [], skipped: 0 };
          courseName = null;
        } else if (!run) {
          return;
        } else if (name === "Trackpoint" && parent === "Track") {
          pt = { position: false };
        } else if (pt && name === "Position" && parent === "Trackpoint") {
          pt.position = true;
        } else if (pt && parent === "Position" && (name === "LatitudeDegrees" || name === "LongitudeDegrees")) {
          capture = "";
        } else if (pt && parent === "Trackpoint" && (name === "Time" || name === "AltitudeMeters")) {
          capture = "";
        } else if (name === "CoursePoint" && parent === "Course") {
          waypoints++;
        } else if (name === "Name" && (parent === "Course" || (parent === "Creator" && creator === null))) {
          capture = "";
        }
      },
      end(rawName) {
        const name = localName(rawName);
        const depth = path.length;
        path.pop();
        if (skipDepth >= 0) {
          if (depth === skipDepth) skipDepth = -1;
          return;
        }
        if (capture !== null) {
          const parent = path[path.length - 1];
          const v = capture;
          capture = null;
          if (pt && name === "LatitudeDegrees") pt.lat ??= v;
          else if (pt && name === "LongitudeDegrees") pt.lng ??= v;
          else if (pt && name === "Time") pt.time ??= v;
          else if (pt && name === "AltitudeMeters") pt.ele ??= v;
          else if (name === "Name" && parent === "Course") courseName = v.trim() || null;
          else if (name === "Name" && parent === "Creator") creator = v.trim() || null;
          return;
        }
        const r = run as Run | null;
        if (name === "Trackpoint" && pt && r) {
          if (pt.position) {
            const lat = finiteOrNull(pt.lat), lng = finiteOrNull(pt.lng);
            // 0° / 0° is a device's "no fix", not a point in the Gulf of Guinea (§2.4).
            if (lat === null || lng === null || lat < -90 || lat > 90 || lng < -180 || lng > 180 || (lat === 0 && lng === 0)) r.skipped++;
            else {
              r.lat.push(quantiseDeg(lat));
              r.lng.push(quantiseDeg(lng));
              r.time.push(pt.time !== undefined ? parseGpxTime(pt.time) : null);
              const ele = finiteOrNull(pt.ele);
              r.ele.push(ele === null ? null : quantiseEle(ele));
            }
          }
          pt = null;
        } else if (r && name === "Activity" && ACTIVITY_PARENTS.has(path[path.length - 1])) {
          emit("trk", activities++, r, null);
          run = null;
        } else if (r && name === "Course" && path[path.length - 1] === "Courses") {
          emit("rte", courses++, r, courseName);
          run = null;
        }
      },
      text(t) {
        if (capture !== null && skipDepth < 0) capture += t;
      },
    });
  } catch (err) {
    if (err instanceof XmlParseError) throw new GpxParseError("malformed", `Not a readable TCX file: ${err.message}`, err.offset);
    throw err;
  }
  if (!rootSeen) throw new GpxParseError("malformed", "Not a readable TCX file: no root element", 0);
  if (tracks.length === 0) throw new GpxParseError("no-points", "The TCX file holds no activity or course with two or more positions");
  return { tracks, waypoints, skippedPoints, skippedSegments, creator, version: null };
}

/**
 * A GPX or TCX file, told apart by its root element (not by the file name): `parseGpx`, else `parseTcx` when the
 * root is not `gpx`. A root that is neither is `not-gpx`.
 */
export function parseTrackFile(text: string): GpxFile {
  try {
    return parseGpx(text);
  } catch (e) {
    if (!(e instanceof GpxParseError) || e.code !== "not-gpx") throw e;
  }
  try {
    return parseTcx(text);
  } catch (e) {
    if (e instanceof GpxParseError && e.code === "not-tcx") throw new GpxParseError("not-gpx", "Not a GPX or TCX file");
    throw e;
  }
}
