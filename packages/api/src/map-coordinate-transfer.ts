/**
 * Move paper-millimetre coordinates from one georeferenced map to another.
 *
 * Paper mm (`controls.xpos/ypos`, course geometry) are only meaningful
 * together with the map file they were measured on: the origin is that
 * file's georeference reference point. Two maps of the same terrain
 * normally have different reference points, so the same terrain feature
 * has different paper coordinates in each.
 *
 * The bridge is the real world: source paper mm → WGS84 → target paper
 * mm. Used when importing a course file that was set on a different map
 * than the one the event uses (Purple Pen records its map file name).
 */

import {
  mapMmToWgs84,
  wgs84ToOcad,
  type OcadCrs,
} from "./map-projection.js";
import type {
  GeoJSONFeature,
  GeoJSONFeatureCollection,
  ParsedCourseData,
} from "./iof-course-parser.js";

export interface TransferredPoint {
  xMm: number;
  yMm: number;
  lat: number;
  lng: number;
}

/**
 * Re-express one paper-mm point from `from`'s paper system in `to`'s.
 * Returns null when either CRS has a grid we cannot project.
 */
export function transferPaperMm(
  xMm: number,
  yMm: number,
  from: OcadCrs,
  to: OcadCrs,
): TransferredPoint | null {
  const wgs = mapMmToWgs84(xMm, yMm, from);
  if (!wgs) return null;
  const ocad = wgs84ToOcad(wgs.lat, wgs.lng, to);
  if (!ocad) return null;
  return { xMm: ocad.x / 100, yMm: ocad.y / 100, lat: wgs.lat, lng: wgs.lng };
}

/** Transfer every coordinate of a GeoJSON geometry, or null on failure. */
function transferGeometry(
  geometry: GeoJSONFeature["geometry"],
  from: OcadCrs,
  to: OcadCrs,
): GeoJSONFeature["geometry"] | null {
  const point = (c: [number, number]): [number, number] | null => {
    const t = transferPaperMm(c[0], c[1], from, to);
    return t ? [t.xMm, t.yMm] : null;
  };

  switch (geometry.type) {
    case "Point": {
      const p = point(geometry.coordinates);
      return p ? { type: "Point", coordinates: p } : null;
    }
    case "LineString": {
      const line: [number, number][] = [];
      for (const c of geometry.coordinates) {
        const p = point(c);
        if (!p) return null;
        line.push(p);
      }
      return { type: "LineString", coordinates: line };
    }
    case "MultiLineString":
    case "Polygon": {
      const rings: [number, number][][] = [];
      for (const ring of geometry.coordinates) {
        const out: [number, number][] = [];
        for (const c of ring) {
          const p = point(c);
          if (!p) return null;
          out.push(p);
        }
        rings.push(out);
      }
      return geometry.type === "Polygon"
        ? { type: "Polygon", coordinates: rings }
        : { type: "MultiLineString", coordinates: rings };
    }
  }
}

function transferFeatures(
  features: GeoJSONFeature[],
  from: OcadCrs,
  to: OcadCrs,
): GeoJSONFeature[] | null {
  const out: GeoJSONFeature[] = [];
  for (const f of features) {
    const geometry = transferGeometry(f.geometry, from, to);
    if (!geometry) return null;
    out.push({ ...f, geometry });
  }
  return out;
}

/**
 * Re-anchor a parsed course file from the map it was set on onto the
 * event's map. Control positions, per-course geometry and map features
 * all move; leg lengths and course lengths are real-world metres and
 * stay as they are.
 *
 * Returns null when the coordinates cannot be projected, so the caller
 * can fall back to warning the user instead of writing bad positions.
 */
export function transferParsedCoordinates(
  parsed: ParsedCourseData,
  from: OcadCrs,
  to: OcadCrs,
): ParsedCourseData | null {
  const controls = [];
  for (const c of parsed.controls) {
    // Unplaced controls (0, 0) carry no position to move.
    if (c.mapX === 0 && c.mapY === 0) {
      controls.push(c);
      continue;
    }
    const t = transferPaperMm(c.mapX, c.mapY, from, to);
    if (!t) return null;
    controls.push({ ...c, mapX: t.xMm, mapY: t.yMm, lat: t.lat, lng: t.lng });
  }

  const courseGeometry: Record<string, GeoJSONFeatureCollection> = {};
  for (const [name, fc] of Object.entries(parsed.courseGeometry)) {
    const features = transferFeatures(fc.features, from, to);
    if (!features) return null;
    courseGeometry[name] = { type: "FeatureCollection", features };
  }

  const mapFeatures = transferFeatures(parsed.mapFeatures, from, to);
  if (!mapFeatures) return null;

  return {
    ...parsed,
    controls,
    courseGeometry,
    mapFeatures,
    // Coordinates now live in the target map's paper system.
    mapScale: to.scale > 0 ? to.scale : parsed.mapScale,
  };
}
