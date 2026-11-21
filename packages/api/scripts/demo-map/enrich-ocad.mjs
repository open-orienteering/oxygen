/**
 * The demo map's invented detail (docs/ops/demo-map.md): adds terrain-
 * plausible features to an OCAD 12+ map, seeded and rerunnable.
 *
 * - Point features: boulders (ISOM 204), large boulders (205), boulder
 *   clusters (207), knolls (109, 110), depressions (111) and pits (112),
 *   leaning toward cliffs, bare rock and relief, kept out of water, marsh,
 *   open land, paved and built-up areas, off lines and apart.
 * - With a height field: tags on the map's lidar cliffs (`cliff-tags.mjs`)
 *   and short tagged cliffs on steep ground that has none
 *   (`steep-cliffs.mjs`), tags downhill.
 *
 * The input is never changed in place: the output is the input's bytes,
 * with the joined cliff segments marked deleted in the object index and
 * new object index blocks and records appended.
 *
 * Units: OCAD paper units, 0.01 mm, y up.
 */
import { readOcad } from "ocad2geojson";
import { sampleHeight } from "@oxygen/shared/src/terrain/field/read.js";
import { PyRandom } from "../../../../scripts/lib/py-random.mjs";
import { cliffTags } from "./cliff-tags.mjs";
import { steepCliffs } from "./steep-cliffs.mjs";

export const DEMO_SEED = 1056;
/** A cliff gets tags only where this much contour (0.01 mm) lies within 3 mm. */
const MIN_BUSY = 2500;

const MM = 100;
const code = (sym) => sym / 1000; // 204000 -> 204, 101005 -> 101.005
const major = (sym) => Math.floor(sym / 1000);

// Where nothing invented may go (ISOM 2017-2): water, marsh, open land
// (lawns, fields), paved areas, out-of-bounds, buildings.
const FORBID = new Set([301, 302, 307, 308, 310, 401, 402, 412, 413, 501, 520, 521, 522]);
const ROUGH_OPEN = new Set([403, 404]); // allowed, but sparser
const CONTOURS = new Set([101, 102, 103]);

/** Per symbol: target count, how candidates are drawn, clearances (0.01 mm). */
export const PLAN = [
  // [sym, count, mix: share near cliffs / near bare rock / near contours (rest uniform), clearLine, clearContour, clearPoint]
  { sym: 205000, count: 35, mix: [0.35, 0.15, 0.1], clearLine: 60, clearContour: 45, clearPoint: 150 },
  { sym: 207000, count: 20, mix: [0.4, 0.15, 0.05], clearLine: 70, clearContour: 50, clearPoint: 160 },
  { sym: 204000, count: 300, mix: [0.3, 0.15, 0.2], clearLine: 45, clearContour: 35, clearPoint: 110, satellites: 0.3 },
  { sym: 109000, count: 60, mix: [0.1, 0.05, 0.7], clearLine: 55, clearContour: 60, clearPoint: 150 },
  { sym: 110000, count: 20, mix: [0.05, 0.0, 0.8], clearLine: 65, clearContour: 65, clearPoint: 170, alignToContour: true },
  { sym: 111000, count: 30, mix: [0.1, 0.0, 0.7], clearLine: 55, clearContour: 60, clearPoint: 150, noBareRock: true },
  { sym: 112000, count: 20, mix: [0.2, 0.0, 0.5], clearLine: 55, clearContour: 50, clearPoint: 150, noBareRock: true },
];

/**
 * @param {Buffer} file the OCAD map
 * @param {{ seed?: number, field?: import("@oxygen/shared/src/terrain/field/read.js").HeightField | null, tagsLeft?: boolean }} [opts]
 *   `field`: the map's height field (paper mm, y up), for the cliff passes;
 *   `tagsLeft`: whether the cliff symbols draw their tags left of the line's
 *   direction (OCAD's and Oxygen's draw them on the right).
 * @returns {Promise<{ bytes: Buffer, report: object }>}
 */
export async function enrichOcad(file, { seed = DEMO_SEED, field = null, tagsLeft = false } = {}) {
  // ---- read ------------------------------------------------------------------

  const ocad = await readOcad(file);
  const symbols = new Map(ocad.symbols.map((s) => [s.symNum, s]));
  for (const { sym } of PLAN) if (!symbols.has(sym)) throw new Error(`symbol ${code(sym)} missing from the map's symbol set`);

  const lines = []; // { sym, pts }
  const areas = []; // { sym, rings }
  const points = []; // [x, y]
  for (const o of ocad.objects) {
    const pts = o.coordinates.map((c) => [c[0], c[1], c.yFlags ?? 0]);
    if (o.objType === 1 || o.otp === 1) {
      if (pts.length) points.push([pts[0][0], pts[0][1]]);
    } else if (o.objType === 2 || o.otp === 2) {
      lines.push({ sym: o.sym, pts });
    } else if (o.objType === 3 || o.otp === 3) {
      const rings = [];
      let cur = [];
      for (const [x, y, yf] of pts) {
        if (yf & 2 && cur.length) {
          rings.push(cur);
          cur = [];
        }
        cur.push([x, y]);
      }
      if (cur.length) rings.push(cur);
      areas.push({ sym: o.sym, rings });
    }
  }

  // ---- spatial helpers -----------------------------------------------------------

  const CELL = 200;
  const cellOf = (v) => Math.floor(v / CELL);
  const key = (gx, gy) => `${gx},${gy}`;
  function gridInsert(grid, x0, y0, x1, y1, item) {
    for (let gx = cellOf(Math.min(x0, x1)); gx <= cellOf(Math.max(x0, x1)); gx++)
      for (let gy = cellOf(Math.min(y0, y1)); gy <= cellOf(Math.max(y0, y1)); gy++) {
        const k = key(gx, gy);
        let a = grid.get(k);
        if (!a) grid.set(k, (a = []));
        a.push(item);
      }
  }
  function* near(grid, x, y, r) {
    for (let gx = cellOf(x - r); gx <= cellOf(x + r); gx++)
      for (let gy = cellOf(y - r); gy <= cellOf(y + r); gy++) yield* grid.get(key(gx, gy)) ?? [];
  }
  function segDist(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1, L = dx * dx + dy * dy;
    const t = L === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / L));
    return Math.hypot(px - x1 - t * dx, py - y1 - t * dy);
  }
  function inside(px, py, ring) {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x1, y1] = ring[i], [x2, y2] = ring[j];
      if (y1 > py !== y2 > py && px < x1 + ((py - y1) * (x2 - x1)) / (y2 - y1)) c = !c;
    }
    return c;
  }

  // Segment grid: every line, plus the edges of forbidden areas.
  const segs = new Map();
  const addSegs = (sym, pts) => {
    for (let i = 0; i + 1 < pts.length; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
      gridInsert(segs, x1, y1, x2, y2, [sym, x1, y1, x2, y2]);
    }
  };
  for (const { sym, pts } of lines) if (major(sym) !== 601) addSegs(sym, pts);
  for (const { sym, rings } of areas) if (FORBID.has(major(sym))) for (const r of rings) addSegs(-sym, [...r, r[0]]);

  /** Distance to the nearest segment matching `pred` within `r`, or Infinity. */
  function nearestSeg(x, y, r, pred) {
    let best = Infinity, seg = null;
    for (const s of near(segs, x, y, r)) {
      if (pred && !pred(s[0])) continue;
      const d = segDist(x, y, s[1], s[2], s[3], s[4]);
      if (d < best) (best = d), (seg = s);
    }
    return { d: best, seg };
  }

  // Area grid by bounding box: which areas cover a point.
  const areaGrid = new Map();
  areas.forEach((a, i) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of a.rings) for (const [x, y] of r) (x0 = Math.min(x0, x)), (y0 = Math.min(y0, y)), (x1 = Math.max(x1, x)), (y1 = Math.max(y1, y));
    a.box = [x0, y0, x1, y1];
    gridInsert(areaGrid, x0, y0, x1, y1, i);
  });
  function areasAt(x, y) {
    const out = new Set();
    for (const i of new Set(near(areaGrid, x, y, 0))) {
      const a = areas[i];
      const [x0, y0, x1, y1] = a.box;
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      if (a.rings.filter((r) => inside(x, y, r)).length % 2 === 1) out.add(major(a.sym));
    }
    return out;
  }

  // Buildings: keep invented features out of built-up areas.
  const buildings = new Map();
  for (const { sym, rings } of areas) if (major(sym) === 521 || major(sym) === 520) for (const [x, y] of rings[0]) gridInsert(buildings, x, y, x, y, [x, y]);
  const nearBuilding = (x, y, r) => {
    for (const [bx, by] of near(buildings, x, y, r)) if (Math.hypot(bx - x, by - y) < r) return true;
    return false;
  };

  // Map frame: convex hull of every line vertex, inset.
  function hull(ps) {
    const p = [...ps].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const q of p) { while (lo.length >= 2 && cross(lo.at(-2), lo.at(-1), q) <= 0) lo.pop(); lo.push(q); }
    for (const q of p.reverse()) { while (up.length >= 2 && cross(up.at(-2), up.at(-1), q) <= 0) up.pop(); up.push(q); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  }
  const frame = hull(lines.filter((l) => CONTOURS.has(major(l.sym))).flatMap((l) => l.pts.map(([x, y]) => [x, y])));
  const FRAME_INSET = 3 * MM;
  const inFrame = (x, y) => {
    if (!inside(x, y, frame)) return false;
    for (let i = 0; i < frame.length; i++) {
      const [x1, y1] = frame[i], [x2, y2] = frame[(i + 1) % frame.length];
      if (segDist(x, y, x1, y1, x2, y2) < FRAME_INSET) return false;
    }
    return true;
  };
  let fx0 = Infinity, fy0 = Infinity, fx1 = -Infinity, fy1 = -Infinity;
  for (const [x, y] of frame) (fx0 = Math.min(fx0, x)), (fy0 = Math.min(fy0, y)), (fx1 = Math.max(fx1, x)), (fy1 = Math.max(fy1, y));

  // Anchors for "near" candidates.
  // One anchor list per cliff object, so long, densely noded cliffs do not dominate.
  const cliffObjs = lines.filter((l) => major(l.sym) === 201 || major(l.sym) === 202).map((l) => l.pts);
  const rockPts = areas.filter((a) => major(a.sym) === 214).flatMap((a) => a.rings.flat());
  const contourPts = lines.filter((l) => CONTOURS.has(major(l.sym))).flatMap((l) => l.pts);

  // Existing and placed points.
  const pgrid = new Map();
  const addPoint = (x, y) => gridInsert(pgrid, x, y, x, y, [x, y]);
  points.forEach(([x, y]) => addPoint(x, y));
  // Invented features only: a cap on how many sit within DENSITY_R, so no patch turns into a boulder field.
  const invented = new Map();
  const DENSITY_R = 6 * MM, DENSITY_MAX = 4;
  const tooDense = (x, y) => {
    let n = 0;
    for (const [qx, qy] of near(invented, x, y, DENSITY_R)) if (Math.hypot(qx - x, qy - y) < DENSITY_R && ++n >= DENSITY_MAX) return true;
    return false;
  };
  const crowded = (x, y, d) => {
    for (const [qx, qy] of near(pgrid, x, y, d)) if (Math.hypot(qx - x, qy - y) < d) return true;
    return false;
  };

  // ---- cliff tags ------------------------------------------------------------------------

  let cliffs = { deleted: [], lines: [], stats: null };
  let steepStats = null;
  if (field) {
    const heightAt = (x, y) => sampleHeight(field, { x: x / 100, y: y / 100 });
    const busy = (x, y) => {
      let s = 0;
      for (const sg of near(segs, x, y, 300)) {
        if (!CONTOURS.has(major(sg[0]))) continue;
        const mx = (sg[1] + sg[3]) / 2, my = (sg[2] + sg[4]) / 2;
        if (Math.hypot(mx - x, my - y) < 300) s += Math.hypot(sg[3] - sg[1], sg[4] - sg[2]);
      }
      return s;
    };
    cliffs = cliffTags(file, { heightAt, busy, minBusy: MIN_BUSY, tagsLeft });

    // Steep ground with no cliff drawn: add short tagged cliffs.
    const okCliff = (x, y) => {
      if (!inFrame(x, y)) return false;
      if (nearBuilding(x, y, 3 * MM)) return false;
      if (nearestSeg(x, y, 110, (s) => s > 0 && (major(s) === 201 || major(s) === 202)).d < 110) return false;
      if (nearestSeg(x, y, 45, (s) => s < 0 || (major(s) >= 301 && major(s) <= 309) || (major(s) >= 502 && major(s) <= 518)).d < 45) return false;
      for (const m of areasAt(x, y)) if (FORBID.has(m)) return false;
      return true;
    };
    const steep = steepCliffs(field, { ok: okCliff, tagsLeft, rng: new PyRandom(seed + 1) });
    steepStats = steep.stats;
    cliffs.lines.push(...steep.lines);
    // New lines join the clearance grid, so points keep off them.
    for (const l of cliffs.lines) addSegs(l.sym, l.pts);
  }

  // ---- placement ---------------------------------------------------------------------

  const rng = new PyRandom(seed);
  const around = (anchors, rMin, rMax) => {
    const [bx, by] = rng.choice(anchors);
    const a = rng.uniform(0, 2 * Math.PI);
    const r = rng.uniform(rMin, rMax);
    return [Math.round(bx + r * Math.cos(a)), Math.round(by + r * Math.sin(a))];
  };
  function candidate(mix) {
    const u = rng.random();
    if (u < mix[0] && cliffObjs.length) return around(rng.choice(cliffObjs), 0.8 * MM, 4 * MM);
    if (u < mix[0] + mix[1] && rockPts.length) return around(rockPts, 0, 3 * MM);
    if (u < mix[0] + mix[1] + mix[2]) return around(contourPts, 0.3 * MM, 1.5 * MM);
    return [rng.randint(fx0, fx1), rng.randint(fy0, fy1)];
  }

  function acceptable(x, y, p) {
    if (!inFrame(x, y)) return false;
    if (crowded(x, y, p.clearPoint)) return false;
    if (tooDense(x, y)) return false;
    if (nearestSeg(x, y, p.clearLine, (s) => !CONTOURS.has(major(Math.abs(s)))).d < p.clearLine) return false;
    if (nearestSeg(x, y, p.clearContour, (s) => CONTOURS.has(major(s))).d < p.clearContour) return false;
    // Paths, roads and fences: a wider berth so nothing reads as on the track.
    if (nearestSeg(x, y, 90, (s) => s > 0 && major(s) >= 502 && major(s) <= 518).d < 90) return false;
    if (nearBuilding(x, y, 5 * MM)) return false;
    const under = areasAt(x, y);
    for (const m of under) if (FORBID.has(m)) return false;
    if (p.noBareRock && under.has(214)) return false;
    if ([...under].some((m) => ROUGH_OPEN.has(m)) && rng.random() < 0.6) return false;
    // Landforms want relief: some contour within 2.5 mm.
    if (major(p.sym) < 200 && nearestSeg(x, y, 250, (s) => CONTOURS.has(major(s))).d > 250) return false;
    return true;
  }

  function contourAngle(x, y) {
    const { seg } = nearestSeg(x, y, 300, (s) => CONTOURS.has(major(s)));
    if (!seg) return rng.uniform(0, Math.PI);
    return Math.atan2(seg[4] - seg[2], seg[3] - seg[1]);
  }

  const added = [];
  const placed = {};
  for (const p of PLAN) {
    let got = 0, tries = 0;
    const place = (x, y) => {
      let ang = 0;
      if (p.alignToContour) {
        let a = contourAngle(x, y) + rng.uniform(-0.25, 0.25);
        a = ((a % Math.PI) + Math.PI) % Math.PI;
        ang = Math.round((a * 1800) / Math.PI); // 0.1 degree
      }
      added.push({ sym: p.sym, x, y, ang });
      addPoint(x, y);
      gridInsert(invented, x, y, x, y, [x, y]);
      got++;
    };
    while (got < p.count && tries < p.count * 500) {
      tries++;
      const [x, y] = candidate(p.mix);
      if (!acceptable(x, y, p)) continue;
      place(x, y);
      // Boulders come in loose groups on rocky slopes.
      if (p.satellites && rng.random() < p.satellites) {
        const n = rng.randint(1, 3);
        for (let k = 0; k < n && got < p.count; k++) {
          for (let t = 0; t < 30; t++) {
            const a = rng.uniform(0, 2 * Math.PI), r = rng.uniform(1.3 * MM, 3.5 * MM);
            const sx = Math.round(x + r * Math.cos(a)), sy = Math.round(y + r * Math.sin(a));
            if (acceptable(sx, sy, p)) { place(sx, sy); break; }
          }
        }
      }
    }
    placed[code(p.sym)] = got;
  }

  // ---- write -----------------------------------------------------------------------------

  const ENTRY = 40;
  const BLOCK = 4 + 256 * ENTRY;
  function record({ sym, x, y, ang }) {
    const b = Buffer.alloc(56 + 8);
    b.writeInt32LE(sym, 0);
    b.writeUInt8(1, 4); // otp point
    b.writeInt16LE(ang, 6);
    b.writeUInt32LE(1, 44); // nItem
    b.writeInt32LE(x * 256, 56);
    b.writeInt32LE(y * 256, 60);
    return b;
  }
  function lineRecord({ sym, pts }) {
    const b = Buffer.alloc(56 + 8 * pts.length);
    b.writeInt32LE(sym, 0);
    b.writeUInt8(2, 4); // otp line
    b.writeUInt32LE(pts.length, 44);
    pts.forEach(([x, y], k) => {
      b.writeInt32LE(x * 256, 56 + 8 * k);
      b.writeInt32LE(y * 256, 60 + 8 * k);
    });
    return b;
  }
  const chunks = [file];
  let len = file.length;
  // Last index block in the chain.
  let last = file.readInt32LE(12);
  while (file.readInt32LE(last) !== 0) last = file.readInt32LE(last);
  let prevNextPtr = { buf: null, off: last }; // patch on a copy of the original
  const out0 = Buffer.from(file);
  chunks[0] = out0;
  for (const e of cliffs.deleted) out0.writeUInt8(0, e + 30); // status 0: deleted
  const lineRecs = cliffs.lines.map((l) => ({ ...l, line: true }));
  const all = [...lineRecs, ...added];
  for (let i = 0; i < all.length; i += 256) {
    const batch = all.slice(i, i + 256);
    const block = Buffer.alloc(BLOCK);
    const blockPos = len;
    (prevNextPtr.buf ?? out0).writeInt32LE(blockPos, prevNextPtr.off);
    chunks.push(block);
    len += BLOCK;
    batch.forEach((f, j) => {
      const rec = f.line ? lineRecord(f) : record(f);
      const pos = len;
      chunks.push(rec);
      len += rec.length;
      const sy = symbols.get(f.sym);
      const ext = Math.max(25, sy.extent ?? 25);
      const o = 4 + j * ENTRY;
      const xs = f.line ? f.pts.map((p) => p[0]) : [f.x], ys = f.line ? f.pts.map((p) => p[1]) : [f.y];
      block.writeInt32LE((Math.min(...xs) - ext) * 256, o);
      block.writeInt32LE((Math.min(...ys) - ext) * 256, o + 4);
      block.writeInt32LE((Math.max(...xs) + ext) * 256, o + 8);
      block.writeInt32LE((Math.max(...ys) + ext) * 256, o + 12);
      block.writeInt32LE(pos, o + 16);
      block.writeInt32LE(rec.length, o + 20);
      block.writeInt32LE(f.sym, o + 24);
      block.writeUInt8(f.line ? 2 : 1, o + 28); // objType
      block.writeUInt8(0, o + 29);
      block.writeUInt8(1, o + 30); // status normal
      block.writeUInt8(0, o + 31);
      block.writeInt16LE(sy.colors?.[0] ?? 0, o + 32);
    });
    prevNextPtr = { buf: block, off: 0 };
  }
  return {
    bytes: Buffer.concat(chunks),
    report: {
      seed,
      placed,
      cliffTags: cliffs.stats,
      steepCliffs: steepStats,
      cliffLines: cliffs.lines.map((l) => ({ sym: l.sym, steep: !!l.steep, pts: l.pts })),
      features: added,
    },
  };
}
