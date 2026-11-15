/**
 * The viewer's 3D mode (docs/map-rendering.md §5.4 "3D mode", H7), the
 * pure part: the offer from the terrain descriptor, the camera of a view,
 * the projector the UI layer is drawn through, and the gesture reducer.
 *
 * Units: a `View3d` is the 2D view (paper µm, y up, CSS px per µm) plus a
 * camera bearing (`View.rotationDeg`, counter-clockwise on screen) and a
 * pitch. Screen points are container CSS px, y down. Model space is the
 * arenas' (paper µm relative to the mesh's origin, z up, §5.6 "Units").
 */

import { cameraFrame, distanceForPxPerUm, projectToScreen, screenRay, type Ray, type TerrainCamera } from "../map-gl/terrain/camera";
import { meshBox, type TerrainMesh } from "../map-gl/terrain/mesh";
import { pickTerrain, surfaceZ } from "../map-gl/terrain/pick";
import type { HeightField } from "@oxygen/shared/src/terrain/field/read.js";
import { TERRAIN_3D_MIN_DECIDED } from "./map-review";
import { PAPER_MAX_PX_PER_MM, PAPER_MIN_PX_PER_MM } from "./map-viewport";

/** Vertical exaggeration: the default and the control's range (§5.4 "3D mode" decision 1). */
export const EXAGGERATION = { default: 2, min: 1, max: 5, step: 0.5 } as const;
export const EXAGGERATION_STORAGE_KEY = "oxygen.map.exaggeration";
/** Pitch on entering 3D and its upper clamp, degrees. */
export const PITCH = { enter: 45, max: 70 } as const;
/** Wheel zoom step, log₂ (2D's). */
export const WHEEL_STEP = 0.15;
/** Two fingers are classified once they have moved this far, CSS px. */
export const GESTURE_SLOP_PX = 8;
/** A twist turns the bearing once the fingers' angle has changed by this much (2D's threshold). */
export const TWIST_ACTIVATE_DEG = 8;

export const clampExaggeration = (e: number): number =>
  Number.isFinite(e) ? Math.min(EXAGGERATION.max, Math.max(EXAGGERATION.min, Math.round(e / EXAGGERATION.step) * EXAGGERATION.step)) : EXAGGERATION.default;
export const clampPitch = (p: number): number => Math.min(PITCH.max, Math.max(0, p));
const MIN_PX_PER_UM = PAPER_MIN_PX_PER_MM / 1000, MAX_PX_PER_UM = PAPER_MAX_PX_PER_MM / 1000;
const clampZoom = (pxPerUm: number): number => Math.min(MAX_PX_PER_UM, Math.max(MIN_PX_PER_UM, pxPerUm));

// ─── The offer ─────────────────────────────────────────────────────────────

/** Why 3D is not drawn: the offer's, or a fallback's; `ground-unavailable`: the DEM's surface could not be had (3D stays on the map's terrain). */
export type Terrain3dReason = "no-contours" | "over-cap" | "low-confidence" | "unavailable" | "webgl" | "ground-unavailable";

/** A DEM provider as the descriptor and a DEM field's header carry it (docs/map-terrain.md §7.1). */
export interface DemProviderLike {
  id: string;
  resolutionM: number;
  grade: "anchor" | "coarse";
  licence: string;
  attribution: string;
}

/** `course.mapMetadata.terrain.dem` (docs/map-storage.md §4.7 "Descriptor"; H10). */
export interface DemDescriptorLike {
  state: "ready" | "pending" | "unavailable" | "failed" | "disabled";
  provider: DemProviderLike | null;
  ground: { url: string } | null;
  anchored: { url: string; decided: number | null } | null;
}

/** `course.mapMetadata.terrain`, the part the gate reads (docs/map-storage.md §4.7 "Descriptor"). */
export interface TerrainDescriptorLike {
  state: "ready" | "none" | "over-cap" | "pending";
  url: string | null;
  decided: number | null;
  /** Absent in a descriptor cached before H10. */
  dem?: DemDescriptorLike | null;
}

export type Terrain3dOffer =
  /** No toggle: not a 3D host (`reason` null), or nothing to draw. */
  | { kind: "hidden"; reason: Terrain3dReason | null }
  /** A toggle that says why it cannot. */
  | { kind: "unavailable"; reason: Terrain3dReason; percent?: number }
  /** A toggle; `url` the field 3D opens on without a choice; `pending`: the field is derived on the first fetch and the gate applied after. */
  | { kind: "available"; url: string; pending: boolean };

/** Floored, as the review's line: 79.6 % does not read as the 80 % the gate needs. */
export const decidedPercent = (decided: number): number => Math.floor(decided * 100);

/** The two surfaces (§5.4 "3D mode" "Surface", H11): the map's terrain and the DEM's ground. */
export type Surface3d = "map" | "ground";

/** The map's terrain: a contour field — the DEM-anchored one where it passes the gate (decision 4). */
export type MapSurface3d =
  | { kind: "none" }
  | { kind: "unavailable"; reason: Terrain3dReason; percent?: number }
  | { kind: "available"; url: string; pending: boolean; anchored: boolean };

export interface Terrain3dSurfaces {
  map: MapSurface3d;
  /** The DEM resampled to the field grid, where its job is done. */
  ground: { url: string; provider: DemProviderLike } | null;
}

export function terrain3dSurfaces(terrain: TerrainDescriptorLike | null | undefined): Terrain3dSurfaces {
  const dem = terrain?.dem;
  const ready = dem?.state === "ready" && !!dem.provider;
  const ground = ready && dem.ground ? { url: dem.ground.url, provider: dem.provider as DemProviderLike } : null;
  return { map: mapSurface(terrain, ready ? dem.anchored : null), ground };
}

function mapSurface(terrain: TerrainDescriptorLike | null | undefined, anchored: DemDescriptorLike["anchored"]): MapSurface3d {
  if (!terrain || terrain.state === "none") return { kind: "none" };
  if (terrain.state === "over-cap") return { kind: "unavailable", reason: "over-cap" };
  if (!terrain.url) return { kind: "none" };
  if (terrain.state === "pending") return { kind: "available", url: terrain.url, pending: true, anchored: false };
  // The gate (answer 7) is read on the field drawn: the anchored one first (decision 4).
  if (anchored && anchored.decided !== null && anchored.decided >= TERRAIN_3D_MIN_DECIDED) return { kind: "available", url: anchored.url, pending: false, anchored: true };
  const decided = terrain.decided ?? 0;
  if (decided < TERRAIN_3D_MIN_DECIDED) return { kind: "unavailable", reason: "low-confidence", percent: decidedPercent(decided) };
  return { kind: "available", url: terrain.url, pending: false, anchored: false };
}

export function terrain3dOffer(terrain: TerrainDescriptorLike | null | undefined, host: { editor: boolean; allow3d: boolean }): Terrain3dOffer {
  if (host.editor || !host.allow3d) return { kind: "hidden", reason: null };
  const { map, ground } = terrain3dSurfaces(terrain);
  if (map.kind === "available") return { kind: "available", url: map.url, pending: map.pending };
  // A ready ground opens 3D on its own below the contour gate (decision 6).
  if (ground) return { kind: "available", url: ground.url, pending: false };
  if (map.kind === "unavailable") return { kind: "unavailable", reason: map.reason, percent: map.percent };
  return { kind: "hidden", reason: "no-contours" };
}

/** The surface 3D opens on without a choice: ground with tracks shown, or when it is the only one (decisions 5, 6). */
export function defaultSurface(s: Terrain3dSurfaces, tracksShown: boolean): Surface3d {
  if (!s.ground) return "map";
  return tracksShown || s.map.kind !== "available" ? "ground" : "map";
}

/** Which surface a field's `source` is: `ground.<provider>`, or a contour field (plain or anchored). */
export const surfaceOfSource = (source: string): Surface3d => (source.startsWith("ground.") ? "ground" : "map");

/** The notice a drawn field must carry: a DEM-based field's provider attribution and licence (answer 16), from its header. */
export function fieldAttribution(header: { source: string; provider?: Pick<DemProviderLike, "attribution" | "licence"> }): { attribution: string; licence: string } | null {
  if (header.source === "contours" || !header.provider) return null;
  return { attribution: header.provider.attribution, licence: header.provider.licence };
}

// ─── View, scene and camera ───────────────────────────────────────────────

export interface View3d {
  /** Paper µm, y up. */
  centreX: number;
  centreY: number;
  /** CSS px per paper µm at the target (the 2D zoom). */
  pxPerUm: number;
  /** The GL view's `rotationDeg`: counter-clockwise on screen. */
  bearingDeg: number;
  pitchDeg: number;
}

/** What the camera needs besides the view. */
export interface Scene3d {
  /** Container, CSS px. */
  widthCss: number;
  heightCss: number;
  dpr: number;
  /** The model space's paper µm origin (the mesh's). */
  originUm: { x: number; y: number };
  /** The target's model z (`targetZOf`). */
  targetZ: number;
  exaggeration: number;
  /** For the pick; without them the ground is the target's plane. */
  mesh?: TerrainMesh | null;
  field?: HeightField | null;
}

/** The target's model z: the mesh box's mid-height at the exaggeration (constant while both are). */
export function targetZOf(mesh: TerrainMesh | null | undefined, exaggeration: number): number {
  if (!mesh) return 0;
  const b = meshBox(mesh, exaggeration);
  return (b.minZ + b.maxZ) / 2;
}

/** The canvas's device size, as `glView` rounds it. */
export function deviceSize(s: Pick<Scene3d, "widthCss" | "heightCss" | "dpr">): { widthPx: number; heightPx: number } {
  return { widthPx: Math.max(1, Math.round(s.widthCss * s.dpr)), heightPx: Math.max(1, Math.round(s.heightCss * s.dpr)) };
}

/** The view's camera, device px. At pitch 0 it draws the target's plane as the 2D view does (§5.6 "Camera"). */
export function camera3d(v: View3d, s: Scene3d): TerrainCamera {
  const { widthPx, heightPx } = deviceSize(s);
  const cam: TerrainCamera = {
    target: { x: v.centreX - s.originUm.x, y: v.centreY - s.originUm.y, z: s.targetZ },
    distanceUm: 0,
    bearingDeg: v.bearingDeg,
    pitchDeg: clampPitch(v.pitchDeg),
    widthPx,
    heightPx,
  };
  cam.distanceUm = distanceForPxPerUm(cam, v.pxPerUm * s.dpr);
  return cam;
}

/** CSS px → device px factors of the scene. */
function ratios(s: Scene3d): { kx: number; ky: number } {
  const { widthPx, heightPx } = deviceSize(s);
  return { kx: widthPx / Math.max(1e-9, s.widthCss), ky: heightPx / Math.max(1e-9, s.heightCss) };
}

/** Where the ray meets the horizontal plane at model z, model (x, y); null when it does not (ahead). */
export function rayPlane(ray: Ray, z: number): { x: number; y: number } | null {
  const dz = ray.dir[2];
  if (Math.abs(dz) < 1e-12) return null;
  const t = (z - ray.origin[2]) / dz;
  if (!(t > 0)) return null;
  return { x: ray.origin[0] + ray.dir[0] * t, y: ray.origin[1] + ray.dir[1] * t };
}

/** A ground point: paper µm (absolute) in plan and model z. */
export interface Ground {
  x: number;
  y: number;
  z: number;
}

/** The ground under a screen point: the surface's pick, else the target's plane; null when the ray meets neither. */
export function groundAt(v: View3d, s: Scene3d, cssX: number, cssY: number): Ground | null {
  const cam = camera3d(v, s);
  const { kx, ky } = ratios(s);
  const ray = screenRay(cam, cssX * kx, cssY * ky);
  if (s.mesh && s.field) {
    const hit = pickTerrain(s.mesh, s.field, ray, s.exaggeration);
    if (hit) return { x: hit.model[0] + s.originUm.x, y: hit.model[1] + s.originUm.y, z: hit.model[2] };
  }
  const p = rayPlane(ray, s.targetZ);
  return p ? { x: p.x + s.originUm.x, y: p.y + s.originUm.y, z: s.targetZ } : null;
}

/**
 * The view moved in plan so that `grab` lies under (cssX, cssY): the ray there meets the horizontal
 * plane at the grab's height at Q, and the camera moves by grab − Q — exact, since the camera moves
 * in plan only. Unchanged when the ray does not meet that plane.
 */
export function panTo(v: View3d, s: Scene3d, grab: Ground, cssX: number, cssY: number): View3d {
  const cam = camera3d(v, s);
  const { kx, ky } = ratios(s);
  const q = rayPlane(screenRay(cam, cssX * kx, cssY * ky), grab.z);
  if (!q) return v;
  return { ...v, centreX: v.centreX + grab.x - (q.x + s.originUm.x), centreY: v.centreY + grab.y - (q.y + s.originUm.y) };
}

/** Zoom by `dLog2` keeping `anchor` under (cssX, cssY), within the 2D zoom limits. */
export function zoomAt3d(v: View3d, s: Scene3d, anchor: Ground, cssX: number, cssY: number, dLog2: number): View3d {
  return panTo({ ...v, pxPerUm: clampZoom(v.pxPerUm * Math.pow(2, dLog2)) }, s, anchor, cssX, cssY);
}

/** Orbit by a drag: 180° of bearing per container width, 90° of pitch per container height (up tilts). */
export function orbitBy(v: View3d, s: Pick<Scene3d, "widthCss" | "heightCss">, dxCss: number, dyCss: number): View3d {
  return {
    ...v,
    bearingDeg: normaliseDeg(v.bearingDeg + (dxCss * 180) / Math.max(1, s.widthCss)),
    pitchDeg: clampPitch(v.pitchDeg - (dyCss * 90) / Math.max(1, s.heightCss)),
  };
}

export const normaliseDeg = (d: number): number => {
  const r = ((d % 360) + 540) % 360 - 180;
  return r === -180 ? 180 : r;
};

// ─── Projector (the UI layer, §5.4 "3D mode") ─────────────────────────────

/** The SVG `matrix(a b c d e f)` coefficients of a 2 × 2 map: x' = a·x + c·y, y' = b·x + d·y. */
export type Affine2 = [a: number, b: number, c: number, d: number];

export interface Projector3d {
  /** Container CSS px of the surface point at paper (xMm, yMm); null behind the eye. */
  project(xMm: number, yMm: number): { x: number; y: number } | null;
  /** The paper mm under a screen point (pick, else the target's plane); null above the horizon. */
  unproject(cssX: number, cssY: number): { x: number; y: number } | null;
  /**
   * The ground's local map at the anchor over the centre's scale: screen px drawn around the anchor
   * as if in 2D (y down, `pxPerMm` px per mm) → screen px on the ground. A rotation at pitch 0.
   */
  affine(xMm: number, yMm: number): Affine2 | null;
  /** CSS px per paper mm at the target (the 2D scale). */
  pxPerMm: number;
}

export function projector3d(v: View3d, s: Scene3d): Projector3d {
  const cam = camera3d(v, s);
  const m = cameraFrame(cam).matrix;
  const { kx, ky } = ratios(s);
  const pxPerMm = v.pxPerUm * 1000;
  const heightAt = (x: number, y: number): number => (s.mesh ? surfaceZ(s.mesh, x, y, s.exaggeration) : null) ?? s.targetZ;
  const at = (xMm: number, yMm: number, z?: number): { x: number; y: number } | null => {
    const x = xMm * 1000 - s.originUm.x, y = yMm * 1000 - s.originUm.y;
    const p = projectToScreen(m, cam.widthPx, cam.heightPx, x, y, z ?? heightAt(x, y));
    return p ? { x: p[0] / kx, y: p[1] / ky } : null;
  };
  return {
    pxPerMm,
    project: (xMm, yMm) => at(xMm, yMm),
    unproject: (cssX, cssY) => {
      const g = groundAt(v, s, cssX, cssY);
      return g ? { x: g.x / 1000, y: g.y / 1000 } : null;
    },
    affine: (xMm, yMm) => {
      // The horizontal plane through the anchor's surface point, differentiated over one screen px.
      const z = heightAt(xMm * 1000 - s.originUm.x, yMm * 1000 - s.originUm.y);
      const step = 1 / Math.max(pxPerMm, 1e-9); // one screen px of paper at the target
      const o = at(xMm, yMm, z), px = at(xMm + step, yMm, z), py = at(xMm, yMm + step, z);
      if (!o || !px || !py) return null;
      // J's columns (px per mm along +x and +y paper) composed with 2D's screen → mm (1/σ, y flipped).
      const jx = [(px.x - o.x) / step, (px.y - o.y) / step], jy = [(py.x - o.x) / step, (py.y - o.y) / step];
      return [jx[0] / pxPerMm, jx[1] / pxPerMm, -jy[0] / pxPerMm, -jy[1] / pxPerMm];
    },
  };
}

/** The SVG transform that applies `a` about the screen point `p`; undefined for none. */
export function affineAbout(a: Affine2 | null | undefined, p: { x: number; y: number }): string | undefined {
  if (!a) return undefined;
  const [A, B, C, D] = a;
  const e = p.x - A * p.x - C * p.y, f = p.y - B * p.x - D * p.y;
  return `matrix(${A.toFixed(5)} ${B.toFixed(5)} ${C.toFixed(5)} ${D.toFixed(5)} ${e.toFixed(2)} ${f.toFixed(2)})`;
}

/** The linear scale of an affine (√|det|): an upright marker's size at its anchor. */
export const affineScale = (a: Affine2 | null | undefined): number => (a ? Math.sqrt(Math.abs(a[0] * a[3] - a[1] * a[2])) : 1);

// ─── Gestures (§5.4 "3D mode" "Gestures") ─────────────────────────────────

export interface ScreenPt {
  x: number;
  y: number;
}

export type TwoFingerKind = "tilt" | "pinch";

/**
 * Two fingers from (a0, b0) to (a1, b1): `tilt` when both moved vertically the same way by at least
 * the slop with their distance and angle steady; `pinch` (zoom, pan, twist) once the distance, the
 * angle or the midpoint has changed beyond it; null while still inside the slop.
 */
export function classifyTwoFinger(a0: ScreenPt, b0: ScreenPt, a1: ScreenPt, b1: ScreenPt): TwoFingerKind | null {
  const dyA = a1.y - a0.y, dyB = b1.y - b0.y, dxA = a1.x - a0.x, dxB = b1.x - b0.x;
  const dDist = Math.abs(dist(a1, b1) - dist(a0, b0));
  const dAng = Math.abs(normaliseDeg(angleDeg(a1, b1) - angleDeg(a0, b0)));
  const verticalTogether =
    Math.sign(dyA) === Math.sign(dyB) && Math.min(Math.abs(dyA), Math.abs(dyB)) >= GESTURE_SLOP_PX && Math.abs(dxA) < Math.abs(dyA) && Math.abs(dxB) < Math.abs(dyB);
  if (verticalTogether && dDist < GESTURE_SLOP_PX && dAng < TWIST_ACTIVATE_DEG) return "tilt";
  const mid = dist(midpoint(a0, b0), midpoint(a1, b1));
  if (dDist >= GESTURE_SLOP_PX || dAng >= TWIST_ACTIVATE_DEG || mid >= 2 * GESTURE_SLOP_PX) return "pinch";
  return null;
}

const dist = (a: ScreenPt, b: ScreenPt) => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a: ScreenPt, b: ScreenPt): ScreenPt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
/** Screen angle of a → b, degrees (y down: clockwise positive). */
const angleDeg = (a: ScreenPt, b: ScreenPt) => (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;

export type Gesture3dEvent =
  /** `orbit`: a right-button or ctrl / ⌘ drag; `pan`: whether one pointer alone pans (2D's one-finger rule). */
  | { type: "down"; id: number; x: number; y: number; orbit?: boolean; pan?: boolean }
  | { type: "move"; id: number; x: number; y: number }
  | { type: "up"; id: number }
  | { type: "wheel"; x: number; y: number; deltaY: number };

type Mode =
  | null
  | { kind: "pan"; id: number; grab: Ground }
  | { kind: "orbit"; id: number; last: ScreenPt }
  | {
      kind: "two";
      ids: [number, number];
      a0: ScreenPt;
      b0: ScreenPt;
      base: View3d;
      grab: Ground | null;
      class: TwoFingerKind | null;
      /** The angle the twist started from, once active. */
      twistFrom: number | null;
    };

export interface Gesture3dState {
  pointers: ReadonlyArray<{ id: number; x: number; y: number; pan: boolean }>;
  mode: Mode;
}

export const GESTURE_IDLE: Gesture3dState = { pointers: [], mode: null };

export interface Gesture3dResult {
  view: View3d;
  state: Gesture3dState;
  /** Whether the view changed (a gesture breaks GPS follow). */
  changed: boolean;
}

/** One pointer, touch or wheel event → the next view and gesture state. Pure. */
export function reduceGesture3d(view: View3d, state: Gesture3dState, ev: Gesture3dEvent, s: Scene3d): Gesture3dResult {
  const same = (st: Gesture3dState): Gesture3dResult => ({ view, state: st, changed: false });
  switch (ev.type) {
    case "wheel": {
      const anchor = groundAt(view, s, ev.x, ev.y);
      if (!anchor || ev.deltaY === 0) return same(state);
      return { view: zoomAt3d(view, s, anchor, ev.x, ev.y, ev.deltaY > 0 ? -WHEEL_STEP : WHEEL_STEP), state, changed: true };
    }
    case "down": {
      const pointers = [...state.pointers.filter((p) => p.id !== ev.id), { id: ev.id, x: ev.x, y: ev.y, pan: ev.pan !== false }];
      if (pointers.length === 2) return same({ pointers, mode: twoFingers(view, s, pointers) });
      if (pointers.length > 2) return same({ pointers, mode: null });
      if (ev.orbit) return same({ pointers, mode: { kind: "orbit", id: ev.id, last: { x: ev.x, y: ev.y } } });
      return same({ pointers, mode: ev.pan === false ? null : grabMode(view, s, ev.id, ev.x, ev.y) });
    }
    case "up": {
      const pointers = state.pointers.filter((p) => p.id !== ev.id);
      if (pointers.length === state.pointers.length) return same(state);
      // Two → one: the remaining finger pans on from where it is (if it may).
      const rest = pointers.length === 1 && state.mode?.kind === "two" && pointers[0].pan ? grabMode(view, s, pointers[0].id, pointers[0].x, pointers[0].y) : null;
      return same({ pointers, mode: pointers.length === 0 ? null : rest ?? (state.mode?.kind === "two" ? null : state.mode) });
    }
    case "move": {
      const i = state.pointers.findIndex((p) => p.id === ev.id);
      if (i < 0) return same(state);
      const pointers = state.pointers.map((p) => (p.id === ev.id ? { ...p, x: ev.x, y: ev.y } : p));
      const m = state.mode;
      if (!m) return same({ pointers, mode: m });
      if (m.kind === "pan") {
        if (m.id !== ev.id) return same({ pointers, mode: m });
        return { view: panTo(view, s, m.grab, ev.x, ev.y), state: { pointers, mode: m }, changed: true };
      }
      if (m.kind === "orbit") {
        if (m.id !== ev.id) return same({ pointers, mode: m });
        const next = orbitBy(view, s, ev.x - m.last.x, ev.y - m.last.y);
        return { view: next, state: { pointers, mode: { ...m, last: { x: ev.x, y: ev.y } } }, changed: true };
      }
      const a1 = pointers.find((p) => p.id === m.ids[0]), b1 = pointers.find((p) => p.id === m.ids[1]);
      if (!a1 || !b1) return same({ pointers, mode: m });
      const kind = m.class ?? classifyTwoFinger(m.a0, m.b0, a1, b1);
      if (!kind) return same({ pointers, mode: m });
      if (kind === "tilt") {
        const dy = midpoint(a1, b1).y - midpoint(m.a0, m.b0).y;
        const next = { ...m.base, pitchDeg: clampPitch(m.base.pitchDeg - (dy * 90) / Math.max(1, s.heightCss)) };
        return { view: next, state: { pointers, mode: { ...m, class: kind } }, changed: true };
      }
      // pinch: zoom from the start, twist once past the threshold, the grabbed midpoint under the midpoint
      const dAng = normaliseDeg(angleDeg(a1, b1) - angleDeg(m.a0, m.b0));
      const twistFrom = m.twistFrom ?? (Math.abs(dAng) >= TWIST_ACTIVATE_DEG ? dAng : null);
      const d0 = dist(m.a0, m.b0), d1 = dist(a1, b1);
      let next: View3d = {
        ...m.base,
        pxPerUm: d0 > 0 && d1 > 0 ? clampZoom(m.base.pxPerUm * (d1 / d0)) : m.base.pxPerUm,
        // fingers turning clockwise turn the content clockwise: the counter-clockwise bearing decreases
        bearingDeg: twistFrom === null ? m.base.bearingDeg : normaliseDeg(m.base.bearingDeg - (dAng - twistFrom)),
      };
      const mid = midpoint(a1, b1);
      if (m.grab) next = panTo(next, s, m.grab, mid.x, mid.y);
      return { view: next, state: { pointers, mode: { ...m, class: kind, twistFrom } }, changed: true };
    }
  }
}

function grabMode(view: View3d, s: Scene3d, id: number, x: number, y: number): Mode {
  const grab = groundAt(view, s, x, y);
  return grab ? { kind: "pan", id, grab } : null;
}

function twoFingers(view: View3d, s: Scene3d, pointers: Gesture3dState["pointers"]): Mode {
  const [a, b] = pointers;
  const mid = midpoint(a, b);
  return { kind: "two", ids: [a.id, b.id], a0: { x: a.x, y: a.y }, b0: { x: b.x, y: b.y }, base: view, grab: groundAt(view, s, mid.x, mid.y), class: null, twistFrom: null };
}

// ─── The 2D state ↔ View3d ────────────────────────────────────────────────

/**
 * The camera bearing of the 2D rotation: the GL view's `rotationDeg` is −the inner frame's
 * clockwise CSS angle (`viewportRotationDeg`), which is `userBearing − tilt`.
 */
export const bearingOfRotation = (rotDeg: number): number => (rotDeg === 0 ? 0 : -rotDeg);
/** The user bearing that gives a camera bearing, with `baseRotDeg` = `viewportRotationDeg(…, 0)`. */
export const userBearingOf = (bearingDeg: number, baseRotDeg: number): number => normaliseDeg(-bearingDeg - baseRotDeg);
