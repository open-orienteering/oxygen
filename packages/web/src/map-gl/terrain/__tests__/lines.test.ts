import { describe, expect, it } from "vitest";
import { sampleHeight } from "@oxygen/shared/src/terrain/field/read.js";
import { cameraFrame, distanceForPxPerUm, projectToScreen, type TerrainCamera } from "../camera";
import { buildTerrainMesh, meshBox } from "../mesh";
import { surfaceHeight } from "../pick";
import { CONE, coneCentreMm, coneField } from "../synthetic";
import { transform } from "../mat4";
import { LINE_DEPTH_BIAS, LINE_LIFT_UM, LINE_RISE_CAP, MAX_LINE_SEGMENTS, liftPolyline, lineInstances, lineVertex, type TerrainLine } from "../lines";

const field = coneField();
const ORIGIN = { x: 20_000, y: 30_000 };
const mesh = buildTerrainMesh(field, ORIGIN);
const centre = coneCentreMm();
const cellUm = CONE.cellMm * 1000;
/** Model µm of a paper point. */
const model = (xMm: number, yMm: number) => [xMm * 1000 - ORIGIN.x, yMm * 1000 - ORIGIN.y] as const;
/** Paper mm of a model point. */
const paper = (x: number, y: number) => ({ x: (x + ORIGIN.x) / 1000, y: (y + ORIGIN.y) / 1000 });

const vertices = (run: Float32Array) => Array.from({ length: run.length / 3 }, (_, i) => [run[i * 3], run[i * 3 + 1], run[i * 3 + 2]] as const);

describe("liftPolyline (map-rendering.md §5.6 \"Lines\")", () => {
  it("takes the origin off and carries height units above zMin", () => {
    const [run] = liftPolyline([{ x: centre.x, y: centre.y }, { x: centre.x + 0.1, y: centre.y }], mesh);
    const [x, y, h] = vertices(run)[0];
    expect(x).toBeCloseTo(model(centre.x, centre.y)[0], 1);
    expect(y).toBeCloseTo(model(centre.x, centre.y)[1], 1);
    expect(h).toBeCloseTo(surfaceHeight(mesh, x, y)! - mesh.zMin, 3);
  });

  it("densifies to the mesh's cell and keeps the original points", () => {
    const pts = [{ x: centre.x - 8, y: centre.y - 3 }, { x: centre.x + 7, y: centre.y + 2 }, { x: centre.x + 7.05, y: centre.y + 2 }];
    const [run] = liftPolyline(pts, mesh);
    const v = vertices(run);
    for (let i = 1; i < v.length; i++) expect(Math.hypot(v[i][0] - v[i - 1][0], v[i][1] - v[i - 1][1])).toBeLessThanOrEqual(cellUm * (1 + 1e-6));
    for (const p of pts) {
      const [mx, my] = model(p.x, p.y);
      expect(v.some(([x, y]) => Math.hypot(x - mx, y - my) < 0.05)).toBe(true);
    }
    expect(v[0][0]).toBeCloseTo(model(pts[0].x, pts[0].y)[0], 1);
    expect(v[v.length - 1][0]).toBeCloseTo(model(pts[2].x, pts[2].y)[0], 1);
  });

  it("follows the drawn surface: every vertex on it, and sampleHeight within one height unit", () => {
    const [run] = liftPolyline([{ x: centre.x - 10, y: centre.y + 1 }, { x: centre.x + 10, y: centre.y - 1 }], mesh);
    let checked = 0;
    for (const [x, y, h] of vertices(run)) {
      expect(h).toBeCloseTo(surfaceHeight(mesh, x, y)! - mesh.zMin, 3);
      const p = paper(x, y);
      const m = sampleHeight(field, p);
      if (m === null) continue;
      expect(Math.abs((h + mesh.zMin) * field.header.zScaleM + field.header.zOffsetM - m)).toBeLessThanOrEqual(field.header.zScaleM);
      checked++;
    }
    expect(checked).toBeGreaterThan(80);
  });

  it("a chord across the apex goes over the cone, not through it", () => {
    // two GPS fixes 20 mm apart on either side of the apex: undensified, the chord would sit at the foot's height
    const [run] = liftPolyline([{ x: centre.x - 10, y: centre.y }, { x: centre.x + 10, y: centre.y }], mesh);
    const v = vertices(run);
    const top = Math.max(...v.map(([, , h]) => h));
    expect(top).toBeGreaterThan(0.9 * (mesh.zMax - mesh.zMin));
    for (const [x, y, h] of v) expect(h).toBeGreaterThanOrEqual(surfaceHeight(mesh, x, y)! - mesh.zMin - 1e-3);
  });

  it("takes the filled height on the no-data margin", () => {
    const [run] = liftPolyline([{ x: CONE.x0 + 0.15, y: CONE.y0 + 0.15 }, { x: CONE.x0 + 0.6, y: CONE.y0 + 0.15 }], mesh);
    expect(run).toBeDefined();
    for (const [, , h] of vertices(run)) expect(h).toBeCloseTo(0, 3);
  });

  it("breaks the line where it leaves the mesh, and drops runs of one vertex", () => {
    const right = CONE.x0 + CONE.width * CONE.cellMm;
    const runs = liftPolyline([{ x: centre.x, y: centre.y }, { x: right + 5, y: centre.y }, { x: right + 5, y: centre.y - 2 }, { x: centre.x, y: centre.y - 2 }], mesh);
    expect(runs).toHaveLength(2);
    // wholly outside, and a single point
    expect(liftPolyline([{ x: right + 5, y: 0 }, { x: right + 9, y: 0 }], mesh)).toHaveLength(0);
    expect(liftPolyline([{ x: centre.x, y: centre.y }], mesh)).toHaveLength(0);
    expect(liftPolyline([], mesh)).toHaveLength(0);
  });

  it("skips a repeated fix", () => {
    const [run] = liftPolyline([{ x: centre.x, y: centre.y }, { x: centre.x, y: centre.y }, { x: centre.x + 0.1, y: centre.y }], mesh);
    expect(vertices(run)).toHaveLength(2);
  });

  it("samples another surface when given one (H11's seam)", () => {
    const [run] = liftPolyline([{ x: centre.x, y: centre.y }, { x: centre.x + 1, y: centre.y }], mesh, { surface: () => mesh.zMin + 7 });
    for (const [, , h] of vertices(run)) expect(h).toBe(7);
  });
});

describe("lineInstances", () => {
  const line = (points: TerrainLine["points"]): TerrainLine => ({ points, colour: [1, 0, 0], opacity: 0.8, widthPx: 4.5 });

  it("one (p0, p1) instance per segment, one range per line", () => {
    const a = line([{ x: centre.x - 5, y: centre.y }, { x: centre.x + 5, y: centre.y }]);
    const b = line([{ x: centre.x, y: centre.y - 5 }, { x: centre.x, y: centre.y - 4 }]);
    const out = lineInstances([a, b], mesh);
    const [ra] = liftPolyline(a.points, mesh), [rb] = liftPolyline(b.points, mesh);
    expect(out.ranges).toEqual([{ first: 0, count: ra.length / 3 - 1 }, { first: ra.length / 3 - 1, count: rb.length / 3 - 1 }]);
    expect(out.segments).toBe(ra.length / 3 - 1 + rb.length / 3 - 1);
    expect(out.data.length).toBe(out.segments * 6);
    // instance i is vertices i and i + 1
    expect(Array.from(out.data.subarray(0, 6))).toEqual(Array.from(ra.subarray(0, 6)));
    expect(Array.from(out.data.subarray(6, 9))).toEqual(Array.from(ra.subarray(3, 6)));
  });

  it("a line broken in two runs has no segment across the gap", () => {
    const right = CONE.x0 + CONE.width * CONE.cellMm;
    const l = line([{ x: centre.x, y: centre.y }, { x: right + 5, y: centre.y }, { x: right + 5, y: centre.y - 2 }, { x: centre.x, y: centre.y - 2 }]);
    const runs = liftPolyline(l.points, mesh);
    const out = lineInstances([l], mesh);
    expect(out.segments).toBe(runs.reduce((s, r) => s + r.length / 3 - 1, 0));
    for (let i = 0; i < out.segments; i++) {
      const d = out.data.subarray(i * 6, i * 6 + 6);
      expect(Math.hypot(d[3] - d[0], d[4] - d[1])).toBeLessThanOrEqual(cellUm * (1 + 1e-6));
    }
  });

  it("doubles the step until the set fits MAX_LINE_SEGMENTS", () => {
    // 2 400 back-and-forth crossings of the cone ≈ 2 400 · 100 cells at the cell's step
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i < 2_400; i++) pts.push({ x: centre.x + (i % 2 ? 10 : -10), y: centre.y + (i % 7) * 0.01 });
    const out = lineInstances([line(pts)], mesh);
    expect(out.segments).toBeLessThanOrEqual(MAX_LINE_SEGMENTS);
    expect(out.segments).toBeGreaterThan(MAX_LINE_SEGMENTS / 4);
  });
});

describe("lineVertex (the vertex shader's lift and depth bias, in TypeScript)", () => {
  const W = 800, H = 600, HALF = 3;
  const cam = (pitchDeg: number, bearingDeg = 0): TerrainCamera => {
    const [x, y] = model(centre.x, centre.y);
    const c: TerrainCamera = { target: { x, y, z: 0 }, distanceUm: 0, bearingDeg, pitchDeg, widthPx: W, heightPx: H };
    c.distanceUm = distanceForPxPerUm(c, H / (CONE.height * cellUm));
    return c;
  };
  const frameOf = (pitch: number, bearing: number, e: number) => {
    const f = cameraFrame(cam(pitch, bearing), meshBox(mesh, e));
    return { f, lf: { matrix: f.matrix, eye: f.eye, zUnit: mesh.unitUm * e, widthPx: W, heightPx: H, focalPx: f.focalPx, halfPx: HALF } };
  };
  const ground = (dx: number, dy: number, zUnit: number) => {
    const [x, y] = model(centre.x + dx, centre.y + dy);
    const h = surfaceHeight(mesh, x, y)! - mesh.zMin;
    return { p: [x, y, h] as [number, number, number], g: [x, y, h * zUnit] as [number, number, number] };
  };
  const depth = (m: ArrayLike<number>, p: readonly number[]) => {
    const [, , z, w] = transform(m, p[0], p[1], p[2]);
    return z / w;
  };

  it("tilted, lifts the line half its width (+ ½ px) above its ground point on screen and in front of it", () => {
    for (const [pitch, bearing, e] of [[45, 0, 1], [60, 30, 2], [70, 200, 5]] as const) {
      const { f, lf } = frameOf(pitch, bearing, e);
      for (const [dx, dy] of [[0, 0], [-6, 3], [5, -7]]) {
        const { p, g } = ground(dx, dy, lf.zUnit);
        const v = lineVertex(p, lf);
        const a = projectToScreen(f.matrix, W, H, ...g)!, b = projectToScreen(f.matrix, W, H, ...v)!;
        // the constant lift adds a little on top of the half width
        const rise = a[1] - b[1];
        expect(rise).toBeGreaterThan(HALF + 0.5 - 0.05);
        // plus the constant lift: LINE_LIFT_UM at this zoom's px per µm (perspective: a little more near the eye)
        expect(rise).toBeLessThan(HALF + 0.5 + LINE_LIFT_UM * (H / (CONE.height * cellUm)) * 1.3);
        expect(Math.abs(a[0] - b[0])).toBeLessThan(rise * 0.2 + 0.05);
        expect(depth(f.matrix, v)).toBeLessThan(depth(f.matrix, g));
      }
    }
  });

  it("moves the vertex LINE_DEPTH_BIAS of its distance towards the eye without moving it on screen", () => {
    const { f, lf } = frameOf(60, 30, 2);
    const { p } = ground(-6, 3, lf.zUnit);
    const v = lineVertex(p, lf);
    // undo the bias: the point it was moved from, on the same ray
    const k = 1 / (1 - LINE_DEPTH_BIAS);
    const u = [0, 1, 2].map((i) => f.eye[i] + (v[i] - f.eye[i]) * k);
    expect(u[2] - p[2] * lf.zUnit).toBeGreaterThanOrEqual(LINE_LIFT_UM);
    const a = projectToScreen(f.matrix, W, H, u[0], u[1], u[2])!, b = projectToScreen(f.matrix, W, H, ...v)!;
    expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(1e-3);
    const dist = (q: readonly number[]) => Math.hypot(q[0] - f.eye[0], q[1] - f.eye[1], q[2] - f.eye[2]);
    expect(dist(v) / dist(u)).toBeCloseTo(1 - LINE_DEPTH_BIAS, 9);
  });

  it("looking straight down: on its ground point under the eye (< 0.5 px, the rise capped), at most the half width off it elsewhere", () => {
    for (const e of [1, 2, 5]) {
      const { f, lf } = frameOf(0, 0, e);
      for (const [dx, dy] of [[0, 0], [-6, 3], [5, -7], [9, 9]]) {
        const { p, g } = ground(dx, dy, lf.zUnit);
        const v = lineVertex(p, lf);
        const a = projectToScreen(f.matrix, W, H, ...g)!, b = projectToScreen(f.matrix, W, H, ...v)!;
        // a vertical rise moves a point away from the screen's centre in proportion to its offset: none under the eye
        const off = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (dx === 0 && dy === 0) expect(off).toBeLessThan(0.5);
        else expect(off).toBeLessThan(HALF + 0.5 + LINE_LIFT_UM * (H / (CONE.height * cellUm)) * 1.3);
        const [, , , w] = transform(f.matrix, ...g);
        // the bias undone: the rise is at most the cap's
        const lifted = f.eye[2] + (v[2] - f.eye[2]) / (1 - LINE_DEPTH_BIAS);
        expect(lifted - g[2]).toBeLessThanOrEqual(LINE_LIFT_UM + ((HALF + 0.5) * w * LINE_RISE_CAP) / f.focalPx + 1e-3);
      }
    }
  });
});
