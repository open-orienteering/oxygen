import { describe, expect, it } from "vitest";
import { sampleHeight } from "@oxygen/shared/src/terrain/field/read.js";
import { cameraFrame, distanceForPxPerUm, projectToScreen, type TerrainCamera } from "../camera";
import { buildTerrainMesh, meshBox } from "../mesh";
import { surfaceHeight } from "../pick";
import { CONE, coneCentreMm, coneField } from "../synthetic";
import { transform } from "../mat4";
import { LINE_DEPTH_BIAS, LINE_LIFT_UM, MAX_LINE_SEGMENTS, liftPolyline, lineInstances, lineVertex, type TerrainLine } from "../lines";

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

  it("does not depend on the exaggeration (heights in units)", () => {
    // nothing to pass: the instances are the same arrays for any e; the shader multiplies
    const a = lineInstances([line([{ x: centre.x - 5, y: centre.y }, { x: centre.x + 5, y: centre.y }])], mesh);
    const b = lineInstances([line([{ x: centre.x - 5, y: centre.y }, { x: centre.x + 5, y: centre.y }])], mesh);
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });
});

describe("lineVertex (the vertex shader's lift and depth bias, in TypeScript)", () => {
  const cam = (pitchDeg: number, bearingDeg = 0): TerrainCamera => {
    const [x, y] = model(centre.x, centre.y);
    const c: TerrainCamera = { target: { x, y, z: 0 }, distanceUm: 0, bearingDeg, pitchDeg, widthPx: 800, heightPx: 600 };
    c.distanceUm = distanceForPxPerUm(c, 600 / (CONE.height * cellUm));
    return c;
  };

  it("lifts by LINE_LIFT_UM whatever the exaggeration, and keeps the point's screen position while moving it towards the eye", () => {
    for (const [pitch, bearing, e] of [[0, 0, 1], [60, 30, 2], [70, 200, 5]] as const) {
      const f = cameraFrame(cam(pitch, bearing), meshBox(mesh, e));
      const zUnit = mesh.unitUm * e;
      for (const [dx, dy] of [[0, 0], [-6, 3], [5, -7]]) {
        const [x, y] = model(centre.x + dx, centre.y + dy);
        const h = surfaceHeight(mesh, x, y)! - mesh.zMin;
        const lifted: [number, number, number] = [x, y, h * zUnit + LINE_LIFT_UM];
        const v = lineVertex([x, y, h], zUnit, f.eye);
        const a = projectToScreen(f.matrix, 800, 600, ...lifted)!, b = projectToScreen(f.matrix, 800, 600, ...v)!;
        expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(1e-3);
        const dist = (p: readonly number[]) => Math.hypot(p[0] - f.eye[0], p[1] - f.eye[1], p[2] - f.eye[2]);
        expect(dist(v)).toBeCloseTo(dist(lifted) * (1 - LINE_DEPTH_BIAS), 0);
        // clip depth smaller: in front of the surface point's depth
        const [, , za, wa] = transform(f.matrix, ...lifted), [, , zb, wb] = transform(f.matrix, ...v);
        expect(zb / wb).toBeLessThan(za / wa);
      }
    }
  });

  it("at pitch 0 a lifted vertex projects where its paper point does in 2D (< 0.5 px)", () => {
    const c = cam(0);
    const f = cameraFrame(c, meshBox(mesh, 2));
    for (const [dx, dy] of [[0, 0], [-6, 3], [5, -7]]) {
      const [x, y] = model(centre.x + dx, centre.y + dy);
      const h = surfaceHeight(mesh, x, y)! - mesh.zMin;
      const p = projectToScreen(f.matrix, 800, 600, ...lineVertex([x, y, h], mesh.unitUm * 2, f.eye))!;
      // the 2D view: y down, centred on the target, pxPerUm as fitted at the target's plane (z 0)
      const k = 600 / (CONE.height * cellUm);
      const q = [400 + (x - c.target.x) * k, 300 - (y - c.target.y) * k];
      // a raised point at pitch 0 moves out from the centre by its height over the distance
      const scale = c.distanceUm / (c.distanceUm - (h * mesh.unitUm * 2 + LINE_LIFT_UM));
      expect(Math.hypot(p[0] - (400 + (q[0] - 400) * scale), p[1] - (300 + (q[1] - 300) * scale))).toBeLessThan(0.5);
    }
  });
});
