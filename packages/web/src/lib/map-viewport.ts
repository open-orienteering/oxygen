/**
 * The map viewer's viewport model (docs/map-rendering.md §5.4 "Viewport").
 *
 * Two implementations behind one set of operations, so `MapViewer`'s
 * gestures, fits and overlay code do not care which base layer is drawn:
 *
 *   - `mercator` — the tile layer's Web Mercator view (centre lat/lng,
 *     fractional slippy-map zoom). Map mm reach it through the
 *     calibration affine, exactly as before B4.
 *   - `paper` — the vector layer's view in paper µm (y-up), CSS px per
 *     µm. Map mm are paper mm (× 1000); WGS 84 inputs (GPS, tracks,
 *     lat/lng-only controls) go through `mapGeo` and nothing else
 *     (10 §6 point 3: one paper ↔ projected ↔ WGS 84 transform).
 *
 * "Inner" pixels are the rotated inner frame of `MapViewer` (size
 * `w × h`, its centre on the container's centre); the overlay SVG lives
 * there and CSS rotates it by the viewport rotation. The GL canvas is not
 * rotated: `glView` folds the same rotation into the view matrix.
 */

import { mapGeo } from "@oxygen/shared";
import type { ViewRect } from "../map-gl/buckets";
import {
  type AffineTransform,
  type TileViewport,
  type WGS84Bounds,
  fitBounds,
  latlngToPixel,
  metersPerPixel,
  pixelToLatlng,
} from "./geo-utils";

export interface MercatorViewport extends TileViewport {
  kind: "mercator";
}

export interface PaperViewport {
  kind: "paper";
  /** Paper µm, y-up. */
  centreX: number;
  centreY: number;
  /** CSS px per paper µm. */
  pxPerUm: number;
}

export type MapViewport = MercatorViewport | PaperViewport;

export interface Pt {
  x: number;
  y: number;
}

/** What the view needs besides itself: the inner frame size and the map's georeference. */
export interface ViewportContext {
  /** Inner (rotated) frame size, CSS px. */
  w: number;
  h: number;
  /** Map mm ↔ lat/lng for the mercator view (calibration or control-derived). */
  affine: AffineTransform | null;
  /** The document's paper frame for the paper view; null without a usable CRS. */
  frame: mapGeo.PaperFrame | null;
}

/** Paper zoom limits, CSS px per paper mm. 100 px/mm ≈ 26× paper at 96 dpi; 0.05 px/mm shows 20 m of paper per screen. */
export const PAPER_MIN_PX_PER_MM = 0.05;
export const PAPER_MAX_PX_PER_MM = 100;
const MERCATOR_MIN_ZOOM = 1;
const MERCATOR_MAX_ZOOM = 22;

export function mercator(vp: TileViewport): MercatorViewport {
  return { kind: "mercator", centerLat: vp.centerLat, centerLng: vp.centerLng, zoom: vp.zoom };
}

// ─── Points ──────────────────────────────────────────────────

export function geoToInner(vp: MapViewport, ctx: ViewportContext, lat: number, lng: number): Pt | null {
  if (vp.kind === "mercator") {
    const { px, py } = latlngToPixel(lat, lng, vp, ctx.w, ctx.h);
    return { x: px, y: py };
  }
  const mm = geoToMm(ctx.frame, lat, lng);
  return mm ? mmToInner(vp, ctx, mm.x, mm.y) : null;
}

export function innerToGeo(vp: MapViewport, ctx: ViewportContext, x: number, y: number): mapGeo.LatLng | null {
  if (vp.kind === "mercator") return pixelToLatlng(x, y, vp, ctx.w, ctx.h);
  const mm = innerToMm(vp, ctx, x, y);
  return mm ? mmToGeo(ctx.frame, mm.x, mm.y) : null;
}

export function mmToInner(vp: MapViewport, ctx: ViewportContext, mmX: number, mmY: number): Pt | null {
  if (vp.kind === "mercator") {
    if (!ctx.affine) return null;
    const { lat, lng } = ctx.affine.toLatLng(mmX, mmY);
    return geoToInner(vp, ctx, lat, lng);
  }
  return {
    x: ctx.w / 2 + (mmX * 1000 - vp.centreX) * vp.pxPerUm,
    y: ctx.h / 2 - (mmY * 1000 - vp.centreY) * vp.pxPerUm,
  };
}

export function innerToMm(vp: MapViewport, ctx: ViewportContext, x: number, y: number): Pt | null {
  if (vp.kind === "mercator") {
    if (!ctx.affine) return null;
    const { lat, lng } = pixelToLatlng(x, y, vp, ctx.w, ctx.h);
    const mm = ctx.affine.toMapMm(lat, lng);
    return { x: mm.mapX, y: mm.mapY };
  }
  return {
    x: (vp.centreX + (x - ctx.w / 2) / vp.pxPerUm) / 1000,
    y: (vp.centreY - (y - ctx.h / 2) / vp.pxPerUm) / 1000,
  };
}

/** WGS 84 → paper mm through `mapGeo` (null without a CRS). */
export function geoToMm(frame: mapGeo.PaperFrame | null, lat: number, lng: number): Pt | null {
  if (!frame) return null;
  const p = mapGeo.wgs84ToPaper(frame, lat, lng);
  return p ? { x: p.x / frame.unitsPerMm, y: p.y / frame.unitsPerMm } : null;
}

/** Paper mm → WGS 84 through `mapGeo` (null without a CRS). */
export function mmToGeo(frame: mapGeo.PaperFrame | null, mmX: number, mmY: number): mapGeo.LatLng | null {
  if (!frame) return null;
  return mapGeo.paperToWgs84(frame, mmX * frame.unitsPerMm, mmY * frame.unitsPerMm);
}

// ─── Gestures ────────────────────────────────────────────────

/**
 * Zooms by `deltaLog2` (log2 of the scale factor) so that the map point
 * under inner pixel (ax, ay) ends up under (tx, ty) — the wheel keeps it
 * in place (t = a), a pinch moves it with the fingers' midpoint.
 */
export function zoomAt(
  vp: MapViewport, ctx: ViewportContext,
  ax: number, ay: number, deltaLog2: number,
  tx = ax, ty = ay,
): MapViewport {
  const { w, h } = ctx;
  if (vp.kind === "mercator") {
    const anchor = pixelToLatlng(ax, ay, vp, w, h);
    const zoom = clamp(vp.zoom + deltaLog2, MERCATOR_MIN_ZOOM, MERCATOR_MAX_ZOOM);
    const zoomed = { ...vp, zoom };
    const after = latlngToPixel(anchor.lat, anchor.lng, zoomed, w, h);
    const c = pixelToLatlng(w / 2 - (tx - after.px), h / 2 - (ty - after.py), zoomed, w, h);
    return { kind: "mercator", centerLat: c.lat, centerLng: c.lng, zoom };
  }
  const ux = vp.centreX + (ax - w / 2) / vp.pxPerUm;
  const uy = vp.centreY - (ay - h / 2) / vp.pxPerUm;
  const p = clamp(vp.pxPerUm * 2 ** deltaLog2, PAPER_MIN_PX_PER_MM / 1000, PAPER_MAX_PX_PER_MM / 1000);
  return { kind: "paper", centreX: ux - (tx - w / 2) / p, centreY: uy + (ty - h / 2) / p, pxPerUm: p };
}

/** Moves the map by (dx, dy) inner pixels (the content follows the pointer). */
export function panBy(vp: MapViewport, ctx: ViewportContext, dx: number, dy: number): MapViewport {
  if (vp.kind === "mercator") {
    const centre = latlngToPixel(vp.centerLat, vp.centerLng, vp, ctx.w, ctx.h);
    const c = pixelToLatlng(centre.px - dx, centre.py - dy, vp, ctx.w, ctx.h);
    return { ...vp, centerLat: c.lat, centerLng: c.lng };
  }
  return { ...vp, centreX: vp.centreX - dx / vp.pxPerUm, centreY: vp.centreY + dy / vp.pxPerUm };
}

/** Centres the view on a WGS 84 position (GPS follow); unchanged when the paper view has no CRS. */
export function centreOnGeo(vp: MapViewport, ctx: ViewportContext, lat: number, lng: number): MapViewport {
  if (vp.kind === "mercator") return { ...vp, centerLat: lat, centerLng: lng };
  const mm = geoToMm(ctx.frame, lat, lng);
  return mm ? { ...vp, centreX: mm.x * 1000, centreY: mm.y * 1000 } : vp;
}

/** Inner-pixel distance between the centres of two views of the same kind, measured in `b`. */
export function centreShiftPx(a: MapViewport, b: MapViewport, ctx: ViewportContext): number {
  if (a.kind === "mercator" && b.kind === "mercator") {
    const p = latlngToPixel(a.centerLat, a.centerLng, b, ctx.w, ctx.h);
    return Math.hypot(p.px - ctx.w / 2, p.py - ctx.h / 2);
  }
  if (a.kind === "paper" && b.kind === "paper") {
    return Math.hypot(a.centreX - b.centreX, a.centreY - b.centreY) * b.pxPerUm;
  }
  return 0;
}

// ─── Fits ────────────────────────────────────────────────────

/** The paper view that shows `bounds` (paper mm) whole, `padding` of the frame left on each side. */
export function fitMm(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  w: number, h: number, padding: number,
): PaperViewport {
  const ew = w * (1 - 2 * padding), eh = h * (1 - 2 * padding);
  const bw = Math.max(1e-3, bounds.maxX - bounds.minX) * 1000;
  const bh = Math.max(1e-3, bounds.maxY - bounds.minY) * 1000;
  const p = ew > 0 && eh > 0 ? Math.min(ew / bw, eh / bh) : 0.004;
  return {
    kind: "paper",
    centreX: ((bounds.minX + bounds.maxX) / 2) * 1000,
    centreY: ((bounds.minY + bounds.maxY) / 2) * 1000,
    pxPerUm: clamp(p, PAPER_MIN_PX_PER_MM / 1000, PAPER_MAX_PX_PER_MM / 1000),
  };
}

export function fitGeo(bounds: WGS84Bounds, w: number, h: number, padding: number): MercatorViewport {
  return mercator(fitBounds(bounds, w, h, padding));
}

// ─── Scale ───────────────────────────────────────────────────

/** CSS px per map mm (the overlay's symbol scale); null when the mercator view lacks a map scale. */
export function pxPerMapMm(vp: MapViewport, mapScale: number | null | undefined): number | null {
  if (vp.kind === "paper") return vp.pxPerUm * 1000;
  if (!mapScale) return null;
  return mapScale / 1000 / metersPerPixel(vp.centerLat, vp.zoom);
}

/** Ground metres per CSS px at `lat` (the view centre when omitted). */
export function metresPerPx(vp: MapViewport, mapScale: number | null | undefined, lat?: number): number | null {
  if (vp.kind === "mercator") return metersPerPixel(lat ?? vp.centerLat, vp.zoom);
  if (!mapScale) return null;
  return mapScale / 1000 / (vp.pxPerUm * 1000);
}

/** Web Mercator zoom with the same ground resolution as the view at `lat` (`data-zoom` keeps its meaning). */
export function mercatorEquivalentZoom(vp: MapViewport, mapScale: number | null | undefined, lat: number | null): number | null {
  if (vp.kind === "mercator") return vp.zoom;
  const mpp = metresPerPx(vp, mapScale);
  if (mpp == null || lat == null) return null;
  return Math.log2((EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180)) / (256 * mpp));
}

const EARTH_CIRCUMFERENCE = 40075016.686;

// ─── Rotation and the GL view ────────────────────────────────

/**
 * Clockwise screen rotation of the inner frame, degrees (CSS `rotate`).
 * Mercator: `−northOffset` turns the map's display-up (paper north plus
 * the meridian lines' tilt) to screen-up over a true-north-up base.
 * Paper: the base is already paper-north-up, so only the meridian tilt
 * (`northOffset − cutRotationDeg`, clockwise from paper +Y) is undone.
 * Both put the drawn meridians vertical. The user's two-finger bearing
 * adds on top.
 */
export function viewportRotationDeg(
  kind: MapViewport["kind"],
  northOffset: number | null | undefined,
  cutRotationDeg: number | null | undefined,
  userBearing: number,
): number {
  if (kind === "mercator") return (northOffset ? -northOffset : 0) + userBearing;
  const tilt = northOffset != null && cutRotationDeg != null ? northOffset - cutRotationDeg : 0;
  return userBearing - tilt;
}

/**
 * The GL view of a paper viewport for a canvas of `containerW × containerH`
 * CSS px at `dpr` device px per CSS px, rotated like the inner frame
 * (`rotationDeg` is counter-clockwise, so the CSS angle is negated). The
 * canvas and the inner frame share their centre, so overlay and canvas
 * agree at every point.
 */
export function glView(vp: PaperViewport, containerW: number, containerH: number, dpr: number, rotDeg: number): ViewRect {
  return {
    centreX: vp.centreX,
    centreY: vp.centreY,
    pxPerUm: vp.pxPerUm * dpr,
    widthPx: Math.max(1, Math.round(containerW * dpr)),
    heightPx: Math.max(1, Math.round(containerH * dpr)),
    rotationDeg: rotDeg === 0 ? 0 : -rotDeg,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
