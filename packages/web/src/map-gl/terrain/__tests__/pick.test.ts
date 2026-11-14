import { describe, expect, it } from "vitest";
import { sampleHeight } from "@oxygen/shared/src/terrain/field/read.js";
import { cameraFrame, distanceForPxPerUm, projectToScreen, screenRay, type Ray, type TerrainCamera } from "../camera";
import { buildTerrainMesh, meshBox } from "../mesh";
import { pickTerrain, surfaceZ } from "../pick";
import { CONE, coneCentreMm, coneField, fieldFromGrid } from "../synthetic";
import { transform } from "../mat4";

const field = coneField();
const ORIGIN = { x: 20_000, y: 30_000 };
const mesh = buildTerrainMesh(field, ORIGIN);
const centre = coneCentreMm();
/** Model µm of a paper point. */
const model = (xMm: number, yMm: number) => [xMm * 1000 - ORIGIN.x, yMm * 1000 - ORIGIN.y] as const;
const cellUm = CONE.cellMm * 1000;
/** The analytic cone's height in model µm at plan distance r µm from the centre, exaggeration e. */
const coneZ = (rUm: number, e: number) => Math.max(0, CONE.heightM * (1 - rUm / (CONE.radiusCells * cellUm))) * (1000 / CONE.groundMPerMm) * e;

/** The analytic first intersection of a ray with the cone, by fine bisection on the closed form. */
function analyticHit(ray: Ray, e: number): [number, number, number] {
  const [cx, cy] = model(centre.x, centre.y);
  const g = (t: number) => ray.origin[2] + ray.dir[2] * t - coneZ(Math.hypot(ray.origin[0] + ray.dir[0] * t - cx, ray.origin[1] + ray.dir[1] * t - cy), e);
  let lo = 0, hi = 0;
  for (let t = 0; t < 1e8; t += 5) if (g(t) <= 0) {
    hi = t;
    lo = t - 5;
    break;
  }
  for (let k = 0; k < 60; k++) {
    const m = (lo + hi) / 2;
    if (g(m) <= 0) hi = m;
    else lo = m;
  }
  return [ray.origin[0] + ray.dir[0] * hi, ray.origin[1] + ray.dir[1] * hi, ray.origin[2] + ray.dir[2] * hi];
}

const camera = (pitchDeg: number, bearingDeg = 0): TerrainCamera => {
  const [x, y] = model(centre.x, centre.y);
  const c: TerrainCamera = { target: { x, y, z: 0 }, distanceUm: 0, bearingDeg, pitchDeg, widthPx: 800, heightPx: 600 };
  c.distanceUm = distanceForPxPerUm(c, 600 / (CONE.height * cellUm));
  return c;
};

describe("pickTerrain (map-rendering.md §5.6 \"Pick\")", () => {
  it("meets the analytic cone within half a cell at pitch 0, 60 and grazing", () => {
    for (const [pitch, e] of [[0, 1], [60, 1], [60, 3], [84, 2]] as const)
      for (const [px, py] of [[400, 300], [330, 260], [460, 340], [420, 200]]) {
        const cam = camera(pitch);
        const ray = screenRay(cam, px, py);
        const hit = pickTerrain(mesh, field, ray, e);
        expect(hit).not.toBeNull();
        const a = analyticHit(ray, e);
        // plan distance between the hits
        expect(Math.hypot(hit!.model[0] - a[0], hit!.model[1] - a[1])).toBeLessThan(cellUm / 2 + (pitch > 80 ? cellUm : 0));
      }
  });

  it("round-trips a surface point through project → screenRay → pick", () => {
    const cam = camera(55, 30);
    const m = cameraFrame(cam, meshBox(mesh, 2)).matrix;
    for (const [dxMm, dyMm] of [[0, -5], [-4, -3], [3, -6], [0, 0], [-7, -10]]) {
      const [x, y] = model(centre.x + dxMm, centre.y + dyMm);
      const z = surfaceZ(mesh, x, y, 2)!;
      const p = projectToScreen(m, cam.widthPx, cam.heightPx, x, y, z)!;
      const hit = pickTerrain(mesh, field, screenRay(cam, p[0], p[1]), 2)!;
      expect(Math.hypot(hit.x - (centre.x + dxMm), hit.y - (centre.y + dyMm))).toBeLessThan(CONE.cellMm / 2);
    }
  });

  it("reports the height in metres as sampleHeight does, whatever the exaggeration", () => {
    const down: Ray["dir"] = [0, 0, -1];
    for (const [dxMm, dyMm] of [[3, 2], [-6.1, 1.3], [0.7, -9.9], [-2.2, -3.3]])
      for (const e of [1, 2.5]) {
        const [x, y] = model(centre.x + dxMm, centre.y + dyMm);
        const hit = pickTerrain(mesh, field, { origin: [x, y, 1e6], dir: down }, e)!;
        expect(hit.data).toBe(true);
        expect(Math.abs(hit.heightM - sampleHeight(field, { x: hit.x, y: hit.y })!)).toBeLessThanOrEqual(field.header.zScaleM);
      }
  });

  it("is false on the no-data margin and null on a miss", () => {
    const [x, y] = model(CONE.x0 + 0.3, CONE.y0 + 0.3);
    const margin = pickTerrain(mesh, field, { origin: [x, y, 5_000], dir: [0, 0, -1] }, 1)!;
    expect(margin.data).toBe(false);
    expect(margin.heightM).toBe(0);
    expect(pickTerrain(mesh, field, { origin: [x, y, 5_000], dir: [0, 0, 1] }, 1)).toBeNull();
    expect(pickTerrain(mesh, field, { origin: [-1e7, y, 5_000], dir: [0, 0, -1] }, 1)).toBeNull();
  });
});

describe("near and far (map-rendering.md §5.6 \"Camera\", spec review)", () => {
  it("enclose every visible surface point at low and high tilt over a plateau", () => {
    // 600 × 600 cells, a 100 m plateau in the middle third, exaggeration 2, 1920 × 1080
    const f = fieldFromGrid(600, 600, (cx, cy) => (cx > 200 && cx < 400 && cy > 200 && cy < 400 ? 100 : 0));
    const m = buildTerrainMesh(f);
    const box = meshBox(m, 2);
    const target = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2, z: box.maxZ };
    let checked = 0;
    for (const pitchDeg of [10, 20, 30, 60, 80])
      for (const distanceUm of [10_000, 30_000, 100_000]) {
        const cam: TerrainCamera = { target, distanceUm, bearingDeg: 0, pitchDeg, widthPx: 1920, heightPx: 1080 };
        const mat = cameraFrame(cam, box).matrix;
        for (let py = 0; py <= 1080; py += 60)
          for (let px = 0; px <= 1920; px += 80) {
            const hit = pickTerrain(m, f, screenRay(cam, px, py), 2);
            if (!hit) continue;
            const [, , cz, w] = transform(mat, ...hit.model);
            expect(w).toBeGreaterThan(0);
            expect(cz, `pitch ${pitchDeg}, distance ${distanceUm}, px (${px}, ${py})`).toBeGreaterThanOrEqual(-w);
            expect(cz).toBeLessThanOrEqual(w);
            checked++;
          }
      }
    expect(checked).toBeGreaterThan(1000);
  });
});
