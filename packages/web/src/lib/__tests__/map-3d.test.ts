import { describe, expect, it } from "vitest";
import {
  EXAGGERATION,
  GESTURE_IDLE,
  PITCH,
  affineAbout,
  affineScale,
  bearingOfRotation,
  camera3d,
  clampExaggeration,
  classifyTwoFinger,
  groundAt,
  orbitBy,
  panTo,
  projector3d,
  reduceGesture3d,
  targetZOf,
  defaultSurface,
  fieldAttribution,
  surfaceOfSource,
  terrain3dOffer,
  terrain3dSurfaces,
  userBearingOf,
  zoomAt3d,
  type Gesture3dEvent,
  type Gesture3dState,
  type Scene3d,
  type View3d,
} from "../map-3d";
import { glView, mmToInner, viewportRotationDeg } from "../map-viewport";
import { rotatedBoundingBox } from "../map-rotation";
import { viewMatrix } from "../../map-gl/view";
import { cameraFrame } from "../../map-gl/terrain/camera";
import { transform } from "../../map-gl/terrain/mat4";
import { buildTerrainMesh } from "../../map-gl/terrain/mesh";
import { coneCentreMm, coneField, seededRandom } from "../../map-gl/terrain/synthetic";

const ORIGIN = { x: 40_000, y: 30_000 };
const flat = (over: Partial<Scene3d> = {}): Scene3d => ({ widthCss: 800, heightCss: 600, dpr: 1, originUm: ORIGIN, targetZ: 0, exaggeration: 2, ...over });
const view = (over: Partial<View3d> = {}): View3d => ({ centreX: 42_000, centreY: 31_000, pxPerUm: 0.01, bearingDeg: 0, pitchDeg: 0, ...over });

describe("terrain3dOffer (map-rendering.md §5.4 \"3D mode\", answer 7)", () => {
  const host = { editor: false, allow3d: true };
  const url = "/api/map-documents/abc/height.bin?v=1";
  it("follows the descriptor table", () => {
    expect(terrain3dOffer(null, host)).toEqual({ kind: "hidden", reason: "no-contours" });
    expect(terrain3dOffer({ state: "none", url: null, decided: null }, host)).toEqual({ kind: "hidden", reason: "no-contours" });
    expect(terrain3dOffer({ state: "over-cap", url: null, decided: null }, host)).toEqual({ kind: "unavailable", reason: "over-cap" });
    expect(terrain3dOffer({ state: "pending", url, decided: null }, host)).toEqual({ kind: "available", url, pending: true });
    expect(terrain3dOffer({ state: "ready", url, decided: 0.8 }, host)).toEqual({ kind: "available", url, pending: false });
    // floored, unrounded gate: 79.6 % is below
    expect(terrain3dOffer({ state: "ready", url, decided: 0.7996 }, host)).toEqual({ kind: "unavailable", reason: "low-confidence", percent: 79 });
  });
  it("is hidden in the editor and the kiosk", () => {
    const d = { state: "ready" as const, url, decided: 0.95 };
    expect(terrain3dOffer(d, { editor: true, allow3d: true })).toEqual({ kind: "hidden", reason: null });
    expect(terrain3dOffer(d, { editor: false, allow3d: false })).toEqual({ kind: "hidden", reason: null });
  });
});

describe("terrain3dSurfaces — choosing the surface (§5.4 \"3D mode\" decisions 4–6, H11)", () => {
  const url = "/api/map-documents/abc/height.bin?v=1";
  const groundUrl = `${url}&source=ground.lantmateriet-2m`;
  const anchoredUrl = `${url}&source=contours.lantmateriet-2m`;
  const provider = { id: "lantmateriet-2m", resolutionM: 2, grade: "anchor" as const, licence: "CC BY 4.0", attribution: "© Lantmäteriet", verticalDatum: "RH 2000" };
  const dem = (over: Record<string, unknown> = {}) => ({ state: "ready" as const, reason: null, provider, ground: { url: groundUrl }, anchored: { url: anchoredUrl, decided: 0.9 }, ...over });
  const host = { editor: false, allow3d: true };

  it("has no ground without a ready DEM, and is H7's offer then", () => {
    for (const state of ["pending", "unavailable", "failed", "disabled"] as const) {
      const t = { state: "ready" as const, url, decided: 0.85, dem: dem({ state, anchored: null, ground: state === "pending" ? { url: groundUrl } : null }) };
      const s = terrain3dSurfaces(t);
      expect(s.ground).toBeNull();
      expect(s.map).toEqual({ kind: "available", url, pending: false, anchored: false });
      expect(terrain3dOffer(t, host)).toEqual({ kind: "available", url, pending: false });
    }
    expect(terrain3dSurfaces({ state: "ready", url, decided: 0.85 }).ground).toBeNull();
    expect(terrain3dSurfaces({ state: "ready", url, decided: 0.85, dem: null }).ground).toBeNull();
  });

  it("offers ground when the DEM is ready", () => {
    const s = terrain3dSurfaces({ state: "ready", url, decided: 0.85, dem: dem() });
    expect(s.ground).toEqual({ url: groundUrl, provider });
  });

  it("draws the anchored field as the map's terrain when it passes the gate (decision 4)", () => {
    expect(terrain3dSurfaces({ state: "ready", url, decided: 0.6, dem: dem() }).map).toEqual({ kind: "available", url: anchoredUrl, pending: false, anchored: true });
    // the anchored field below the gate: the plain one, when it passes
    expect(terrain3dSurfaces({ state: "ready", url, decided: 0.85, dem: dem({ anchored: { url: anchoredUrl, decided: 0.79 } }) }).map).toEqual({ kind: "available", url, pending: false, anchored: false });
    // no decided share recorded for the anchored field: the plain one
    expect(terrain3dSurfaces({ state: "ready", url, decided: 0.85, dem: dem({ anchored: { url: anchoredUrl, decided: null } }) }).map).toEqual({ kind: "available", url, pending: false, anchored: false });
    // both below: the plain field's percent
    expect(terrain3dSurfaces({ state: "ready", url, decided: 0.5, dem: dem({ anchored: { url: anchoredUrl, decided: 0.7 } }) }).map).toEqual({ kind: "unavailable", reason: "low-confidence", percent: 50 });
  });

  it("opens 3D on ground below the contour gate (decision 6)", () => {
    const t = { state: "ready" as const, url, decided: 0.5, dem: dem({ anchored: { url: anchoredUrl, decided: 0.6 } }) };
    expect(terrain3dSurfaces(t).map).toMatchObject({ kind: "unavailable", reason: "low-confidence" });
    expect(terrain3dOffer(t, host)).toEqual({ kind: "available", url: groundUrl, pending: false });
    // without ground the gate holds (H7)
    expect(terrain3dOffer({ state: "ready", url, decided: 0.5 }, host)).toEqual({ kind: "unavailable", reason: "low-confidence", percent: 50 });
    // never on a host without 3D
    expect(terrain3dOffer(t, { editor: false, allow3d: false })).toEqual({ kind: "hidden", reason: null });
  });

  it("keeps the plain field pending as H7 did", () => {
    expect(terrain3dSurfaces({ state: "pending", url, decided: null, dem: dem({ state: "disabled", ground: null, anchored: null, provider: null }) }).map).toEqual({ kind: "available", url, pending: true, anchored: false });
    expect(terrain3dSurfaces({ state: "none", url: null, decided: null }).map).toEqual({ kind: "none" });
    expect(terrain3dSurfaces({ state: "over-cap", url: null, decided: null }).map).toEqual({ kind: "unavailable", reason: "over-cap" });
  });

  it("defaults to ground when tracks are shown (decision 5)", () => {
    const both = terrain3dSurfaces({ state: "ready", url, decided: 0.85, dem: dem() });
    expect(defaultSurface(both, false)).toBe("map");
    expect(defaultSurface(both, true)).toBe("ground");
    const mapOnly = terrain3dSurfaces({ state: "ready", url, decided: 0.85 });
    expect(defaultSurface(mapOnly, true)).toBe("map");
    const groundOnly = terrain3dSurfaces({ state: "ready", url, decided: 0.3, dem: dem({ anchored: null }) });
    expect(defaultSurface(groundOnly, false)).toBe("ground");
  });

  it("names the drawn surface and its attribution from the field's header (answer 16)", () => {
    expect(surfaceOfSource("contours")).toBe("map");
    expect(surfaceOfSource("contours.lantmateriet-2m")).toBe("map");
    expect(surfaceOfSource("ground.glo30-30m")).toBe("ground");
    expect(fieldAttribution({ source: "contours" })).toBeNull();
    expect(fieldAttribution({ source: "contours.lantmateriet-2m", provider })).toEqual({ attribution: "© Lantmäteriet", licence: "CC BY 4.0" });
    expect(fieldAttribution({ source: "ground.lantmateriet-2m", provider })).toEqual({ attribution: "© Lantmäteriet", licence: "CC BY 4.0" });
  });
});

describe("exaggeration (decision 1)", () => {
  it("defaults to 2, clamps to 1–5 in 0.5 steps", () => {
    expect(EXAGGERATION.default).toBe(2);
    expect(clampExaggeration(0)).toBe(1);
    expect(clampExaggeration(9)).toBe(5);
    expect(clampExaggeration(2.3)).toBe(2.5);
    expect(clampExaggeration(Number.NaN)).toBe(2);
  });
});

describe("camera3d — the 2D ↔ 3D hand-over", () => {
  it("equals viewMatrix at pitch 0 on the target's plane, any bearing and DPR", () => {
    const rnd = seededRandom(3);
    for (let k = 0; k < 50; k++) {
      const dpr = [1, 1.5, 2, 3][k % 4];
      const rotDeg = (rnd() - 0.5) * 360;
      const vp = { centreX: 30_000 + rnd() * 30_000, centreY: 20_000 + rnd() * 20_000, pxPerUm: 0.002 + rnd() * 0.05 };
      const gv = glView(vp, 640, 480, dpr, rotDeg);
      const v: View3d = { ...vp, bearingDeg: bearingOfRotation(rotDeg), pitchDeg: 0 };
      const s = flat({ widthCss: 640, heightCss: 480, dpr, targetZ: 1234 });
      const m3 = cameraFrame(camera3d(v, s)).matrix;
      const m2 = viewMatrix(gv, ORIGIN.x, ORIGIN.y);
      for (let p = 0; p < 5; p++) {
        const x = (rnd() - 0.5) * 40_000 + vp.centreX - ORIGIN.x, y = (rnd() - 0.5) * 40_000 + vp.centreY - ORIGIN.y;
        const a = transform(m3, x, y, 1234), b = transform(m2, x, y, 0);
        expect(a[0] / a[3]).toBeCloseTo(b[0] / b[3], 5);
        expect(a[1] / a[3]).toBeCloseTo(b[1] / b[3], 5);
      }
    }
  });

  it("puts the target at the mesh box's mid-height", () => {
    const mesh = buildTerrainMesh(coneField(), ORIGIN);
    const z = targetZOf(mesh, 2);
    expect(z).toBeCloseTo(((mesh.zMax - mesh.zMin) * mesh.unitUm * 2) / 2, 6);
    expect(targetZOf(null, 2)).toBe(0);
  });
});

describe("projector3d (the UI layer)", () => {
  it("at pitch 0 on flat ground equals mmToInner + the CSS rotation (< 0.5 px)", () => {
    const rnd = seededRandom(11);
    for (let k = 0; k < 200; k++) {
      const dpr = [1, 1.25, 2, 3][k % 4];
      const w = 300 + Math.round(rnd() * 700), h = 200 + Math.round(rnd() * 600);
      const rotDeg = (rnd() - 0.5) * 360;
      const vp = { centreX: 30_000 + rnd() * 30_000, centreY: 20_000 + rnd() * 20_000, pxPerUm: 0.002 + rnd() * 0.05 };
      const proj = projector3d({ ...vp, bearingDeg: bearingOfRotation(rotDeg), pitchDeg: 0 }, flat({ widthCss: w, heightCss: h, dpr }));
      const { width: rw, height: rh } = rotatedBoundingBox(w, h, rotDeg);
      const xMm = vp.centreX / 1000 + (rnd() - 0.5) * (w / vp.pxPerUm / 1000), yMm = vp.centreY / 1000 + (rnd() - 0.5) * (h / vp.pxPerUm / 1000);
      const inner = mmToInner(vp, { w: rw, h: rh, frame: null }, xMm, yMm);
      const r = (rotDeg * Math.PI) / 180, dx = inner.x - rw / 2, dy = inner.y - rh / 2;
      const want = { x: dx * Math.cos(r) - dy * Math.sin(r) + w / 2, y: dx * Math.sin(r) + dy * Math.cos(r) + h / 2 };
      const got = proj.project(xMm, yMm)!;
      expect(Math.hypot(got.x - want.x, got.y - want.y)).toBeLessThan(0.5);
    }
  });

  it("tilted over a cone: project → unproject returns within a cell", () => {
    const field = coneField();
    const mesh = buildTerrainMesh(field, ORIGIN);
    const s = flat({ mesh, field, targetZ: targetZOf(mesh, 2) });
    const c = coneCentreMm();
    const rnd = seededRandom(5);
    for (const pitchDeg of [20, 45, 60]) {
      const v = view({ centreX: c.x * 1000, centreY: c.y * 1000, pxPerUm: 0.02, pitchDeg, bearingDeg: 30 });
      const p = projector3d(v, s);
      for (let k = 0; k < 20; k++) {
        const x = c.x + (rnd() - 0.5) * 10, y = c.y + (rnd() - 0.5) * 10;
        const sp = p.project(x, y)!;
        const back = p.unproject(sp.x, sp.y)!;
        // a surface point hidden behind the cone picks the nearer slope: only visible ones (a
        // point at the silhouette's grazing edge comes back within a cell, the rest within a fifth)
        if (Math.hypot(back.x - x, back.y - y) > 1) continue;
        expect(Math.hypot(back.x - x, back.y - y)).toBeLessThan(0.2);
      }
    }
  });

  it("the ground affine is a rotation at pitch 0 and foreshortens along the view when tilted", () => {
    const a0 = projector3d(view({ bearingDeg: 30 }), flat()).affine(42, 31)!;
    expect(a0[0] * a0[3] - a0[1] * a0[2]).toBeCloseTo(1, 4);
    expect(Math.hypot(a0[0], a0[1])).toBeCloseTo(1, 4);
    expect(a0[0] * a0[2] + a0[1] * a0[3]).toBeCloseTo(0, 4);
    // tilted, north up: screen-up (the view direction) shrinks by ≈ cos(pitch) at the target, across stays
    const a = projector3d(view({ pitchDeg: 60 }), flat()).affine(42, 31)!;
    expect(Math.hypot(a[0], a[1])).toBeCloseTo(1, 2);
    expect(Math.hypot(a[2], a[3])).toBeCloseTo(Math.cos(Math.PI / 3), 2);
    expect(affineScale(a)).toBeCloseTo(Math.sqrt(0.5), 2);
    expect(affineAbout(null, { x: 0, y: 0 })).toBeUndefined();
    // the transform keeps its anchor
    const t = affineAbout(a, { x: 100, y: 50 })!.match(/-?[\d.]+/g)!.map(Number);
    expect(t[0] * 100 + t[2] * 50 + t[4]).toBeCloseTo(100, 1);
    expect(t[1] * 100 + t[3] * 50 + t[5]).toBeCloseTo(50, 1);
  });

  it("returns null behind the eye", () => {
    const p = projector3d(view({ pitchDeg: 70, pxPerUm: 0.05 }), flat());
    // far behind the camera, opposite the view direction (north up: the view looks north)
    expect(p.project(42, 31 - 2000)).toBeNull();
  });
});

describe("pan and zoom keep the ground point under the pointer", () => {
  const cases: Array<[string, Partial<View3d>]> = [["pitch 0", {}], ["tilted", { pitchDeg: 50, bearingDeg: -40 }]];
  for (const [name, over] of cases)
    it(name, () => {
      const s = flat({ targetZ: 500 });
      let v = view(over);
      const grab = groundAt(v, s, 300, 400)!;
      v = panTo(v, s, grab, 420, 350);
      const p = projector3d(v, s).project(grab.x / 1000, grab.y / 1000)!;
      expect(Math.hypot(p.x - 420, p.y - 350)).toBeLessThan(0.5);
      const anchor = groundAt(v, s, 200, 450)!;
      const z = zoomAt3d(v, s, anchor, 200, 450, 0.15);
      expect(z.pxPerUm).toBeCloseTo(v.pxPerUm * Math.pow(2, 0.15), 10);
      const q = projector3d(z, s).project(anchor.x / 1000, anchor.y / 1000)!;
      expect(Math.hypot(q.x - 200, q.y - 450)).toBeLessThan(0.5);
    });

  it("zoom stays within the 2D limits", () => {
    const s = flat();
    const v = view({ pxPerUm: 0.0999 });
    expect(zoomAt3d(v, s, groundAt(v, s, 400, 300)!, 400, 300, 3).pxPerUm).toBe(0.1);
  });
});

describe("orbit", () => {
  it("turns 180° per width and tilts 90° per height, clamped to [0, 70]", () => {
    const s = flat();
    const v = orbitBy(view({ pitchDeg: 30 }), s, 400, -150);
    expect(v.bearingDeg).toBeCloseTo(90, 9);
    expect(v.pitchDeg).toBeCloseTo(52.5, 9);
    expect(orbitBy(view(), s, 0, -2000).pitchDeg).toBe(PITCH.max);
    expect(orbitBy(view({ pitchDeg: 10 }), s, 0, 2000).pitchDeg).toBe(0);
  });
});

describe("classifyTwoFinger", () => {
  const a0 = { x: 300, y: 300 }, b0 = { x: 500, y: 300 };
  it("tilt: both fingers vertical, the same way, distance and angle steady", () => {
    expect(classifyTwoFinger(a0, b0, { x: 301, y: 290 }, { x: 501, y: 289 })).toBe("tilt");
  });
  it("pinch: the distance, the angle or the midpoint changed", () => {
    expect(classifyTwoFinger(a0, b0, { x: 290, y: 300 }, { x: 510, y: 300 })).toBe("pinch");
    expect(classifyTwoFinger(a0, b0, { x: 300, y: 315 }, { x: 500, y: 285 })).toBe("pinch");
    expect(classifyTwoFinger(a0, b0, { x: 320, y: 300 }, { x: 520, y: 300 })).toBe("pinch");
  });
  it("null inside the slop", () => {
    expect(classifyTwoFinger(a0, b0, { x: 302, y: 303 }, { x: 501, y: 304 })).toBeNull();
  });
});

describe("reduceGesture3d", () => {
  const s = flat();
  const run = (v: View3d, events: Gesture3dEvent[]) => {
    let st: Gesture3dState = GESTURE_IDLE, cur = v, changed = false;
    for (const e of events) {
      const r = reduceGesture3d(cur, st, e, s);
      cur = r.view;
      st = r.state;
      changed ||= r.changed;
    }
    return { view: cur, state: st, changed };
  };

  it("one pointer pans; `pan: false` (a page-scrolling finger) does not", () => {
    const v = view({ pitchDeg: 30 });
    const r = run(v, [{ type: "down", id: 1, x: 400, y: 300 }, { type: "move", id: 1, x: 450, y: 320 }, { type: "up", id: 1 }]);
    expect(r.changed).toBe(true);
    expect(r.state).toEqual(GESTURE_IDLE);
    const g = groundAt(v, s, 400, 300)!;
    const p = projector3d(r.view, s).project(g.x / 1000, g.y / 1000)!;
    expect(Math.hypot(p.x - 450, p.y - 320)).toBeLessThan(0.5);
    expect(run(v, [{ type: "down", id: 1, x: 400, y: 300, pan: false }, { type: "move", id: 1, x: 450, y: 320 }]).changed).toBe(false);
  });

  it("an orbit drag turns and tilts", () => {
    const r = run(view(), [{ type: "down", id: 1, x: 400, y: 300, orbit: true }, { type: "move", id: 1, x: 500, y: 200 }]);
    expect(r.view.bearingDeg).toBeCloseTo(22.5, 9);
    expect(r.view.pitchDeg).toBeCloseTo(15, 9);
  });

  it("the wheel zooms about the cursor", () => {
    const r = run(view(), [{ type: "wheel", x: 100, y: 100, deltaY: -1 }]);
    expect(r.view.pxPerUm).toBeCloseTo(0.01 * Math.pow(2, 0.15), 12);
    expect(run(view(), [{ type: "wheel", x: 100, y: 100, deltaY: 1 }]).view.pxPerUm).toBeLessThan(0.01);
  });

  it("two fingers apart double the zoom, a twist past 8° turns the bearing, a vertical drag tilts", () => {
    const down: Gesture3dEvent[] = [{ type: "down", id: 1, x: 300, y: 300 }, { type: "down", id: 2, x: 500, y: 300 }];
    const pinch = run(view(), [...down, { type: "move", id: 1, x: 200, y: 300 }, { type: "move", id: 2, x: 600, y: 300 }]);
    expect(pinch.view.pxPerUm).toBeCloseTo(0.02, 9);
    expect(pinch.view.bearingDeg).toBe(0);
    // about the midpoint (400, 300): rotate b around a by 20° clockwise
    const r20 = (20 * Math.PI) / 180;
    const twist = run(view(), [...down, { type: "move", id: 2, x: 300 + 200 * Math.cos(r20), y: 300 + 200 * Math.sin(r20) }]);
    expect(twist.view.bearingDeg).toBeCloseTo(0, 6); // activated at 20°: no jump
    const twist2 = run(view(), [
      ...down,
      { type: "move", id: 2, x: 300 + 200 * Math.cos((10 * Math.PI) / 180), y: 300 + 200 * Math.sin((10 * Math.PI) / 180) },
      { type: "move", id: 2, x: 300 + 200 * Math.cos(r20), y: 300 + 200 * Math.sin(r20) },
    ]);
    expect(twist2.view.bearingDeg).toBeCloseTo(-10, 6);
    const steps: Gesture3dEvent[] = [];
    for (let y = 290; y >= 240; y -= 10) steps.push({ type: "move", id: 1, x: 300, y }, { type: "move", id: 2, x: 500, y });
    const tilt = run(view({ pitchDeg: 20 }), [...down, ...steps]);
    expect(tilt.state.mode).toMatchObject({ kind: "two", class: "tilt" });
    expect(tilt.view.pitchDeg).toBeCloseTo(20 + (60 * 90) / 600, 9);
    expect(tilt.view.pxPerUm).toBe(0.01);
  });

  it("two → one finger pans on from the remaining one", () => {
    const r = run(view(), [
      { type: "down", id: 1, x: 300, y: 300 },
      { type: "down", id: 2, x: 500, y: 300 },
      { type: "up", id: 2 },
      { type: "move", id: 1, x: 350, y: 300 },
    ]);
    expect(r.changed).toBe(true);
    expect(r.state.mode?.kind).toBe("pan");
  });
});

describe("bearing ↔ user bearing", () => {
  it("round-trips through viewportRotationDeg", () => {
    for (const [north, cut] of [[3, 0], [null, null], [-12, 4]] as const)
      for (const ub of [0, 25, -170]) {
        const base = viewportRotationDeg(north, cut, 0);
        const b = bearingOfRotation(viewportRotationDeg(north, cut, ub));
        expect(userBearingOf(b, base)).toBeCloseTo(ub, 9);
      }
  });
});
