/**
 * Import stage 5, analyse (docs/map-import.md §1, §3.8; research 06
 * §4.1): bounds, the georeference projected to WGS 84, and the drawn
 * magnetic-north lines. Pure and isomorphic like stages 3–8. Nothing
 * here goes into the document bytes: the results are transcendental and
 * derived, so they live in the import report (`georeference`, `north`)
 * and feed the `map_files` quick-access columns at pin time
 * (docs/map-storage.md §3, §6.4). `analyseMapDocument` gives the same
 * answer from a stored document as `analyseDocumentInput` from the
 * normaliser's output.
 */

import { inputBounds, type MapDocument, type MapDocumentInput } from "../map-document/codec.js";
import type { DocumentBounds } from "../map-document/header.js";
import { clusterMeridians, lineTiltDeg, MERIDIAN_MIN_LENGTH_MM } from "../geo/north.js";
import {
  epsgOf,
  gridConvergence,
  paperNorthBearingDeg,
  wgs84Bounds,
  type FrameGeoreferencing,
  type LatLng,
  type PaperFrame,
  type Wgs84Bounds,
} from "../geo/projection.js";

/** The drawn magnetic-north lines: the winning 601.x symbol group. */
export interface DocumentMeridian {
  /** Index into `header.symbols`. */
  symbolIdx: number;
  code: string;
  count: number;
  /** Median tilt of the lines from paper +Y, clockwise positive, degrees. */
  medianTiltDeg: number;
  stddevDeg: number;
}

export interface DocumentAnalysis {
  bounds: DocumentBounds;
  georeference: {
    /** `"EPSG:<code>"` when the header carries a CRS, else null. */
    crs: string | null;
    method: "epsg" | "none";
    /** proj4 has a definition for `crs`; the WGS 84 fields below need it. */
    projectable: boolean;
    /** Declared grivation (`header.georeferencing.gridRotationDeg`). */
    gridRotationDeg: number;
    /** Meridian convergence at the paper origin: true north from grid north, degrees. */
    gridConvergenceDeg: number | null;
    /** The paper origin in WGS 84. */
    originWgs84: LatLng | null;
    /** WGS 84 box around the projected corners of `bounds`. */
    wgs84Bounds: Wgs84Bounds | null;
  };
  north: {
    meridian: DocumentMeridian | null;
    /** Bearing of paper +Y from true north (grid rotation + convergence), degrees. */
    paperNorthBearingDeg: number | null;
    /** `paperNorthBearingDeg` + meridian tilt: what the viewer puts at the top (`map_files.north_offset` with no correction). */
    displayNorthOffsetDeg: number | null;
  };
}

/** ISOM magnetic north line codes: `601` and `601.x`. */
export function isMeridianCode(code: string): boolean {
  return code === "601" || /^601\.\d+$/.test(code);
}

interface AnalysisSource {
  unitsPerMm: number;
  mapScale: number;
  georeferencing: FrameGeoreferencing;
  symbols: ArrayLike<{ code: string; origin?: string }>;
  bounds: DocumentBounds;
  /** Calls `line` with each object's symbol and first / last coordinate (objects with ≥ 2 coordinates). */
  eachEnds(line: (symbolIdx: number, x0: number, y0: number, x1: number, y1: number) => void): void;
}

function analyse(src: AnalysisSource): DocumentAnalysis {
  const meridianSymbols = new Set<number>();
  for (let i = 0; i < src.symbols.length; i++) {
    const s = src.symbols[i];
    if ((s.origin ?? "source") === "source" && isMeridianCode(s.code)) meridianSymbols.add(i);
  }
  // Groups keyed by symbol index, in symbol-table order so ties resolve the same way whatever the object order.
  const groups = new Map<number, number[]>([...meridianSymbols].sort((a, b) => a - b).map((i) => [i, []]));
  const minLen = MERIDIAN_MIN_LENGTH_MM * src.unitsPerMm;
  if (meridianSymbols.size) {
    src.eachEnds((symbolIdx, x0, y0, x1, y1) => {
      const g = groups.get(symbolIdx);
      if (!g || Math.hypot(x1 - x0, y1 - y0) < minLen) return;
      g.push(lineTiltDeg(x0, y0, x1, y1));
    });
  }
  const best = clusterMeridians(groups);
  const meridian: DocumentMeridian | null = best
    ? { symbolIdx: best.key, code: src.symbols[best.key].code, count: best.count, medianTiltDeg: best.medianTiltDeg, stddevDeg: best.stddevDeg }
    : null;

  const frame: PaperFrame = { unitsPerMm: src.unitsPerMm, mapScale: src.mapScale, georeferencing: src.georeferencing };
  const { crs } = src.georeferencing;
  const epsg = epsgOf(frame);
  const convergence = gridConvergence(frame);
  const paperNorth = paperNorthBearingDeg(frame, src.bounds);
  return {
    bounds: { ...src.bounds },
    georeference: {
      crs: crs ? `${crs.authority}:${crs.code}` : null,
      method: crs ? "epsg" : "none",
      projectable: epsg !== null,
      gridRotationDeg: src.georeferencing.gridRotationDeg ?? 0,
      gridConvergenceDeg: convergence?.angleDeg ?? null,
      originWgs84: convergence ? { lat: convergence.lat, lng: convergence.lng } : null,
      wgs84Bounds: wgs84Bounds(frame, src.bounds),
    },
    north: {
      meridian,
      paperNorthBearingDeg: paperNorth,
      displayNorthOffsetDeg: paperNorth === null ? null : paperNorth + (meridian?.medianTiltDeg ?? 0),
    },
  };
}

/** Stage 5 over the normaliser's output (before stages 6–8). */
export function analyseDocumentInput(input: MapDocumentInput): DocumentAnalysis {
  const { header, objects } = input;
  return analyse({
    unitsPerMm: header.unitsPerMm,
    mapScale: header.mapScale,
    georeferencing: header.georeferencing,
    symbols: header.symbols,
    bounds: inputBounds(objects),
    eachEnds(line) {
      for (const o of objects) {
        const c = o.coords, n = c.length;
        if (n >= 4) line(o.symbolIdx, c[0], c[1], c[n - 2], c[n - 1]);
      }
    },
  });
}

/** Stage 5 over a decoded document (dedup hits, stored documents). */
export function analyseMapDocument(doc: MapDocument): DocumentAnalysis {
  const { header, attrs, coords, coordStart } = doc;
  return analyse({
    unitsPerMm: header.unitsPerMm,
    mapScale: header.mapScale,
    georeferencing: header.georeferencing,
    symbols: header.symbols,
    bounds: header.bounds,
    eachEnds(line) {
      for (let i = 0; i < header.objects.count; i++) {
        const a = coordStart[i], b = coordStart[i + 1];
        if (b - a >= 2) line(attrs.symbolIdx[i], coords[a * 2], coords[a * 2 + 1], coords[(b - 1) * 2], coords[(b - 1) * 2 + 1]);
      }
    },
  });
}
