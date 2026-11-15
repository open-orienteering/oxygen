import { describe, expect, it } from "vitest";
import { viewMatrix } from "../../view";
import { cameraFrame, distanceForPxPerUm, focalPx, projectToScreen, screenRay, terrainCamera, type TerrainCamera } from "../camera";
import { identity, invert, multiply, perspective, transform } from "../mat4";

const ndc = (m: ArrayLike<number>, x: number, y: number, z: number) => {
  const [cx, cy, cz, w] = transform(m, x, y, z);
  return [cx / w, cy / w, cz / w, w];
};

describe("mat4 (map-rendering.md §5.6 \"Camera\")", () => {
  it("multiplies, inverts and projects", () => {
    const p = perspective(Math.PI / 3, 2, 1, 100);
    const inv = invert(p)!;
    const id = multiply(p, inv);
    const ref = identity();
    for (let i = 0; i < 16; i++) expect(id[i]).toBeCloseTo(ref[i], 12);
    // near plane → depth −1, far → +1, on the axis
    expect(ndc(p, 0, 0, -1)[2]).toBeCloseTo(-1, 12);
    expect(ndc(p, 0, 0, -100)[2]).toBeCloseTo(1, 12);
    // the top of the view at 60° fov: y = tan 30° · distance
    expect(ndc(p, 0, Math.tan(Math.PI / 6) * 10, -10)[1]).toBeCloseTo(1, 12);
    expect(ndc(p, 2 * Math.tan(Math.PI / 6) * 10, 0, -10)[0]).toBeCloseTo(1, 12);
    expect(invert(new Float64Array(16))).toBeNull();
  });
});

describe("terrainCamera (map-rendering.md §5.6 \"Camera\")", () => {
  const base: TerrainCamera = { target: { x: 12_000, y: -4_000, z: 300 }, distanceUm: 100_000, bearingDeg: 0, pitchDeg: 0, widthPx: 1000, heightPx: 600 };

  it("projects the target to the clip origin at any bearing and pitch", () => {
    for (const bearingDeg of [0, 37, -120, 200])
      for (const pitchDeg of [0, 30, 60, 85]) {
        const [x, y] = ndc(terrainCamera({ ...base, bearingDeg, pitchDeg }), base.target.x, base.target.y, base.target.z);
        expect(Math.abs(x)).toBeLessThan(1e-6);
        expect(Math.abs(y)).toBeLessThan(1e-6);
      }
  });

  it("is a single Float32Array(16)", () => {
    const m = terrainCamera(base);
    expect(m).toBeInstanceOf(Float32Array);
    expect(m.length).toBe(16);
  });

  it("at pitch 0 draws the target plane as the 2D viewMatrix does", () => {
    const pxPerUm = 0.004;
    for (const bearingDeg of [0, 30, -75]) {
      const cam = { ...base, bearingDeg, distanceUm: distanceForPxPerUm(base, pxPerUm) };
      const m3 = terrainCamera(cam);
      const m2 = viewMatrix({ centreX: base.target.x, centreY: base.target.y, pxPerUm, widthPx: base.widthPx, heightPx: base.heightPx, rotationDeg: bearingDeg }, 0, 0);
      for (const [dx, dy] of [[0, 0], [50_000, 0], [0, 40_000], [-80_000, 33_000], [123_000, -70_000]]) {
        const x = base.target.x + dx, y = base.target.y + dy;
        const a = ndc(m3, x, y, base.target.z), b = ndc(m2, x, y, 0);
        expect(a[0]).toBeCloseTo(b[0], 6);
        expect(a[1]).toBeCloseTo(b[1], 6);
      }
    }
  });

  it("at pitch > 0 lifts a point above the target plane on screen and orders depth by distance", () => {
    const m = terrainCamera({ ...base, pitchDeg: 50 });
    const t = base.target;
    expect(ndc(m, t.x, t.y, t.z + 5_000)[1]).toBeGreaterThan(ndc(m, t.x, t.y, t.z)[1]);
    // looking north: farther north is farther away and deeper
    const depths = [-40_000, 0, 40_000, 80_000].map((dy) => ndc(m, t.x, t.y + dy, t.z)[2]);
    for (let i = 1; i < depths.length; i++) expect(depths[i]).toBeGreaterThan(depths[i - 1]);
  });

  it("looks along the bearing: bearing 90 looks east at pitch > 0", () => {
    const f = cameraFrame({ ...base, bearingDeg: 90, pitchDeg: 40 });
    expect(f.forward[0]).toBeGreaterThan(0.6);
    expect(Math.abs(f.forward[1])).toBeLessThan(1e-12);
    expect(f.eye[0]).toBeLessThan(base.target.x);
  });

  it("encloses the given bounds between near and far", () => {
    const bounds = { minX: -200_000, minY: -150_000, minZ: 0, maxX: 220_000, maxY: 140_000, maxZ: 25_000 };
    for (const pitchDeg of [0, 45, 80]) {
      const f = cameraFrame({ ...base, pitchDeg }, bounds);
      for (const x of [bounds.minX, bounds.maxX])
        for (const y of [bounds.minY, bounds.maxY])
          for (const z of [bounds.minZ, bounds.maxZ]) {
            const [, , cz, w] = ndc(f.matrix, x, y, z);
            if (w > 0) {
              expect(cz).toBeGreaterThanOrEqual(-1);
              expect(cz).toBeLessThanOrEqual(1);
            }
          }
      expect(f.far / f.near).toBeLessThanOrEqual(1e4 + 1e-6);
    }
  });

  it("leaves headroom in front of the box for lines drawn above the surface (H8)", () => {
    const bounds = { minX: -20_000, minY: -15_000, minZ: 300, maxX: 32_000, maxY: 14_000, maxZ: 300 };
    for (const pitchDeg of [0, 45]) {
      const f = cameraFrame({ ...base, pitchDeg }, bounds);
      // the target raised towards the eye by 15 % of its depth is still in front of the near plane
      const t = base.target, k = 0.15;
      const [, , cz] = ndc(f.matrix, t.x + (f.eye[0] - t.x) * k, t.y + (f.eye[1] - t.y) * k, t.z + (f.eye[2] - t.z) * k);
      expect(cz).toBeGreaterThanOrEqual(-1);
    }
  });

  it("keeps sub-pixel precision far from the origin after the float32 upload", () => {
    // 585 mm from the origin, 0.2 px/µm (as view.test.ts): 37.5 µm right of the target is 7.5 px.
    const cam: TerrainCamera = { target: { x: 585_000, y: 300_000, z: 0 }, distanceUm: 0, bearingDeg: 0, pitchDeg: 0, widthPx: 1081, heightPx: 2402 };
    cam.distanceUm = distanceForPxPerUm(cam, 0.2);
    const m = terrainCamera(cam);
    const f = Math.fround;
    const x = f(585_000 + 37.5), y = f(300_000), z = 0;
    const cx = f(f(f(m[0] * x) + f(m[4] * y)) + f(f(m[8] * z) + m[12]));
    const cw = f(f(f(m[3] * x) + f(m[7] * y)) + f(f(m[11] * z) + m[15]));
    const px = ((cx / cw) * cam.widthPx) / 2;
    expect(Math.abs(px - 7.5)).toBeLessThan(0.05);
  });

  it("screenRay inverts the projection", () => {
    for (const pitchDeg of [0, 35, 70])
      for (const bearingDeg of [0, 145]) {
        const cam = { ...base, pitchDeg, bearingDeg };
        const m = cameraFrame(cam).matrix;
        for (const [px, py] of [[500, 300], [0, 0], [999, 599], [123, 456]]) {
          const r = screenRay(cam, px, py);
          const t = 77_777;
          const p = projectToScreen(m, cam.widthPx, cam.heightPx, r.origin[0] + r.dir[0] * t, r.origin[1] + r.dir[1] * t, r.origin[2] + r.dir[2] * t)!;
          expect(p[0]).toBeCloseTo(px, 6);
          expect(p[1]).toBeCloseTo(py, 6);
          expect(Math.hypot(...r.dir)).toBeCloseTo(1, 12);
        }
      }
  });

  it("focal length follows the field of view", () => {
    expect(focalPx({ heightPx: 600, fovYDeg: 90 })).toBeCloseTo(300, 9);
  });
});
