/**
 * Steep ground without cliffs: finds patches of the height field that are
 * as steep as the map's cliffs but have none drawn, and draws a short
 * tagged cliff along the top of each, tags downhill.
 *
 * Called by `enrich-ocad.mjs`. Field: paper mm, y up; output in OCAD units
 * (0.01 mm). Measured on the o-kartan map's 2 m ground model: the drawn
 * lidar cliffs sit on slopes of 0.3–0.55 m/m, the map's 98th percentile is
 * 0.64 m/m, so a patch seeds at 0.8 m/m.
 */

import { HEIGHT_NO_DATA } from "@oxygen/shared/src/terrain/field/read.js";

const SEED_SLOPE = 0.8; // m per m (~39°): a patch starts here (top 1–2 % of the map)
const GROW_SLOPE = 0.62; // and grows over cells this steep
const MIN_CELLS = 5;
const RUN_SLOPE = 0.7; // bins along the patch at least this steep make a run
const MIN_LEN_MM = 0.8;
const MAX_LEN_MM = 2.6;
const BIN_MM = 0.3;
const IMPASSABLE_SLOPE = 1.3; // a piece this steep somewhere, and long enough, is impassable
const IMPASSABLE_MIN_MM = 0.9;
const PIECE_MM = [0.9, 2.4]; // a steep run is drawn as broken pieces of this length…
const GAP_MM = [0.4, 1.3]; // …with gaps like this, as the lidar cliffs are
const MAX_SKEW = (35 * Math.PI) / 180; // a piece must follow the contours this closely

/**
 * @param f HeightField
 * @param ok (xUnits, yUnits) => boolean: may a cliff go here
 * @param tagsLeft whether the renderer puts tags left of the direction
 */
export function steepCliffs(f, { ok, tagsLeft, rng, groundMPerMm = 15 }) {
  const { width: W, height: H, cellMm, x0, y0, zScaleM } = f.header;
  const z = (cx, cy) => {
    const v = f.z[cy * W + cx];
    return v === HEIGHT_NO_DATA || v === undefined ? null : v * zScaleM;
  };
  const centre = (cx, cy) => [x0 + (cx + 0.5) * cellMm, y0 + (cy + 0.5) * cellMm];
  const slope = new Float32Array(W * H).fill(-1);
  const gx = new Float32Array(W * H), gy = new Float32Array(W * H);
  const run = 2 * cellMm * groundMPerMm;
  for (let cy = 1; cy < H - 1; cy++)
    for (let cx = 1; cx < W - 1; cx++) {
      const a = z(cx + 1, cy), b = z(cx - 1, cy), c = z(cx, cy + 1), d = z(cx, cy - 1);
      if (a == null || b == null || c == null || d == null) continue;
      const i = cy * W + cx;
      gx[i] = (a - b) / run;
      gy[i] = (c - d) / run;
      slope[i] = Math.hypot(gx[i], gy[i]);
    }
  const okCache = new Int8Array(W * H); // 0 unknown, 1 ok, 2 not
  const okAt = (i) => {
    if (!okCache[i]) {
      const [x, y] = centre(i % W, Math.floor(i / W));
      okCache[i] = ok(Math.round(x * 100), Math.round(y * 100)) ? 1 : 2;
    }
    return okCache[i] === 1;
  };
  const seen = new Uint8Array(W * H);
  const lines = [];
  const stats = { patches: 0, small: 0, drawn: 0, impassable: 0 };
  for (let i = 0; i < W * H; i++) {
    if (seen[i] || slope[i] < SEED_SLOPE || !okAt(i)) continue;
    // grow the patch
    const cells = [];
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop();
      cells.push(j);
      const cx = j % W, cy = Math.floor(j / W);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const k = ny * W + nx;
          if (seen[k] || slope[k] < GROW_SLOPE || !okAt(k)) continue;
          seen[k] = 1;
          stack.push(k);
        }
    }
    stats.patches++;
    if (cells.length < MIN_CELLS) { stats.small++; continue; }
    // mean uphill direction
    let ux = 0, uy = 0, maxS = 0;
    for (const j of cells) (ux += gx[j]), (uy += gy[j]), (maxS = Math.max(maxS, slope[j]));
    const un = Math.hypot(ux, uy) || 1;
    (ux /= un), (uy /= un);
    const ax = -uy, ay = ux; // along the slope
    const pts = cells.map((j) => centre(j % W, Math.floor(j / W)));
    const t = pts.map(([x, y]) => x * ax + y * ay);
    const tMin = Math.min(...t), tMax = Math.max(...t);
    let total = tMax - tMin + cellMm;
    if (total < MIN_LEN_MM) { stats.small++; continue; }
    // Steep runs along the patch (bins whose steepest cell seeds), cut into broken pieces.
    const nb = Math.ceil((tMax - tMin) / BIN_MM) + 1;
    const binMax = new Float32Array(nb);
    cells.forEach((j, k) => { const b = Math.floor((t[k] - tMin) / BIN_MM); binMax[b] = Math.max(binMax[b], slope[j]); });
    const pieces = [];
    let b = 0;
    while (b < nb) {
      if (binMax[b] < RUN_SLOPE) { b++; continue; }
      let e = b, peak = binMax[b];
      while (e + 1 < nb && binMax[e + 1] >= RUN_SLOPE) peak = Math.max(peak, binMax[++e]);
      const start = tMin + b * BIN_MM - BIN_MM / 2;
      const end = tMin + e * BIN_MM + BIN_MM / 2;
      b = e + 1;
      if (peak < SEED_SLOPE || end - start < MIN_LEN_MM) continue;
      let s = start + rng.uniform(0, 0.3);
      while (end - s >= MIN_LEN_MM) {
        const L = Math.min(end - s, rng.uniform(PIECE_MM[0], PIECE_MM[1]));
        pieces.push([s, s + L]);
        s += L + rng.uniform(GAP_MM[0], GAP_MM[1]);
      }
    }
    for (const [s0, s1] of pieces) {
      const poly = [];
      for (let b = s0; b <= s1 + 1e-6; b += BIN_MM) {
        const inBin = pts.filter((_, k) => t[k] >= b - BIN_MM / 2 && t[k] < b + BIN_MM / 2);
        if (!inBin.length) continue;
        // the top of the steep band: 75th percentile uphill
        const u = inBin.map(([x, y]) => x * ux + y * uy).sort((p, q) => p - q);
        const up = u[Math.floor(u.length * 0.75)];
        poly.push([b * ax + up * ux, b * ay + up * uy]);
      }
      if (poly.length < 2) {
        // one bin: a short straight piece across it
        const c = poly[0] ?? [pts[0][0], pts[0][1]];
        const half = Math.max(MIN_LEN_MM, s1 - s0) / 2;
        poly.splice(0, poly.length, [c[0] - ax * half, c[1] - ay * half], [c[0] + ax * half, c[1] + ay * half]);
      }
      // smooth interior points
      const sm = poly.map((p, k) => (k === 0 || k === poly.length - 1 ? p : [(poly[k - 1][0] + 2 * p[0] + poly[k + 1][0]) / 4, (poly[k - 1][1] + 2 * p[1] + poly[k + 1][1]) / 4]));
      // tags downhill: downhill is -u; the right normal of direction a is (ay, -ax)
      const rightIsDown = ay * -ux + -ax * -uy > 0;
      const forward = tagsLeft ? !rightIsDown : rightIsDown;
      const ordered = forward ? sm : [...sm].reverse();
      const lenMm = s1 - s0 + cellMm;
      // Every vertex and midpoint must be allowed, and each segment must run along the slope.
      const out = ordered.map(([x, y]) => [Math.round(x * 100), Math.round(y * 100)]);
      let bad = false, pieceMax = 0;
      for (let k = 0; k < ordered.length && !bad; k++) {
        const [x, y] = ordered[k];
        if (!ok(out[k][0], out[k][1])) bad = true;
        const cx = Math.floor((x - x0) / cellMm), cy = Math.floor((y - y0) / cellMm);
        const j = cy * W + cx;
        if (j >= 0 && j < W * H) pieceMax = Math.max(pieceMax, slope[j]);
        if (k + 1 < ordered.length) {
          const [x2, y2] = ordered[k + 1];
          if (!ok(Math.round(((x + x2) / 2) * 100), Math.round(((y + y2) / 2) * 100))) bad = true;
          const mj = Math.floor(((y + y2) / 2 - y0) / cellMm) * W + Math.floor(((x + x2) / 2 - x0) / cellMm);
          const gxx = gx[mj] ?? 0, gyy = gy[mj] ?? 0;
          if (Math.hypot(gxx, gyy) > 0.1) {
            const along = Math.abs((x2 - x) * gxx + (y2 - y) * gyy) / (Math.hypot(x2 - x, y2 - y) * Math.hypot(gxx, gyy) || 1);
            if (Math.asin(Math.min(1, along)) > MAX_SKEW) bad = true;
          }
        }
      }
      if (bad) { stats.rejected = (stats.rejected ?? 0) + 1; continue; }
      const impassable = pieceMax >= IMPASSABLE_SLOPE && lenMm >= IMPASSABLE_MIN_MM;
      lines.push({ sym: impassable ? 201000 : 202002, pts: out, dropM: pieceMax, steep: true });
      stats.drawn++;
      if (impassable) stats.impassable++;
    }
  }
  return { lines, stats };
}
