/**
 * GPX 1.0 / 1.1 → tracks in WGS 84 (docs/map-gps-tracks.md §2). Runs in
 * the browser: the server stores points, not the file (SLICES.md slice G,
 * "Decided in this split"). Streams over the import's dependency-free
 * tokenizer (`import/xml.ts`), so a file of hundreds of thousands of
 * points never becomes a tree.
 */

import { parseXml, XmlParseError } from "../import/xml.js";
import { quantiseDeg, quantiseEle, type Track, type TrackPoints } from "./track.js";

export type GpxErrorCode = "malformed" | "not-gpx" | "no-points";

/** The file cannot be read as GPX tracks. `offset` is the character offset of a markup error. */
export class GpxParseError extends Error {
  readonly code: GpxErrorCode;
  readonly offset?: number;
  constructor(code: GpxErrorCode, message: string, offset?: number) {
    super(message);
    this.name = "GpxParseError";
    this.code = code;
    if (offset !== undefined) this.offset = offset;
  }
}

/** A track as parsed: where in the file it came from. */
export interface ParsedTrack extends Track {
  /** `rte` points are untimed: their `time` column is null whatever the file says. */
  source: "trk" | "rte";
  /** Position of the `trk` (or `rte`) among its kind in the file. */
  trackIndex: number;
  /** Position of the `trkseg` in its `trk` (0 for a route). */
  segmentIndex: number;
}

export interface GpxFile {
  /** One per `trkseg` (and per `rte`) with at least two valid points, in file order. */
  tracks: ParsedTrack[];
  /** `wpt` elements: counted, not imported. */
  waypoints: number;
  /** Points dropped for a missing, unreadable or out-of-range `lat` / `lon`. */
  skippedPoints: number;
  /** Segments and routes dropped for holding fewer than two valid points. */
  skippedSegments: number;
  /** The root's `creator` and `version` attributes. */
  creator: string | null;
  version: string | null;
}

/** Local name of a possibly prefixed element name (`gpx:trkpt` → `trkpt`). */
const local = (name: string): string => {
  const i = name.indexOf(":");
  return i < 0 ? name : name.slice(i + 1);
};

const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)?$/;

/**
 * ISO 8601 date-time → integer epoch ms. A time without a zone is UTC
 * (the GPX schema's), never local time, so the result does not depend on
 * the machine. Null when unreadable — including a date or time that does
 * not exist (31 February, hour 24, second 60) or a zone offset past 23:59.
 */
export function parseGpxTime(text: string): number | null {
  const m = ISO_TIME.exec(text.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac, zone] = m;
  const month = Number(mo), day = Number(d), hour = Number(h), minute = Number(mi), second = Number(s);
  const year = Number(y);
  let t = Date.UTC(year, month - 1, day, hour, minute, second);
  // Date.UTC rolls an impossible field over (31 Feb → 3 Mar); such a time is unreadable.
  const back = new Date(t);
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day || back.getUTCHours() !== hour || back.getUTCMinutes() !== minute || back.getUTCSeconds() !== second) {
    return null;
  }
  t += frac ? Math.round(Number(`0.${frac}`) * 1000) : 0;
  if (zone && zone !== "Z") {
    const sign = zone[0] === "-" ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    const oh = Number(digits.slice(0, 2)), om = digits.length > 2 ? Number(digits.slice(2)) : 0;
    if (oh > 23 || om > 59) return null;
    t -= sign * (oh * 60 + om) * 60000;
  }
  return Number.isFinite(t) ? t : null;
}

/** A plain decimal (optionally signed, optionally with an exponent) — not `Number()`'s hex, binary or `Infinity`. */
const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

function finiteOrNull(text: string | undefined): number | null {
  if (text === undefined) return null;
  const s = text.trim();
  if (!DECIMAL.test(s)) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

interface Segment {
  lat: number[];
  lng: number[];
  time: (number | null)[];
  ele: (number | null)[];
  skipped: number;
}

const newSegment = (): Segment => ({ lat: [], lng: [], time: [], ele: [], skipped: 0 });

/** Columns of a segment; `time` / `ele` null as a whole when no point has a value. */
function columns(s: Segment, timed: boolean): TrackPoints {
  return {
    lat: s.lat,
    lng: s.lng,
    time: timed && s.time.some((t) => t !== null) ? s.time : null,
    ele: s.ele.some((e) => e !== null) ? s.ele : null,
  };
}

/**
 * Parse a GPX document. Throws `GpxParseError`: `malformed` (not
 * well-formed XML), `not-gpx` (the root is not `gpx`), `no-points` (no
 * segment or route with two valid points).
 */
export function parseGpx(text: string): GpxFile {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const tracks: ParsedTrack[] = [];
  const path: string[] = [];
  let creator: string | null = null;
  let version: string | null = null;
  let rootSeen = false;
  let waypoints = 0;
  let skippedPoints = 0;
  let skippedSegments = 0;
  let trkCount = 0;
  let rteCount = 0;
  /** Depth of an `<extensions>` element being skipped, else -1. */
  let skipDepth = -1;
  // The open trk / rte: its name and its segments, emitted when it closes (a name may follow the segments).
  let trkName: string | null = null;
  let trkSegments: Segment[] = [];
  let seg: Segment | null = null;
  // The open point.
  let pt: { lat: number | null; lng: number | null; time: string | undefined; ele: string | undefined } | null = null;
  // Character data of the element being captured (a name, `ele`, `time`).
  let capture: string | null = null;

  const emit = (source: "trk" | "rte", trackIndex: number, segments: Segment[], name: string | null) => {
    segments.forEach((s, segmentIndex) => {
      skippedPoints += s.skipped;
      if (s.lat.length < 2) skippedSegments++;
      else tracks.push({ name, points: columns(s, source === "trk"), source, trackIndex, segmentIndex });
    });
  };

  try {
    parseXml(src, {
      start(rawName, attrs) {
        const name = local(rawName);
        path.push(name);
        const depth = path.length;
        if (skipDepth >= 0) return;
        if (depth === 1) {
          if (name !== "gpx") throw new GpxParseError("not-gpx", `Not a GPX file (the root element is <${rawName}>)`);
          rootSeen = true;
          creator = attrs.creator ?? null;
          version = attrs.version ?? null;
          return;
        }
        if (name === "extensions") {
          skipDepth = depth;
          return;
        }
        const parent = path[depth - 2];
        if (depth === 2) {
          if (name === "wpt") waypoints++;
          else if (name === "trk" || name === "rte") {
            trkName = null;
            trkSegments = [];
            if (name === "rte") trkSegments.push((seg = newSegment()));
          }
        } else if (depth === 3 && name === "trkseg" && parent === "trk") {
          trkSegments.push((seg = newSegment()));
        } else if ((depth === 4 && name === "trkpt" && parent === "trkseg") || (depth === 3 && name === "rtept" && parent === "rte")) {
          const lat = finiteOrNull(attrs.lat), lng = finiteOrNull(attrs.lon);
          const ok = lat !== null && lng !== null && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
          pt = ok ? { lat, lng, time: undefined, ele: undefined } : { lat: null, lng: null, time: undefined, ele: undefined };
        } else if (depth === 3 && name === "name" && (parent === "trk" || parent === "rte")) {
          capture = "";
        } else if (pt && (name === "ele" || name === "time") && (parent === "trkpt" || parent === "rtept") && (depth === 5 || depth === 4)) {
          capture = "";
        }
      },
      end(rawName) {
        const name = local(rawName);
        const depth = path.length;
        path.pop();
        if (skipDepth >= 0) {
          if (depth === skipDepth) skipDepth = -1;
          return;
        }
        if (capture !== null) {
          const parent = path[path.length - 1];
          if (name === "name" && (parent === "trk" || parent === "rte")) trkName = capture.trim() || null;
          // The first `ele` / `time` wins: a private element of the same local name later in the point does not override it.
          else if (pt && name === "ele") pt.ele ??= capture;
          else if (pt && name === "time") pt.time ??= capture;
          capture = null;
          return;
        }
        if ((name === "trkpt" || name === "rtept") && pt && seg) {
          if (pt.lat === null || pt.lng === null) seg.skipped++;
          else {
            seg.lat.push(quantiseDeg(pt.lat));
            seg.lng.push(quantiseDeg(pt.lng));
            seg.time.push(name === "trkpt" && pt.time !== undefined ? parseGpxTime(pt.time) : null);
            const ele = finiteOrNull(pt.ele);
            seg.ele.push(ele === null ? null : quantiseEle(ele));
          }
          pt = null;
        } else if (depth === 2 && name === "trk") {
          emit("trk", trkCount++, trkSegments, trkName);
          trkSegments = [];
          seg = null;
        } else if (depth === 2 && name === "rte") {
          emit("rte", rteCount++, trkSegments, trkName);
          trkSegments = [];
          seg = null;
        } else if (name === "trkseg") {
          seg = null;
        }
      },
      text(t) {
        if (capture !== null && skipDepth < 0) capture += t;
      },
    });
  } catch (err) {
    if (err instanceof XmlParseError) throw new GpxParseError("malformed", `Not a readable GPX file: ${err.message}`, err.offset);
    throw err;
  }
  if (!rootSeen) throw new GpxParseError("malformed", "Not a readable GPX file: no root element", 0);
  if (tracks.length === 0) throw new GpxParseError("no-points", "The GPX file holds no track or route with two or more points");
  return { tracks, waypoints, skippedPoints, skippedSegments, creator, version };
}
