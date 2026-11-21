/**
 * Cliff tags: the map's cliffs (ISOM 201 top line, 202) are lidar-made
 * chains of short (~0.6 mm) segments with no tags. This joins segments
 * that continue each other into one line, and gives a chain the tagged
 * symbol (201.000 / 202.002) when it is long enough, sits in steep, busy
 * relief, and the height field says clearly which side is downhill. The
 * line is oriented so the tags point downhill. The joined segments are
 * marked deleted in the index; the new line is appended.
 *
 * Called by `enrich-ocad.mjs`. Units: OCAD paper units (0.01 mm, y up). Heights from a HeightField
 * (paper mm, y up) via `sampleHeight`.
 */

const FROM_TO = new Map([
  [201003, 201000], // impassable cliff top line -> impassable cliff with tags
  [202000, 202002], // cliff -> cliff with tags
]);
// Joining: impassable cliffs only across near-touching gaps and up to 2.5 mm, so they stay short.
const JOIN = new Map([
  [201003, { gap: 30, maxLen: 250 }],
  [202000, { gap: 85, maxLen: 600 }],
]);
const MAX_TURN = (60 * Math.PI) / 180;
const MIN_LEN = 100; // 1 mm of line before it gets tags
const PROBE = 70; // sample heights 0.7 mm either side
const MIN_DROP_M = 1.5; // mean height difference across the line
const MIN_AGREE = 0.75; // share of probes that agree on the downhill side

/** Every live object of the given symbols, read straight from the index. */
export function readObjects(file, syms) {
  const out = [];
  let block = file.readInt32LE(12);
  while (block) {
    for (let i = 0; i < 256; i++) {
      const e = block + 4 + i * 40;
      const pos = file.readInt32LE(e + 16);
      const sym = file.readInt32LE(e + 24);
      const status = file.readUInt8(e + 30);
      if (!pos || status !== 1 || !syms.has(sym)) continue;
      const n = file.readInt32LE(pos + 44);
      const pts = [];
      for (let k = 0; k < n; k++) {
        const xr = file.readInt32LE(pos + 56 + k * 8), yr = file.readInt32LE(pos + 60 + k * 8);
        // skip Bézier control points; the chain becomes a polyline
        if (xr & 3) continue;
        pts.push([xr >> 8, yr >> 8]);
      }
      if (pts.length >= 2) out.push({ entry: e, sym, pts });
    }
    block = file.readInt32LE(block);
  }
  return out;
}

const len = (pts) => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);
const dir = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]);
const turn = (a, b) => Math.abs(((b - a + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);

/** Join segments of one symbol into chains of continuing segments. */
function chain(objs, { gap: GAP, maxLen }) {
  const CELL = 100;
  const grid = new Map();
  const k = (x, y) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
  objs.forEach((o, i) => {
    for (const end of [0, 1]) {
      const p = end ? o.pts.at(-1) : o.pts[0];
      const key = k(p[0], p[1]);
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push([i, end]);
    }
  });
  const used = new Array(objs.length).fill(false);
  // Best continuation of a chain end at p heading `heading`: [index, reversed]
  const next = (p, heading) => {
    let best = null, bestScore = Infinity;
    for (let gx = Math.floor((p[0] - GAP) / CELL); gx <= Math.floor((p[0] + GAP) / CELL); gx++)
      for (let gy = Math.floor((p[1] - GAP) / CELL); gy <= Math.floor((p[1] + GAP) / CELL); gy++)
        for (const [i, end] of grid.get(`${gx},${gy}`) ?? []) {
          if (used[i]) continue;
          const pts = end ? [...objs[i].pts].reverse() : objs[i].pts;
          const d = Math.hypot(pts[0][0] - p[0], pts[0][1] - p[1]);
          if (d > GAP) continue;
          const t1 = d > 5 ? turn(heading, dir(p, pts[0])) * (d > 40 ? 1.6 : 1) : 0;
          const t2 = turn(heading, dir(pts[0], pts[1]));
          if (t1 > MAX_TURN || t2 > MAX_TURN) continue;
          const score = d + 40 * (t1 + t2);
          if (score < bestScore) (bestScore = score), (best = [i, pts]);
        }
    return best;
  };
  const chains = [];
  for (let s = 0; s < objs.length; s++) {
    if (used[s]) continue;
    used[s] = true;
    let pts = [...objs[s].pts];
    const members = [s];
    for (const backwards of [false, true]) {
      if (backwards) pts.reverse();
      for (;;) {
        if (len(pts) >= maxLen) break;
        const n = next(pts.at(-1), dir(pts.at(-2), pts.at(-1)));
        if (!n) break;
        used[n[0]] = true;
        members.push(n[0]);
        pts = pts.concat(n[1]);
      }
    }
    chains.push({ members, pts });
  }
  return chains;
}

/**
 * @param file the OCAD bytes
 * @param heightAt (xUnits, yUnits) => metres | null
 * @param busy (xUnits, yUnits) => contour length within 3 mm, units
 * @param minBusy busy threshold
 * @param tagsLeft true when the renderer puts tags left of the line's direction
 */
export function cliffTags(file, { heightAt, busy, minBusy, tagsLeft }) {
  const objs = readObjects(file, new Set(FROM_TO.keys()));
  const deleted = [];
  const lines = [];
  const stats = { segments: objs.length, chains: 0, long: 0, busy: 0, tagged: 0, unclear: 0 };
  for (const sym of FROM_TO.keys()) {
    const mine = objs.filter((o) => o.sym === sym);
    for (const c of chain(mine, JOIN.get(sym))) {
      stats.chains++;
      const L = len(c.pts);
      if (L < MIN_LEN) continue;
      stats.long++;
      const mid = c.pts[Math.floor(c.pts.length / 2)];
      if (busy(mid[0], mid[1]) < minBusy) continue;
      stats.busy++;
      // Downhill side: probe across the line at every vertex.
      let sum = 0, n = 0, left = 0;
      for (let i = 0; i < c.pts.length; i++) {
        const a = c.pts[Math.max(0, i - 1)], b = c.pts[Math.min(c.pts.length - 1, i + 1)];
        const h = dir(a, b);
        const nx = -Math.sin(h), ny = Math.cos(h); // left normal
        const [x, y] = c.pts[i];
        const zl = heightAt(x + nx * PROBE, y + ny * PROBE), zr = heightAt(x - nx * PROBE, y - ny * PROBE);
        if (zl == null || zr == null) continue;
        const d = zr - zl; // > 0: left side lower
        sum += d;
        n++;
        if (d > 0) left++;
      }
      if (n < 2) { stats.unclear++; continue; }
      const mean = sum / n, agree = Math.max(left, n - left) / n;
      if (Math.abs(mean) < MIN_DROP_M || agree < MIN_AGREE) { stats.unclear++; continue; }
      const downhillLeft = mean > 0;
      const pts = downhillLeft === tagsLeft ? c.pts : [...c.pts].reverse();
      // drop consecutive duplicates
      const clean = pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]);
      lines.push({ sym: FROM_TO.get(sym), pts: clean, dropM: Math.abs(mean) });
      for (const m of c.members) deleted.push(mine[m].entry);
      stats.tagged++;
    }
  }
  return { deleted, lines, stats };
}
