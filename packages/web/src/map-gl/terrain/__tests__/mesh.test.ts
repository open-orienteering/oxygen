import { describe, expect, it } from "vitest";
import { HEIGHT_NO_DATA } from "@oxygen/shared/src/terrain/field/read.js";
import { cameraFrame, distanceForPxPerUm, type TerrainCamera } from "../camera";
import {
  CHUNK,
  LEVELS,
  boxInFrustum,
  buildTerrainMesh,
  chunkBox,
  chunkGeometry,
  chunkLevel,
  chunkVertex,
  levelTriangles,
  meshBox,
  meshHeights,
  selectChunks,
  zUnitUm,
} from "../mesh";
import { coneField, fieldFromGrid, noiseField } from "../synthetic";

describe("chunk geometry (map-rendering.md §5.6 \"Mesh and level of detail\")", () => {
  const g = chunkGeometry();
  const SIDE = CHUNK + 1;
  const vertexCount = g.vertices.length / 3;
  const pos = (k: number) => [g.vertices[k * 3], g.vertices[k * 3 + 1], g.vertices[k * 3 + 2]];

  it("has 65 × 65 grid vertices and a 256-vertex skirt ring", () => {
    expect(vertexCount).toBe(SIDE * SIDE + 4 * CHUNK);
    for (let k = SIDE * SIDE; k < vertexCount; k++) {
      const [i, j, s] = pos(k);
      expect(s).toBe(1);
      expect(i === 0 || j === 0 || i === CHUNK || j === CHUNK).toBe(true);
    }
  });

  it("covers every quad exactly once at every level, counter-clockwise, with 4·(64 / 2^l) skirt quads", () => {
    for (let l = 0; l < LEVELS; l++) {
      const { first, count } = g.levels[l];
      expect(count).toBe(levelTriangles(l) * 3);
      const cover = new Uint8Array(CHUNK * CHUNK);
      let area = 0, skirts = 0;
      for (let t = first; t < first + count; t += 3) {
        const idx = [g.indices[t], g.indices[t + 1], g.indices[t + 2]];
        for (const k of idx) expect(k).toBeLessThan(vertexCount);
        const [a, b, c] = idx.map(pos);
        if (a[2] || b[2] || c[2]) {
          skirts++;
          continue;
        }
        const s = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
        expect(s).toBeGreaterThan(0);
        area += s / 2;
        // unit-cell centres inside the triangle
        const inside = (px: number, py: number) => {
          const e = (p: number[], q: number[]) => (q[0] - p[0]) * (py - p[1]) - (px - p[0]) * (q[1] - p[1]);
          return e(a, b) > 0 && e(b, c) > 0 && e(c, a) > 0;
        };
        for (let y = Math.min(a[1], b[1], c[1]); y < Math.max(a[1], b[1], c[1]); y++)
          for (let x = Math.min(a[0], b[0], c[0]); x < Math.max(a[0], b[0], c[0]); x++) if (inside(x + 0.5, y + 0.37)) cover[y * CHUNK + x]++;
      }
      expect(area).toBe(CHUNK * CHUNK);
      expect(cover.every((n) => n === 1)).toBe(true);
      expect(skirts).toBe(2 * 4 * (CHUNK >> l));
    }
  });
});

describe("meshHeights and the mesh (§5.6 \"Units\", \"No-data\")", () => {
  it("fills no-data from the nearest data cell without touching the field", () => {
    const f = fieldFromGrid(6, 4, (cx, cy) => (cx >= 4 ? NaN : 10 * cx + cy));
    const before = Int16Array.from(f.z);
    const h = meshHeights(f);
    expect(f.z).toEqual(before);
    for (let cy = 0; cy < 4; cy++) {
      expect(h[cy * 6 + 4]).toBe(f.z[cy * 6 + 3]);
      expect(h[cy * 6 + 5]).toBe(f.z[cy * 6 + 3]);
    }
    expect(h.includes(HEIGHT_NO_DATA)).toBe(false);
  });

  it("is flat at 0 when nothing has data", () => {
    const f = fieldFromGrid(5, 5, () => NaN);
    const m = buildTerrainMesh(f);
    expect([...m.heights].every((v) => v === 0)).toBe(true);
    expect(meshBox(m, 3).maxZ).toBe(0);
  });

  it("places vertices at cell centres in origin-relative paper µm, z through the map scale", () => {
    const f = coneField();
    const origin = { x: 25_000, y: 30_000 };
    const m = buildTerrainMesh(f, origin);
    expect(m.x0Um).toBeCloseTo(10_100 - 25_000, 9);
    expect(m.y0Um).toBeCloseTo(20_100 - 30_000, 9);
    // 1 unit = 5/64 m; 1 m at 1:15 000 = 1/15 mm = 66.7 µm
    expect(zUnitUm(f.header, 1)).toBeCloseTo((5 / 64) * (1000 / 15), 9);
    expect(zUnitUm(f.header, 2)).toBeCloseTo(2 * zUnitUm(f.header, 1), 9);
    const apex = m.chunks.find((c) => c.ix0 <= 80 && c.ix0 + CHUNK > 80 && c.iy0 <= 80 && c.iy0 + CHUNK > 80)!;
    const [x, y, z] = chunkVertex(m, apex, 80 - apex.ix0, 80 - apex.iy0, false, 1);
    expect(x + origin.x).toBeCloseTo(10_000 + 80.5 * 200, 6);
    expect(y + origin.y).toBeCloseTo(20_000 + 80.5 * 200, 6);
    // 45 m → 3000 µm, within one unit of quantisation
    expect(Math.abs(z - 3000)).toBeLessThan(zUnitUm(f.header, 1));
    expect(m.zBaseM).toBe(0);
  });

  it("clamps a partial edge chunk to the grid", () => {
    const f = fieldFromGrid(100, 70, (cx, cy) => cx + cy);
    const m = buildTerrainMesh(f);
    expect(m.chunksX).toBe(2);
    expect(m.chunksY).toBe(2);
    const last = m.chunks[3];
    const box = meshBox(m, 1);
    for (const [i, j] of [[0, 0], [CHUNK, CHUNK], [CHUNK, 0], [10, CHUNK]]) {
      const [x, y] = chunkVertex(m, last, i, j, false, 1);
      expect(x).toBeLessThanOrEqual(box.maxX);
      expect(y).toBeLessThanOrEqual(box.maxY);
    }
    expect(chunkVertex(m, last, CHUNK, CHUNK, false, 1)[0]).toBe(m.x0Um + 99 * m.cellUm);
  });
});

describe("level of detail (§5.6)", () => {
  it("chunkLevel: 0 at the eye, monotone in distance, capped, quad edge ≤ lodPx", () => {
    expect(chunkLevel(0, 200, 1000)).toBe(0);
    let prev = 0;
    for (let d = 1_000; d < 1e9; d *= 1.3) {
      const l = chunkLevel(d, 200, 1000, 8);
      expect(l).toBeGreaterThanOrEqual(prev);
      expect(l).toBeLessThan(LEVELS);
      if (l > 0 && l < LEVELS - 1) expect(((1 << l) * 200 * 1000) / d).toBeLessThanOrEqual(8);
      prev = l;
    }
    expect(prev).toBe(LEVELS - 1);
  });

  it("culls chunks outside the frustum and keeps one straddling its edge", () => {
    const f = fieldFromGrid(64 * 8 + 1, 64 * 8 + 1, () => 0, { cellMm: 0.2 });
    const m = buildTerrainMesh(f);
    // a 2D-like view of the lower-left chunk only
    const cam: TerrainCamera = { target: { x: m.x0Um + 32 * m.cellUm, y: m.y0Um + 32 * m.cellUm, z: 0 }, distanceUm: 0, bearingDeg: 0, pitchDeg: 0, widthPx: 400, heightPx: 400 };
    cam.distanceUm = distanceForPxPerUm(cam, 400 / (80 * m.cellUm));
    const frame = cameraFrame(cam, meshBox(m, 1));
    const sel = selectChunks(m, frame, { exaggeration: 1 });
    // the view spans 80 cells round the first chunk's centre: chunks (0,0), (1,0), (0,1), (1,1)
    expect(sel.stats.chunks).toBe(4);
    expect(sel.stats.culled).toBe(60);
    expect(boxInFrustum(frame.matrix, chunkBox(m, m.chunks[1], 1))).toBe(true);
    expect(boxInFrustum(frame.matrix, chunkBox(m, m.chunks[2], 1))).toBe(false);
    // zoomed out so nothing is culled, bearing 120 picks the same levels as bearing 0
    const all = meshBox(m, 1);
    const wide = { ...cam, target: { x: (all.minX + all.maxX) / 2, y: (all.minY + all.maxY) / 2, z: 0 } };
    wide.distanceUm = distanceForPxPerUm(cam, 400 / (1.5 * Math.hypot(all.maxX - all.minX, all.maxY - all.minY)));
    const north = selectChunks(m, cameraFrame(wide, meshBox(m, 1)), { exaggeration: 1 });
    const turned = selectChunks(m, cameraFrame({ ...wide, bearingDeg: 120 }, meshBox(m, 1)), { exaggeration: 1 });
    expect(north.stats.culled).toBe(0);
    expect(turned.stats.culled).toBe(0);
    expect(turned.stats.perLevel).toEqual(north.stats.perLevel);
    // tilted, the near chunks are finer than the far ones
    const tilted = selectChunks(m, cameraFrame({ ...wide, pitchDeg: 70, distanceUm: wide.distanceUm / 4 }, all), { exaggeration: 1 });
    expect(tilted.stats.perLevel.filter((n) => n > 0).length).toBeGreaterThan(1);
  });

  it("closes cracks: every gap between neighbours of different levels lies over a skirt", () => {
    const f = noiseField(4 * CHUNK + 1, 3 * CHUNK + 1, 11, 60);
    const m = buildTerrainMesh(f);
    const at = (gx: number, gy: number) => m.heights[gy * m.width + gx];
    for (let la = 0; la < LEVELS; la++)
      for (let lb = la + 1; lb < LEVELS; lb++)
        for (let cy = 0; cy < m.chunksY; cy++)
          for (let cx = 0; cx + 1 < m.chunksX; cx++) {
            // fine chunk A left of coarse chunk B, sharing the column gx
            const A = m.chunks[cy * m.chunksX + cx], B = m.chunks[cy * m.chunksX + cx + 1];
            const gx = B.ix0, s = 1 << lb;
            for (let j = 0; j <= CHUNK; j += 1 << la) {
              const gy = A.iy0 + j;
              const k = Math.floor(j / s) * s, f0 = (j - k) / s;
              const hc = f0 === 0 ? at(gx, A.iy0 + k) : at(gx, A.iy0 + k) * (1 - f0) + at(gx, A.iy0 + Math.min(k + s, CHUNK)) * f0;
              const hf = at(gx, gy);
              if (hf >= hc) expect(A.zMin).toBeLessThanOrEqual(hc);
              else expect(B.zMin).toBeLessThanOrEqual(hf);
            }
          }
  });

  it("keeps a 4096² field within 600 000 triangles at 1920 × 1080 (overview, 60° tilt, close-up)", () => {
    const N = 4096;
    const f = fieldFromGrid(N, N, (cx, cy) => 40 * Math.sin(cx / 150) * Math.cos(cy / 170) + 40, { cellMm: 0.2 });
    const m = buildTerrainMesh(f);
    const box = meshBox(m, 2);
    const centre = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2, z: 0 };
    const cam: TerrainCamera = { target: centre, distanceUm: 0, bearingDeg: 0, pitchDeg: 0, widthPx: 1920, heightPx: 1080 };
    const fit = 1080 / (box.maxY - box.minY);
    const cams: Record<string, TerrainCamera> = {
      overview: { ...cam, distanceUm: distanceForPxPerUm(cam, fit) },
      tilt60: { ...cam, pitchDeg: 60, distanceUm: distanceForPxPerUm(cam, fit * 2) },
      closeUp: { ...cam, pitchDeg: 45, distanceUm: distanceForPxPerUm(cam, 4 / m.cellUm) },
    };
    const measured: Record<string, number> = {};
    for (const [name, c] of Object.entries(cams)) {
      const sel = selectChunks(m, cameraFrame(c, box), { exaggeration: 2 });
      measured[name] = sel.stats.triangles;
      expect(sel.stats.triangles).toBeLessThanOrEqual(600_000);
      expect(sel.stats.perLevel.filter((n) => n > 0).length).toBeLessThanOrEqual(LEVELS);
    }
    // the numbers §5.6 records
    expect(measured).toMatchSnapshot();
  });
});
