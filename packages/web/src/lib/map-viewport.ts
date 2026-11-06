/**
 * The map viewer's viewport model (docs/map-rendering.md §5.4 "Viewport"):
 * the vector layer's view in paper µm (y-up), CSS px per µm. Map mm are
 * paper mm (× 1000); WGS 84 inputs (GPS, tracks, lat/lng-only controls)
 * go through `mapGeo` and nothing else (10 §6 point 3: one paper ↔
 * projected ↔ WGS 84 transform). The tile layer's Web Mercator view went
 * with the tiles in E4b.
 *
 * "Inner" pixels are the rotated inner frame of `MapViewer` (size
 * `w × h`, its centre on the container's centre); the overlay SVG lives
 * there and CSS rotates it by the viewport rotation. The GL canvas is not
 * rotated: `glView` folds the same rotation into the view matrix.
 */

import { mapGeo } from "@oxygen/shared";
import type { ViewRect } from "../map-gl/buckets";

export interface PaperViewport {
  /** Paper µm, y-up. */
  centreX: number;
  centreY: number;
  /** CSS px per paper µm. */
  pxPerUm: number;
}

export type MapViewport = PaperViewport;

export interface Pt {
  x: number;
  y: number;
}

/** What the view needs besides itself: the inner frame size and the map's georeference. */
export interface ViewportContext {
  /** Inner (rotated) frame size, CSS px. */
  w: number;
  h: number;
  /** The document's paper frame; null without a usable CRS. */
  frame: mapGeo.PaperFrame | null;
}

/** Paper zoom limits, CSS px per paper mm. 100 px/mm ≈ 26× paper at 96 dpi; 0.05 px/mm shows 20 m of paper per screen. */
export const PAPER_MIN_PX_PER_MM = 0.05;
export const PAPER_MAX_PX_PER_MM = 100;

// ─── Points ──────────────────────────────────────────────────

export function geoToInner(vp: MapViewport, ctx: ViewportContext, lat: number, lng: number): Pt | null {
  const mm = geoToMm(ctx.frame, lat, lng);
  return mm ? mmToInner(vp, ctx, mm.x, mm.y) : null;
}

export function innerToGeo(vp: MapViewport, ctx: ViewportContext, x: number, y: number): mapGeo.LatLng | null {
  const mm = innerToMm(vp, ctx, x, y);
  return mm ? mmToGeo(ctx.frame, mm.x, mm.y) : null;
}

export function mmToInner(vp: MapViewport, ctx: ViewportContext, mmX: number, mmY: number): Pt {
  return {
    x: ctx.w / 2 + (mmX * 1000 - vp.centreX) * vp.pxPerUm,
    y: ctx.h / 2 - (mmY * 1000 - vp.centreY) * vp.pxPerUm,
  };
}

export function innerToMm(vp: MapViewport, ctx: ViewportContext, x: number, y: number): Pt {
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
  const ux = vp.centreX + (ax - w / 2) / vp.pxPerUm;
  const uy = vp.centreY - (ay - h / 2) / vp.pxPerUm;
  const p = clamp(vp.pxPerUm * 2 ** deltaLog2, PAPER_MIN_PX_PER_MM / 1000, PAPER_MAX_PX_PER_MM / 1000);
  return { centreX: ux - (tx - w / 2) / p, centreY: uy + (ty - h / 2) / p, pxPerUm: p };
}

/** Moves the map by (dx, dy) inner pixels (the content follows the pointer). */
export function panBy(vp: MapViewport, dx: number, dy: number): MapViewport {
  return { ...vp, centreX: vp.centreX - dx / vp.pxPerUm, centreY: vp.centreY + dy / vp.pxPerUm };
}

/** Centres the view on a WGS 84 position (GPS follow); unchanged when the document has no CRS. */
export function centreOnGeo(vp: MapViewport, ctx: ViewportContext, lat: number, lng: number): MapViewport {
  const mm = geoToMm(ctx.frame, lat, lng);
  return mm ? { ...vp, centreX: mm.x * 1000, centreY: mm.y * 1000 } : vp;
}

/** Inner-pixel distance between the centres of two views, measured in `b`. */
export function centreShiftPx(a: MapViewport, b: MapViewport): number {
  return Math.hypot(a.centreX - b.centreX, a.centreY - b.centreY) * b.pxPerUm;
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
    centreX: ((bounds.minX + bounds.maxX) / 2) * 1000,
    centreY: ((bounds.minY + bounds.maxY) / 2) * 1000,
    pxPerUm: clamp(p, PAPER_MIN_PX_PER_MM / 1000, PAPER_MAX_PX_PER_MM / 1000),
  };
}

// ─── Scale ───────────────────────────────────────────────────

/** CSS px per map mm (the overlay's symbol scale). */
export function pxPerMapMm(vp: MapViewport): number {
  return vp.pxPerUm * 1000;
}

/** Ground metres per CSS px at the map's scale; null without one. */
export function metresPerPx(vp: MapViewport, mapScale: number | null | undefined): number | null {
  if (!mapScale) return null;
  return mapScale / 1000 / (vp.pxPerUm * 1000);
}

/** Web Mercator zoom with the same ground resolution as the view at `lat` (`data-zoom` keeps its meaning). */
export function mercatorEquivalentZoom(vp: MapViewport, mapScale: number | null | undefined, lat: number | null): number | null {
  const mpp = metresPerPx(vp, mapScale);
  if (mpp == null || lat == null) return null;
  return Math.log2((EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180)) / (256 * mpp));
}

const EARTH_CIRCUMFERENCE = 40075016.686;

// ─── Rotation and the GL view ────────────────────────────────

/**
 * Clockwise screen rotation of the inner frame, degrees (CSS `rotate`).
 * The base is paper-north-up, so only the meridian tilt
 * (`northOffset − cutRotationDeg`, clockwise from paper +Y) is undone: the
 * drawn meridians stand vertical. The user's two-finger bearing adds on
 * top.
 */
export function viewportRotationDeg(
  northOffset: number | null | undefined,
  cutRotationDeg: number | null | undefined,
  userBearing: number,
): number {
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
