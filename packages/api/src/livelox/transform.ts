/**
 * Transforms a raw Livelox ClassBlob into the source-agnostic ReplayData format.
 */

import type {
  ReplayData,
  ReplayMap,
  ReplayProjection,
  ReplayCourse,
  ReplayControl,
  ReplayRoute,
  ReplayResult,
  ReplaySplitTime,
} from "@oxygen/shared";
import type { LiveloxClassBlob } from "./fetcher.js";
import { decodeRouteData } from "./decoder.js";
import { getProjectedToLatLng } from "./crs.js";

// ─── Distinct color palette for participants ────────────────

const ROUTE_COLORS = [
  "#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4",
  "#42d4f4", "#f032e6", "#bfef45", "#fabed4", "#469990",
  "#dcbeff", "#9a6324", "#800000", "#aaffc3", "#808000",
  "#000075", "#a9a9a9", "#e6beff", "#fffac8", "#ffd8b1",
];

// ─── Control type mapping ───────────────────────────────────

export function mapControlType(liveloxType: number): ReplayControl["type"] {
  switch (liveloxType) {
    case 0:
      return "start";
    case 2:
      return "finish";
    default:
      return "control";
  }
}

// ─── Result status mapping ──────────────────────────────────

export function mapResultStatus(liveloxStatus: number): ReplayResult["status"] {
  // Livelox result status: 0=OK, 1=MP, 2=DNF, 3=DNS, 4=DQ, ...
  switch (liveloxStatus) {
    case 0:
      return "ok";
    case 1:
      return "mp";
    case 2:
      return "dnf";
    case 3:
      return "dns";
    case 4:
      return "dq";
    default:
      return "unknown";
  }
}

// ─── Projection extraction ──────────────────────────────────

function extractProjection(
  blob: LiveloxClassBlob,
): ReplayProjection {
  // Prefer tileData.mapTileInfo.imageInfo.defaultProjection (matches tile coords)
  const proj =
    blob.tileData?.mapTileInfo?.imageInfo?.defaultProjection ??
    blob.map.defaultProjection;

  const m = proj.matrix;
  // Livelox stores a full 3×3 row-major matrix: [[a, b, tx], [c, d, ty], [0, 0, 1]]
  return {
    matrix: [m[0][0], m[0][1], m[0][2], m[1][0], m[1][1], m[1][2]],
    originLat: proj.origin.latitude,
    originLng: proj.origin.longitude,
  };
}

// ─── Split time decoding ────────────────────────────────────

/**
 * Decode Livelox splitTimeData into ReplaySplitTime[].
 *
 * Format: [baseTimeMs, startCode, legTime1, ctrlCode1, legTime2, ctrlCode2, ..., lastLegTime, finishCode]
 * - baseTimeMs: absolute start time (same timebase as route waypoints)
 * - Leg times are individual (not cumulative) in milliseconds
 * - Control codes are numericCode values from the course
 */
export function decodeSplitTimes(
  splitTimeData: number[],
  courseControls: Array<{ code: string; numericCode: number }>,
): { splits: ReplaySplitTime[]; baseTimeMs: number } {
  if (!splitTimeData || splitTimeData.length < 2) return { splits: [], baseTimeMs: 0 };

  const baseTimeMs = splitTimeData[0];
  const splits: ReplaySplitTime[] = [];
  const codeToName = new Map(courseControls.map((c) => [c.numericCode, c.code]));

  let cumulativeMs = 0;
  // Skip [0]=baseTime, [1]=startCode; then pairs of (legTime, ctrlCode)
  for (let i = 2; i < splitTimeData.length; i += 2) {
    const legTimeMs = splitTimeData[i];
    const ctrlCode = i + 1 < splitTimeData.length ? splitTimeData[i + 1] : undefined;
    cumulativeMs += legTimeMs;

    const controlName = ctrlCode !== undefined ? codeToName.get(ctrlCode) ?? String(ctrlCode) : "?";
    splits.push({
      controlCode: controlName,
      timeMs: cumulativeMs,
    });
  }

  return { splits, baseTimeMs };
}

// ─── Main transform ─────────────────────────────────────────

export function transformToReplayData(
  blob: LiveloxClassBlob,
  options: {
    eventName: string;
    className: string;
    /** Base URL for tile proxy (e.g. "/api/livelox-tile"). Tiles are rewritten to go through this. */
    tileProxyBase?: string;
  },
): ReplayData {
  const { eventName, className, tileProxyBase } = options;

  // CRS conversion for projected route data
  const epsg = blob.projectionEpsgCode;
  const toLatLng = epsg ? getProjectedToLatLng(epsg) : null;
  const isProjected = !!toLatLng;

  // ── Map ──
  const tileInfo = blob.tileData?.mapTileInfo;
  const mapWidth = tileInfo?.imageInfo?.width ?? blob.map.width;
  const mapHeight = tileInfo?.imageInfo?.height ?? blob.map.height;
  const projection = extractProjection(blob);

  const tiles = (tileInfo?.mapTiles ?? []).map((t) => ({
    x: t.x,
    y: t.y,
    width: t.width,
    height: t.height,
    url: tileProxyBase
      ? `${tileProxyBase}?url=${encodeURIComponent(t.url)}`
      : t.url,
  }));

  const replayMap: ReplayMap = {
    widthPx: mapWidth,
    heightPx: mapHeight,
    projection,
    mapScale: blob.map.mapScale ?? undefined,
    rotation: blob.map.rotation ?? 0,
    tiles,
  };

  // If no tiles, fall back to single image URL
  if (tiles.length === 0 && blob.map.url) {
    replayMap.imageUrl = tileProxyBase
      ? `${tileProxyBase}?url=${encodeURIComponent(blob.map.url)}`
      : blob.map.url;
  }

  // ── Courses ──
  const courses: ReplayCourse[] = (blob.courses ?? []).map((c) => ({
    name: c.name ?? className,
    controls: c.controls.map((ctrl) => ({
      code: ctrl.control.code,
      type: mapControlType(ctrl.control.type),
      lat: ctrl.control.position.latitude,
      lng: ctrl.control.position.longitude,
    })),
    lengthM: c.length,
  }));

  // ── Course control lookup for split time decoding ──
  const courseControls = (blob.courses?.[0]?.controls ?? []).map((c) => ({
    code: c.control.code,
    numericCode: c.control.numericCode,
  }));

  // ── Routes ──
  const activeParticipants = (blob.participants ?? []).filter(
    (p) => !p.isDeleted && p.routeData,
  );

  let earliestTimeMs = Infinity;

  // Track which routes have a reliable race start (from split times).
  const reliableRaceStarts: number[] = [];

  const routes: ReplayRoute[] = activeParticipants.map((p, idx) => {
    const decoded = decodeRouteData(p.routeData!, isProjected ? { projected: true, toLatLng } : undefined);

    if (decoded.waypoints.length > 0) {
      const firstTime = decoded.waypoints[0].timeMs;
      if (firstTime < earliestTimeMs) earliestTimeMs = firstTime;
    }

    // Apply routePositionTimeOffset: Livelox uses this to correct the GPS
    // timeline when the watch clock differs from race time.
    if (p.routePositionTimeOffset && decoded.waypoints.length > 0) {
      for (const wp of decoded.waypoints) {
        wp.timeMs -= p.routePositionTimeOffset;
      }
    }

    const route: ReplayRoute = {
      participantId: String(p.id),
      name: `${p.firstName} ${p.lastName}`.trim(),
      organisation: p.result?.organisationName,
      color: ROUTE_COLORS[idx % ROUTE_COLORS.length],
      waypoints: decoded.waypoints,
      interruptions: decoded.interruptions,
    };

    if (p.result) {
      const { splits, baseTimeMs } = p.result.splitTimeData
        ? decodeSplitTimes(p.result.splitTimeData, courseControls)
        : { splits: [], baseTimeMs: 0 };

      if (baseTimeMs > 0) {
        route.raceStartMs = baseTimeMs;
        reliableRaceStarts.push(baseTimeMs);
      }

      route.result = {
        status: mapResultStatus(p.result.status),
        timeMs: p.result.time,
        rank: p.result.rank,
        splitTimes: splits.length > 0 ? splits : undefined,
      };

      // Correct raceStartMs for late GPS lock: if the runner's result.time
      // implies an earlier start than the GPS/split-based one, use that.
      // This happens when GPS locked after the actual race start.
      if (p.result.time != null && decoded.waypoints.length > 0) {
        const lastWp = decoded.waypoints[decoded.waypoints.length - 1].timeMs;
        const derivedStart = lastWp - p.result.time;
        const currentStart = route.raceStartMs ?? decoded.waypoints[0].timeMs;
        if (derivedStart < currentStart) {
          route.raceStartMs = derivedStart;
        }
      }
    }

    return route;
  });

  // For runners without split data (no punch record, late GPS lock, DNS, etc.),
  // infer the race start from the consensus of runners who do have split data.
  // This is reliable for mass-start classes where all reliable starts cluster
  // within a few seconds of each other. For interval-start classes the spread
  // will be large, so we leave those runners' raceStartMs undefined.
  if (reliableRaceStarts.length > 0) {
    reliableRaceStarts.sort((a, b) => a - b);
    const medianStart = reliableRaceStarts[Math.floor(reliableRaceStarts.length / 2)];
    const spread = reliableRaceStarts[reliableRaceStarts.length - 1] - reliableRaceStarts[0];
    const isMassStart = spread < 60_000; // all starters within 60 s → treat as mass start

    if (isMassStart) {
      for (const route of routes) {
        if (route.raceStartMs == null) {
          route.raceStartMs = medianStart;
        }
      }
    }
  }

  if (!isFinite(earliestTimeMs)) earliestTimeMs = 0;

  return {
    title: `${eventName} — ${className}`,
    sourceType: "livelox",
    map: replayMap,
    courses,
    routes,
    referenceTimeMs: earliestTimeMs,
  };
}
