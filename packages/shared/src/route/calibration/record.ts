/**
 * The track record of a calibration (docs/course-elevation.md §7.9.1):
 * courses as controls in WGS 84 and finishers' GPS tracks with their
 * times. A neutral shape: whatever produced it is not this
 * repository's business, and keys beyond these are dropped unread.
 */

import { z } from "zod";
import { wgs84ToPaper, type PaperBounds, type PaperFrame } from "../../geo/projection.js";
import { isGeoreferenced, TrackProjectionError } from "../../gps-track/project.js";
import type { RoutePoint } from "../grid.js";

const latLng = { lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) };

const trackSchema = z.object({
  courseId: z.union([z.string(), z.number()]).transform(String),
  /** Epoch ms of the runner's start, on the waypoints' clock. */
  raceStartMs: z.number().finite().optional(),
  waypoints: z.array(z.object({ timeMs: z.number().finite(), ...latLng })),
  result: z.object({
    status: z.string(),
    /** Elapsed ms from the start to the finish. */
    timeMs: z.number().finite().nullish(),
    /** Elapsed ms from the start to each control punched, in course order. */
    splitTimes: z.array(z.object({ controlCode: z.union([z.string(), z.number()]).transform(String), timeMs: z.number().finite() })).nullish(),
  }).optional(),
});

export const trackRecordSchema = z.object({
  projectionEpsgCode: z.number().int().nullish(),
  map: z.object({ mapScale: z.number().positive().nullish() }).nullish(),
  courses: z.array(z.object({
    id: z.union([z.string(), z.number()]).transform(String),
    controls: z.array(z.object({ code: z.union([z.string(), z.number()]).transform(String), type: z.enum(["start", "control", "finish"]), ...latLng })).min(2),
  })),
  tracks: z.array(trackSchema).optional(),
  /** Read as `tracks`. */
  kept: z.array(trackSchema).optional(),
});
export type TrackRecord = z.infer<typeof trackRecordSchema>;

export interface PaperControl extends RoutePoint { code: string; type: "start" | "control" | "finish" }
export interface PaperTrack {
  courseId: string;
  /** Paper mm, index-aligned with `timeS`. */
  points: RoutePoint[];
  /** Seconds on the track's own clock. */
  timeS: number[];
  startS: number | null;
  finishS: number | null;
  /** Seconds on the track's clock at which each control of the course was punched, in course order where known. */
  splits: { code: string; atS: number }[];
  ok: boolean;
}
export interface ProjectedRecord {
  courses: Map<string, PaperControl[]>;
  tracks: PaperTrack[];
  /** Track points outside the map's bounds. */
  outside: number;
  warnings: string[];
}

/** The record on the map's paper, mm; throws `TrackProjectionError` `not-georeferenced` for a map without a usable CRS. */
export function projectRecord(frame: PaperFrame, bounds: PaperBounds | null, record: TrackRecord): ProjectedRecord {
  if (!isGeoreferenced(frame)) throw new TrackProjectionError("not-georeferenced", "The map has no georeference, so tracks cannot be placed on it");
  const u = frame.unitsPerMm;
  const warnings: string[] = [];
  const crs = frame.georeferencing.crs;
  if (record.projectionEpsgCode && crs && String(record.projectionEpsgCode) !== String(crs.code)) warnings.push("crs-differs");
  if (record.map?.mapScale && Math.abs(record.map.mapScale - frame.mapScale) > 0.5) warnings.push("scale-differs");
  let outside = 0;
  const onPaper = (lat: number, lng: number, count: boolean): RoutePoint => {
    const q = wgs84ToPaper(frame, lat, lng);
    if (!q || !Number.isFinite(q.x) || !Number.isFinite(q.y)) throw new TrackProjectionError("not-projectable", "A point does not project onto the map");
    if (count && bounds && (q.x < bounds.minX || q.x > bounds.maxX || q.y < bounds.minY || q.y > bounds.maxY)) outside++;
    return { x: q.x / u, y: q.y / u };
  };
  const courses = new Map<string, PaperControl[]>();
  for (const c of record.courses) courses.set(c.id, c.controls.map((k) => ({ code: k.code, type: k.type, ...onPaper(k.lat, k.lng, false) })));
  const tracks: PaperTrack[] = [];
  for (const t of [...(record.tracks ?? []), ...(record.kept ?? [])]) {
    if (!courses.has(t.courseId)) { warnings.push("track-without-course"); continue; }
    const startMs = t.raceStartMs ?? null;
    tracks.push({
      courseId: t.courseId,
      points: t.waypoints.map((w) => onPaper(w.lat, w.lng, true)),
      timeS: t.waypoints.map((w) => w.timeMs / 1000),
      startS: startMs === null ? null : startMs / 1000,
      finishS: startMs !== null && t.result?.timeMs != null ? (startMs + t.result.timeMs) / 1000 : null,
      splits: startMs === null ? [] : (t.result?.splitTimes ?? []).map((s) => ({ code: s.controlCode, atS: (startMs + s.timeMs) / 1000 })),
      ok: t.result ? t.result.status.toLowerCase() === "ok" : true,
    });
  }
  return { courses, tracks, outside, warnings: [...new Set(warnings)] };
}
