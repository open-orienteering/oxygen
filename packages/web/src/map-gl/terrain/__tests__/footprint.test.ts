import { describe, expect, it } from "vitest";
import { viewMatrix } from "../../view";
import { cameraFrame, distanceForPxPerUm, type Box3, type TerrainCamera } from "../camera";
import { transform } from "../mat4";
import { DRAPE_MARGIN, DRAPE_SPLIT_RATIO, drapeLayers, drapeTexels, drapeTiles, groundFootprint, type Pt } from "../footprint";
import { seededRandom } from "../synthetic";

const ORIGIN = { x: 1_000_000, y: -200_000 };
const big: Box3 = { minX: -2e6, maxX: 2e6, minY: -2e6, maxY: 2e6, minZ: 0, maxZ: 0 };
const roomy = { maxSide: 1 << 20, maxPixels: 1e12 };

function camera(over: Partial<TerrainCamera> = {}, pxPerUm = 0.01): TerrainCamera {
  const cam: TerrainCamera = { target: { x: 12_000, y: -4_000, z: 0 }, distanceUm: 0, bearingDeg: 0, pitchDeg: 0, widthPx: 1000, heightPx: 600, ...over };
  if (!over.distanceUm) cam.distanceUm = distanceForPxPerUm(cam, pxPerUm);
  return cam;
}

/** Inside a counter-clockwise convex polygon, within `tol` µm. */
function insidePolygon(poly: readonly Pt[], [x, y]: Pt, tol: number): boolean {
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
    const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (cross < -tol * Math.hypot(bx - ax, by - ay)) return false;
  }
  return true;
}

/** Clip (x, y) of a model point under a layer view's matrix. */
const layerClip = (v: Parameters<typeof viewMatrix>[0], x: number, y: number) => {
  const m = viewMatrix(v, ORIGIN.x, ORIGIN.y);
  return [m[0] * x + m[4] * y + m[12], m[1] * x + m[5] * y + m[13]];
};

describe("groundFootprint (map-rendering.md §5.6 \"Footprint\")", () => {
  it("is the screen rectangle on flat ground at pitch 0", () => {
    const cam = camera({ bearingDeg: 0 });
    const poly = groundFootprint(cam, big);
    const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
    // 1000 × 600 px at 0.01 px/µm: 100 000 × 60 000 µm about the target
    expect(Math.min(...xs)).toBeCloseTo(12_000 - 50_000, 3);
    expect(Math.max(...xs)).toBeCloseTo(12_000 + 50_000, 3);
    expect(Math.min(...ys)).toBeCloseTo(-4_000 - 30_000, 3);
    expect(Math.max(...ys)).toBeCloseTo(-4_000 + 30_000, 3);
  });

  it("is the analytic trapezoid on flat ground when tilted", () => {
    const pitch = 45, cam = camera({ pitchDeg: pitch, target: { x: 0, y: 0, z: 0 } });
    const d = cam.distanceUm, p = (pitch * Math.PI) / 180, half = (35 * Math.PI) / 360;
    const h = d * Math.cos(p), eyeY = -d * Math.sin(p);
    const poly = groundFootprint(cam, big);
    const ys = poly.map((q) => q[1]);
    expect(Math.min(...ys)).toBeCloseTo(eyeY + h * Math.tan(p - half), 2);
    expect(Math.max(...ys)).toBeCloseTo(eyeY + h * Math.tan(p + half), 2);
    // wider at the far edge
    const far = poly.filter((q) => q[1] > Math.max(...ys) - 1), near = poly.filter((q) => q[1] < Math.min(...ys) + 1);
    const span = (qs: Pt[]) => Math.max(...qs.map((q) => q[0])) - Math.min(...qs.map((q) => q[0]));
    expect(span(far)).toBeGreaterThan(span(near) * 1.5);
  });

  it("covers every surface point of the box the camera sees", () => {
    const rand = seededRandom(3);
    const box: Box3 = { minX: -150_000, maxX: 180_000, minY: -120_000, maxY: 160_000, minZ: 0, maxZ: 25_000 };
    for (let k = 0; k < 40; k++) {
      const cam = camera({
        target: { x: (rand() - 0.5) * 200_000, y: (rand() - 0.5) * 200_000, z: rand() * 25_000 },
        bearingDeg: rand() * 360,
        pitchDeg: rand() * 85,
      }, 0.002 + rand() * 0.05);
      const poly = groundFootprint(cam, box);
      const layers = drapeLayers(cam, box, ORIGIN, { maxSide: 4096, maxPixels: 4e6 });
      const m = cameraFrame(cam).matrix;
      for (let i = 0; i < 200; i++) {
        const x = box.minX + rand() * (box.maxX - box.minX), y = box.minY + rand() * (box.maxY - box.minY), z = rand() * box.maxZ;
        const [cx, cy, , w] = transform(m, x, y, z);
        if (w <= 0 || Math.abs(cx) > w || Math.abs(cy) > w) continue;
        expect(insidePolygon(poly, [x, y], 1e-3)).toBe(true);
        // inside some layer's texture square
        const inLayer = layers.some(({ view }) => {
          const [lx, ly] = layerClip(view, x, y);
          return Math.abs(lx) <= 1 + 1e-9 && Math.abs(ly) <= 1 + 1e-9;
        });
        expect(inLayer).toBe(true);
      }
    }
  });

  it("is empty when the camera looks away from the box", () => {
    const box: Box3 = { minX: -1e5, maxX: 1e5, minY: 5e6, maxY: 6e6, minZ: 0, maxZ: 1e4 };
    const cam = camera({ target: { x: 0, y: 0, z: 0 }, bearingDeg: 180, pitchDeg: 60 });
    expect(groundFootprint(cam, box)).toEqual([]);
    expect(drapeLayers(cam, box, ORIGIN, roomy)).toEqual([]);
  });

  it("is clipped to the box", () => {
    const box: Box3 = { minX: 0, maxX: 20_000, minY: 0, maxY: 10_000, minZ: 0, maxZ: 0 };
    const poly = groundFootprint(camera({ target: { x: 10_000, y: 5_000, z: 0 } }), box);
    for (const [x, y] of poly) {
      expect(x).toBeGreaterThanOrEqual(-1e-6);
      expect(x).toBeLessThanOrEqual(20_000 + 1e-6);
      expect(y).toBeGreaterThanOrEqual(-1e-6);
      expect(y).toBeLessThanOrEqual(10_000 + 1e-6);
    }
  });
});

describe("drapeLayers (map-rendering.md §5.6 \"Drape layers\")", () => {
  it("is the 2D view at pitch 0, grown by the margin (the hand-over)", () => {
    for (const bearingDeg of [0, 30, -135]) {
      const cam = camera({ bearingDeg });
      const layers = drapeLayers(cam, big, ORIGIN, roomy);
      expect(layers).toHaveLength(1);
      const v = layers[0].view;
      expect(layers[0].role).toBe("far");
      expect(v.pxPerUm).toBeCloseTo(0.01, 12);
      expect(v.rotationDeg).toBe(bearingDeg);
      // the centre within a texel of the target (snapped to the pixel grid)
      expect(Math.hypot(v.centreX - ORIGIN.x - 12_000, v.centreY - ORIGIN.y + 4_000)).toBeLessThanOrEqual(Math.SQRT2 / 0.01);
      // the grown extent, snapped outward to the screen's pixel grid
      expect(v.widthPx - 1000 * (1 + 2 * DRAPE_MARGIN)).toBeGreaterThanOrEqual(-1e-6);
      expect(v.widthPx - 1000 * (1 + 2 * DRAPE_MARGIN)).toBeLessThanOrEqual(2);
      expect(v.heightPx - 600 * (1 + 2 * DRAPE_MARGIN)).toBeLessThanOrEqual(2);
      // A target-plane point is a whole number of texels from where it is in screen pixels.
      const view2d = { centreX: 12_000 + ORIGIN.x, centreY: -4_000 + ORIGIN.y, pxPerUm: 0.01, widthPx: 1000, heightPx: 600, rotationDeg: bearingDeg };
      const whole = (n: number) => Math.abs(n - Math.round(n));
      for (const [x, y] of [[30_000, 10_000], [-20_000, -25_000]]) {
        const [ax, ay] = layerClip(v, x, y), [bx, by] = layerClip(view2d, x, y);
        expect(whole(((ax + 1) * v.widthPx) / 2 - ((bx + 1) * 1000) / 2)).toBeLessThan(1e-3);
        expect(whole(((ay + 1) * v.heightPx) / 2 - ((by + 1) * 600) / 2)).toBeLessThan(1e-3);
      }
    }
  });

  it("never exceeds the limits, with one or two layers", () => {
    const rand = seededRandom(11);
    const box: Box3 = { minX: -400_000, maxX: 400_000, minY: -300_000, maxY: 300_000, minZ: 0, maxZ: 30_000 };
    for (let k = 0; k < 60; k++) {
      const limits = { maxSide: 512 + Math.floor(rand() * 3584), maxPixels: 2e5 + rand() * 8e6 };
      const cam = camera({ target: { x: (rand() - 0.5) * 6e5, y: (rand() - 0.5) * 5e5, z: 0 }, bearingDeg: rand() * 360, pitchDeg: rand() * 85, widthPx: 1081, heightPx: 2402 }, 0.002 + rand() * 0.2);
      const layers = drapeLayers(cam, box, ORIGIN, limits);
      expect(layers.length).toBeLessThanOrEqual(2);
      expect(drapeTexels(layers.map((l) => l.view))).toBeLessThanOrEqual(limits.maxPixels);
      for (const { view } of layers) {
        expect(view.widthPx).toBeLessThanOrEqual(limits.maxSide);
        expect(view.heightPx).toBeLessThanOrEqual(limits.maxSide);
        expect(view.pxPerUm).toBeLessThanOrEqual(layers[0].needPxPerUm * (1 + 1e-12));
      }
    }
  });

  it("splits a wide depth range by need: a near layer at the nearest point's density, the far one at the split depth's", () => {
    const box: Box3 = { minX: -400_000, maxX: 400_000, minY: -300_000, maxY: 300_000, minZ: 0, maxZ: 20_000 };
    const cam = camera({ target: { x: 0, y: 0, z: 0 }, pitchDeg: 60, widthPx: 1081, heightPx: 2402 }, 0.05);
    const layers = drapeLayers(cam, box, ORIGIN, roomy);
    expect(layers.map((l) => l.role)).toEqual(["near", "far"]);
    const [near, far] = layers;
    // the cap does not bite: each layer is at its need
    expect(near.view.pxPerUm).toBeCloseTo(near.needPxPerUm, 9);
    expect(far.view.pxPerUm).toBeCloseTo(far.needPxPerUm, 9);
    expect(far.needPxPerUm).toBeLessThan(near.needPxPerUm);
    // fewer texels than one layer over everything at the nearest point's density
    const one = drapeLayers({ ...cam, pitchDeg: 0 }, box, ORIGIN, roomy);
    expect(one).toHaveLength(1);
    const single = (far.view.widthPx / far.view.pxPerUm) * (far.view.heightPx / far.view.pxPerUm) * near.needPxPerUm ** 2;
    expect(drapeTexels(layers.map((l) => l.view))).toBeLessThan(single / 2);
    // The near layer lies within the far one.
    const [cx, cy] = layerClip(far.view, near.view.centreX - ORIGIN.x, near.view.centreY - ORIGIN.y);
    expect(Math.abs(cx)).toBeLessThan(1);
    expect(Math.abs(cy)).toBeLessThan(1);
    // Ground just beyond the bottom edge of the screen is in the near layer.
    const f = cameraFrame(cam);
    const p = (55 * Math.PI) / 180;
    const nearY = f.eye[1] + f.eye[2] * Math.tan(p - (35 * Math.PI) / 360) + 100;
    const [nx, ny] = layerClip(near.view, 0, nearY);
    expect(Math.abs(nx)).toBeLessThan(1);
    expect(Math.abs(ny)).toBeLessThan(1);
    // Every on-screen ground point is drawn at least at the density the screen needs there.
    const m = f.matrix;
    for (let i = 0; i <= 20; i++)
      for (let j = 0; j <= 20; j++) {
        const x = box.minX + ((box.maxX - box.minX) * i) / 20, y = box.minY + ((box.maxY - box.minY) * j) / 20;
        const [qx, qy, , w] = transform(m, x, y, 0);
        if (w <= 0 || Math.abs(qx) > w || Math.abs(qy) > w) continue;
        const depth = (x - f.eye[0]) * f.forward[0] + (y - f.eye[1]) * f.forward[1] - f.eye[2] * f.forward[2];
        const layer = layers.find(({ view }) => {
          const [lx, ly] = layerClip(view, x, y);
          return Math.abs(lx) <= 1 && Math.abs(ly) <= 1;
        })!;
        expect(layer.view.pxPerUm).toBeGreaterThanOrEqual((f.focalPx / depth) * (1 - 1e-9));
      }
  });

  it("scales both layers down together under the cap", () => {
    const box: Box3 = { minX: -400_000, maxX: 400_000, minY: -300_000, maxY: 300_000, minZ: 0, maxZ: 20_000 };
    const cam = camera({ target: { x: 0, y: 0, z: 0 }, pitchDeg: 60, widthPx: 1081, heightPx: 2402 }, 0.05);
    const free = drapeLayers(cam, box, ORIGIN, roomy);
    const capped = drapeLayers(cam, box, ORIGIN, { maxSide: 4096, maxPixels: 2e6 });
    expect(capped.map((l) => l.role)).toEqual(["near", "far"]);
    expect(drapeTexels(capped.map((l) => l.view))).toBeLessThanOrEqual(2e6);
    const ratio = (l: (typeof capped)[number]) => l.view.pxPerUm / l.needPxPerUm;
    expect(ratio(capped[0])).toBeLessThan(1);
    expect(ratio(capped[0])).toBeCloseTo(ratio(capped[1]), 1);
    expect(capped[1].needPxPerUm).toBeCloseTo(free[1].needPxPerUm, 12);
  });

  it("keeps one layer when the depth range is narrow", () => {
    const box: Box3 = { minX: -400_000, maxX: 400_000, minY: -300_000, maxY: 300_000, minZ: 0, maxZ: 0 };
    const layers = drapeLayers(camera({ target: { x: 0, y: 0, z: 0 }, pitchDeg: 10 }), box, ORIGIN, roomy);
    expect(layers).toHaveLength(1);
    expect(DRAPE_SPLIT_RATIO).toBe(2);
  });

  it("puts the texels on the pixels at pitch 0 where the field's edge clips the layer off the screen's centre", () => {
    // the field ends 10 000 µm east of the target: the rectangle is clipped there, asymmetrically
    const box: Box3 = { minX: -60_000, maxX: 22_000, minY: -40_000, maxY: 30_000, minZ: 0, maxZ: 0 };
    for (const bearingDeg of [0, 90]) {
      const cam = camera({ bearingDeg, widthPx: 1280, heightPx: 800 }, 0.02);
      const [{ view }] = drapeLayers(cam, box, ORIGIN, roomy);
      const view2d = { centreX: 12_000 + ORIGIN.x, centreY: -4_000 + ORIGIN.y, pxPerUm: 0.02, widthPx: 1280, heightPx: 800, rotationDeg: bearingDeg };
      // a screen pixel's centre is a texel's centre: its texel coordinate has fraction ½
      for (const [px, py] of [[100.5, 200.5], [640.5, 400.5], [900.5, 50.5]]) {
        const m = viewMatrix(view2d, ORIGIN.x, ORIGIN.y);
        const a = m[0], b = m[4], c = m[1], d = m[5], det = a * d - b * c;
        const cx = (px / 1280) * 2 - 1 - m[12], cy = (py / 800) * 2 - 1 - m[13];
        const x = (d * cx - b * cy) / det, y = (a * cy - c * cx) / det;
        const [lx, ly] = layerClip(view, x, y);
        const tx = ((lx + 1) / 2) * view.widthPx, ty = ((ly + 1) / 2) * view.heightPx;
        expect(Math.abs((tx % 1) - 0.5)).toBeLessThan(1e-3);
        expect(Math.abs((ty % 1) - 0.5)).toBeLessThan(1e-3);
      }
    }
  });

  it("terminates at a tiny texel allowance", () => {
    const layers = drapeLayers(camera({ pitchDeg: 60 }), big, ORIGIN, { maxSide: 4096, maxPixels: 3 });
    expect(layers.length).toBeGreaterThan(0);
    for (const { view } of layers) expect(view.widthPx * view.heightPx).toBeLessThanOrEqual(4);
  });

  it("keeps one layer at pitch 0 even when capped", () => {
    const layers = drapeLayers(camera(), big, ORIGIN, { maxSide: 4096, maxPixels: 300_000 });
    expect(layers).toHaveLength(1);
    expect(layers[0].view.pxPerUm).toBeLessThan(0.01);
    expect(drapeTexels([layers[0].view])).toBeLessThanOrEqual(300_000);
  });
});

describe("drapeTiles (map-rendering.md §5.6 \"Rendering the drape\")", () => {
  it("partitions the layer and draws each texel where the layer's matrix puts it", () => {
    const view = { centreX: 1_030_000, centreY: -190_000, pxPerUm: 0.037, widthPx: 2500, heightPx: 1300, rotationDeg: 37 };
    const tiles = drapeTiles(view, 1024);
    expect(tiles).toHaveLength(3 * 2);
    expect(tiles.reduce((n, t) => n + t.view.widthPx * t.view.heightPx, 0)).toBe(2500 * 1300);
    const rand = seededRandom(5);
    for (const t of tiles) {
      for (let i = 0; i < 10; i++) {
        // a point inside the tile, in layer texels → model
        const lx = t.x + rand() * t.view.widthPx, ly = t.y + rand() * t.view.heightPx;
        const m = viewMatrix(view, ORIGIN.x, ORIGIN.y), mt = viewMatrix(t.view, ORIGIN.x, ORIGIN.y);
        // invert the layer's 2D affine map for the point
        const a = m[0], b = m[4], c = m[1], d = m[5];
        const cx = (lx / view.widthPx) * 2 - 1 - m[12], cy = (ly / view.heightPx) * 2 - 1 - m[13];
        const det = a * d - b * c;
        const x = (d * cx - b * cy) / det, y = (a * cy - c * cx) / det;
        const tx = ((mt[0] * x + mt[4] * y + mt[12] + 1) / 2) * t.view.widthPx, ty = ((mt[1] * x + mt[5] * y + mt[13] + 1) / 2) * t.view.heightPx;
        expect(tx + t.x).toBeCloseTo(lx, 2);
        expect(ty + t.y).toBeCloseTo(ly, 2);
      }
    }
  });
});
