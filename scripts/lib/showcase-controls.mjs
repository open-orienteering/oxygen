/**
 * The Demo Competition's control positions (docs/ops/demo.md, "Controls on
 * the demo map"). The race data — controls, courses, runners, punches —
 * comes from a real event; only the control positions belong to the demo
 * map. They live in `fixtures/showcase/showcase-controls.json`,
 * keyed by `controls.seq`, and are applied to `showcase.sql` here:
 *
 *   fit     a first placement: the source event's control cloud moved onto
 *           the demo map by a similarity (quarter-turn rotation, uniform
 *           scale, translation), keeping its relative layout
 *   export  the positions of a loaded demo event, read back from a
 *           database after they were adjusted in the course editor
 *   apply   write the positions into the fixture's control rows and
 *           re-derive each course's `legs` / `length_m` from them, the
 *           way `rebuildCourseLengths` does after an editor move
 *
 *   snap    after a fit: move each control onto a nearby point feature of
 *           the map (boulder, knoll, depression, pit), and each start and
 *           finish onto a nearby path, so the circles stand on something
 *
 * Positions are paper mm in the map document's frame (y up), the unit of
 * `controls.xpos/ypos`; (0, 0) is "not placed" and stays so. For an OCAD
 * map the document's frame is OCAD's own (0.01 mm, y up), so a map
 * object at OCAD (x, y) is at (x / 100, y / 100) mm.
 */

import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { loadApiModules } from "./showcase-map.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CONTROLS_JSON_PATH = path.join(ROOT, "fixtures", "showcase", "showcase-controls.json");

/** The demo map's scale, and the source event's (both 1:15 000). */
export const DEMO_MAP_SCALE = 15000;
export const SOURCE_MAP_SCALE = 15000;
/** Distance kept between the fitted cloud and the region's edge, mm; 0, since placement keeps `EDGE_CLEARANCE_MM` of drawn map around each control instead. */
export const FIT_MARGIN_MM = 0;
/** A placed control keeps this much drawn map around it, mm (180 m at 1:15 000). */
export const EDGE_CLEARANCE_MM = 12;

// ─── SQL rows ────────────────────────────────────────────────────────────────

/**
 * Split the inside of a `VALUES (…)` list into its literal tokens, kept
 * verbatim (casts included): `E'…'` / `'…'` strings with `''` and
 * backslash escapes, numbers, NULL, TRUE / FALSE.
 */
export function splitSqlValues(values) {
  const out = [];
  let i = 0;
  while (i < values.length) {
    const start = i;
    let depth = 0;
    while (i < values.length) {
      const ch = values[i];
      if (ch === "'") {
        const escapes = values[i - 1] === "E" && (i - 1 === start || /[\s,(]/.test(values[i - 2] ?? ""));
        i++;
        while (i < values.length) {
          if (escapes && values[i] === "\\") i += 2;
          else if (values[i] === "'" && values[i + 1] === "'") i += 2;
          else if (values[i] === "'") break;
          else i++;
        }
        i++;
        continue;
      }
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (ch === "," && depth === 0) break;
      i++;
    }
    out.push(values.slice(start, i).trim());
    i++; // the comma
    while (values[i] === " ") i++;
  }
  return out;
}

/** A literal token's value: string, number, boolean or null (casts dropped). */
export function sqlValue(token) {
  const bare = token.replace(/::[a-z_."]+(\[\])?$/i, "");
  if (bare === "NULL") return null;
  if (bare === "TRUE") return true;
  if (bare === "FALSE") return false;
  const str = bare.match(/^(E?)'([\s\S]*)'$/);
  if (str) {
    let s = str[2].replace(/''/g, "'");
    if (str[1]) s = s.replace(/\\(.)/g, (_, c) => ({ n: "\n", r: "\r", t: "\t" })[c] ?? c);
    return s;
  }
  const n = Number(bare);
  if (Number.isFinite(n)) return n;
  throw new Error(`Unrecognised SQL literal: ${token.slice(0, 60)}`);
}

const INSERT_RE = /^INSERT INTO (\w+) \(([^)]*)\) (?:OVERRIDING SYSTEM VALUE )?VALUES \(([\s\S]*)\);$/;

/** One `INSERT INTO <table> (…) VALUES (…);` line → its table, columns and tokens; null for other lines. */
export function parseInsert(line) {
  const m = INSERT_RE.exec(line);
  if (!m) return null;
  const columns = m[2].split(", ").map((c) => c.replace(/^"|"$/g, ""));
  const tokens = splitSqlValues(m[3]);
  if (tokens.length !== columns.length) throw new Error(`INSERT INTO ${m[1]}: ${columns.length} columns, ${tokens.length} values`);
  return { table: m[1], columns, tokens, head: line.slice(0, line.length - m[3].length - 2) };
}

function rowObject({ columns, tokens }) {
  return Object.fromEntries(columns.map((c, i) => [c, sqlValue(tokens[i])]));
}

function withTokens(parsed, changes) {
  const tokens = parsed.tokens.map((t, i) => (parsed.columns[i] in changes ? changes[parsed.columns[i]] : t));
  return `${parsed.head}${tokens.join(", ")});`;
}

/** The fixture's control, course and course_controls rows. */
export function readFixtureRows(sql) {
  const controls = [];
  const courses = [];
  const courseControls = [];
  for (const line of sql.split("\n")) {
    if (!line.startsWith("INSERT INTO controls ") && !line.startsWith("INSERT INTO courses ") && !line.startsWith("INSERT INTO course_controls ")) continue;
    const parsed = parseInsert(line);
    const row = rowObject(parsed);
    if (parsed.table === "controls") controls.push(row);
    else if (parsed.table === "courses") courses.push(row);
    else courseControls.push(row);
  }
  return { controls, courses, courseControls };
}

const num = (v) => Math.round(v * 100) / 100;
/** A placed position, rounded; (0, 0) means "not placed", so a control that lands there moves 0.01 mm. */
const placedAt = (x, y) => (num(x) === 0 && num(y) === 0 ? { xpos: 0.01, ypos: 0 } : { xpos: num(x), ypos: num(y) });
const fmt = (v) => String(num(v) === 0 ? 0 : num(v));

// ─── positions file ──────────────────────────────────────────────────────────

/** The positions file's content: one entry per control, ordered by seq. */
export function controlsDocument(rows) {
  const controls = [...rows]
    .sort((a, b) => a.seq - b.seq)
    .map((c) => ({ seq: c.seq, codes: c.codes, name: c.name, xpos: num(c.xpos), ypos: num(c.ypos) }));
  return { scale: DEMO_MAP_SCALE, controls };
}

/** One control per line, so a moved control is a one-line diff. */
export function serialiseControls(doc) {
  const rows = doc.controls.map((c) => `    ${JSON.stringify(c)}`).join(",\n");
  return `{\n  "scale": ${doc.scale},\n  "controls": [\n${rows}\n  ]\n}\n`;
}

// ─── fit ─────────────────────────────────────────────────────────────────────

const ROTATIONS = [
  ([x, y]) => [x, y],
  ([x, y]) => [-y, x],
  ([x, y]) => [-x, -y],
  ([x, y]) => [y, -x],
];

function bbox(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

const OCAD_UNITS_PER_MM = 100;
/** Where no control may stand (ISOM 2017-2): uncrossable or shallow water, uncrossable marsh, fight, cultivated land, orchard, paved areas, out-of-bounds, buildings. */
const FORBIDDEN = new Set([301, 302, 307, 410, 412, 413, 501, 520, 521, 522]);
/** Areas a leg should not cross (ISOM 2017-2): uncrossable water and marsh, out-of-bounds, buildings. */
const UNCROSSABLE = new Set([301, 307, 520, 521]);
/** The uncrossable raster's cell, mm. */
const BLOCK_CELL_MM = 0.5;
/** Point features a control may be placed on: knolls, depressions, pits, boulders. */
const FEATURES = new Set([109, 110, 111, 112, 113, 204, 205, 206, 207]);
/** Lines a start or finish may stand on: roads, tracks and paths. */
const PATHS = new Set([502, 503, 504, 505, 506, 507]);
const CONTOURS = new Set([101, 102, 103]);
/** The region is the contours' bounding box shrunk by this much, mm. */
const REGION_INSET_MM = 6;

/** `ocad2geojson` lives in packages/api's dependencies. */
async function readOcadFile(bytes) {
  const entry = createRequire(path.join(ROOT, "packages", "api", "package.json")).resolve("ocad2geojson");
  const { readOcad } = await import(pathToFileURL(entry).href);
  return readOcad(bytes);
}

function insideRing(px, py, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[j];
    if (y1 > py !== y2 > py && px < x1 + ((py - y1) * (x2 - x1)) / (y2 - y1)) c = !c;
  }
  return c;
}

/**
 * The demo map's region in document mm (y up) from the OCAD file: the
 * contours' bounding box shrunk by 6 mm; the forbidden-area test (water,
 * fight, cultivated land, paved areas, out-of-bounds, buildings), which
 * gives the ISOM symbol of the area a point is in or null; `blockedAt`,
 * whether a point is in uncrossable water or marsh, out-of-bounds or a
 * building (on a 0.5 mm raster, for testing legs); `mappedAt`, whether a
 * point lies in the drawn map rather than an empty corner of the box; the point
 * features a control can stand on; and the path segments a start or
 * finish can stand on.
 *
 * @param {Buffer} ocdBytes
 */
export async function demoMapRegion(ocdBytes) {
  const ocad = await readOcadFile(ocdBytes);
  const areas = [];
  const features = [];
  const paths = [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const drawn = []; // every map object's vertices, for the mapped-area raster
  for (const o of ocad.objects) {
    const major = Math.floor(o.sym / 1000);
    const type = o.objType ?? o.otp;
    const pts = o.coordinates.map((c) => [c[0] / OCAD_UNITS_PER_MM, c[1] / OCAD_UNITS_PER_MM, c.yFlags ?? 0]);
    // Magnetic north lines (601) run past the map's edge.
    if (major !== 601) drawn.push(pts);
    if (CONTOURS.has(major) && type === 2) {
      for (const [x, y] of pts) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
    if (type === 1 && FEATURES.has(major) && pts.length) features.push({ x: pts[0][0], y: pts[0][1], symbol: `${o.sym / 1000}` });
    if (type === 2 && PATHS.has(major)) for (let i = 0; i + 1 < pts.length; i++) paths.push([pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]]);
    if (type === 3 && FORBIDDEN.has(major)) {
      const rings = [];
      let cur = [];
      for (const [x, y, yf] of pts) {
        if (yf & 2 && cur.length) { rings.push(cur); cur = []; }
        cur.push([x, y]);
      }
      if (cur.length) rings.push(cur);
      const xs = rings.flat().map((p) => p[0]);
      const ys = rings.flat().map((p) => p[1]);
      areas.push({ symbol: `${o.sym / 1000}`, rings, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
    }
  }
  if (!Number.isFinite(minX)) throw new Error("The demo map has no contours");
  // A raster of the uncrossable areas, so a leg's straight line is cheap to test.
  const gx0 = Math.floor(minX), gy0 = Math.floor(minY);
  const cols = Math.ceil((maxX - gx0) / BLOCK_CELL_MM) + 1;
  const rowsN = Math.ceil((maxY - gy0) / BLOCK_CELL_MM) + 1;
  const blocked = new Uint8Array(cols * rowsN);
  for (const a of areas) {
    if (!UNCROSSABLE.has(Math.floor(Number(a.symbol)))) continue;
    const c0 = Math.max(0, Math.floor((a.box[0] - gx0) / BLOCK_CELL_MM)), c1 = Math.min(cols - 1, Math.ceil((a.box[2] - gx0) / BLOCK_CELL_MM));
    const r0 = Math.max(0, Math.floor((a.box[1] - gy0) / BLOCK_CELL_MM)), r1 = Math.min(rowsN - 1, Math.ceil((a.box[3] - gy0) / BLOCK_CELL_MM));
    for (let r = r0; r <= r1; r++) {
      const y = gy0 + (r + 0.5) * BLOCK_CELL_MM;
      for (let c = c0; c <= c1; c++) {
        const x = gx0 + (c + 0.5) * BLOCK_CELL_MM;
        if (a.rings.reduce((inside, ring) => (insideRing(x, y, ring) ? !inside : inside), false)) blocked[r * cols + c] = 1;
      }
    }
  }
  // The mapped area: 1 mm cells holding a vertex of any map object, grown by 3 mm.
  // The contours' bounding box also takes in the empty corners of a slanted map.
  const mCols = Math.ceil(maxX - gx0) + 2, mRows = Math.ceil(maxY - gy0) + 2;
  const seen = new Uint8Array(mCols * mRows);
  for (const pts of drawn) {
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[i + 1] ?? pts[i];
      const n = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1)));
      for (let k = 0; k <= n; k++) {
        const c = Math.floor(x1 + ((x2 - x1) * k) / n - gx0), r = Math.floor(y1 + ((y2 - y1) * k) / n - gy0);
        if (c >= 0 && r >= 0 && c < mCols && r < mRows) seen[r * mCols + c] = 1;
      }
    }
  }
  const mapped = new Uint8Array(mCols * mRows);
  for (let r = 0; r < mRows; r++)
    for (let c = 0; c < mCols; c++) {
      if (!seen[r * mCols + c]) continue;
      for (let dr = -3; dr <= 3; dr++)
        for (let dc = -3; dc <= 3; dc++) {
          const rr = r + dr, cc = c + dc;
          if (rr >= 0 && cc >= 0 && rr < mRows && cc < mCols) mapped[rr * mCols + cc] = 1;
        }
    }
  const mappedAt = (x, y) => {
    const c = Math.floor(x - gx0), r = Math.floor(y - gy0);
    return c >= 0 && r >= 0 && c < mCols && r < mRows && mapped[r * mCols + c] === 1;
  };
  const blockedAt = (x, y) => {
    const c = Math.floor((x - gx0) / BLOCK_CELL_MM), r = Math.floor((y - gy0) / BLOCK_CELL_MM);
    return c >= 0 && r >= 0 && c < cols && r < rowsN && blocked[r * cols + c] === 1;
  };
  const forbiddenAt = (x, y) => {
    for (const a of areas) {
      if (x < a.box[0] || x > a.box[2] || y < a.box[1] || y > a.box[3]) continue;
      // Even-odd over all of the object's rings: a hole is not inside.
      if (a.rings.reduce((inside, ring) => (insideRing(x, y, ring) ? !inside : inside), false)) return a.symbol;
    }
    return null;
  };
  return {
    minX: minX + REGION_INSET_MM,
    maxX: maxX - REGION_INSET_MM,
    minY: minY + REGION_INSET_MM,
    maxY: maxY - REGION_INSET_MM,
    forbiddenAt,
    blockedAt,
    mappedAt,
    features: features.filter((f) => !forbiddenAt(f.x, f.y)),
    paths,
  };
}

/**
 * Move the placed controls onto the region by one similarity: the
 * quarter turn that allows the largest scale, the scale capped at the
 * ratio of the map scales (so legs keep their terrain length when they
 * fit) and the cloud's centre on the region's centre, `margin` mm from its
 * edge. Controls at (0, 0) stay unplaced.
 *
 * @returns {{ rows: object[], rotation: number, scale: number }} the rows with new `xpos` / `ypos`, the quarter turns and the scale used
 */
export function fitControls(rows, region, { margin = FIT_MARGIN_MM, maxScale = SOURCE_MAP_SCALE / DEMO_MAP_SCALE, rotation } = {}) {
  const placed = rows.filter((c) => c.xpos !== 0 || c.ypos !== 0);
  if (placed.length === 0) return { rows, rotation: 0, scale: 1 };
  const width = region.maxX - region.minX - 2 * margin;
  const height = region.maxY - region.minY - 2 * margin;
  let best = null;
  ROTATIONS.forEach((rotate, k) => {
    if (rotation !== undefined && k !== rotation) return;
    const b = bbox(placed.map((c) => rotate([c.xpos, c.ypos])));
    const scale = Math.min(maxScale, width / Math.max(b.maxX - b.minX, 1e-9), height / Math.max(b.maxY - b.minY, 1e-9));
    if (!best || scale > best.scale + 1e-9) best = { k, rotate, scale, b };
  });
  const { k, rotate, scale, b } = best;
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const rx = (region.minX + region.maxX) / 2;
  const ry = (region.minY + region.maxY) / 2;
  const out = rows.map((c) => {
    if (c.xpos === 0 && c.ypos === 0) return c;
    const [x, y] = rotate([c.xpos, c.ypos]);
    return { ...c, ...placedAt(rx + (x - cx) * scale, ry + (y - cy) * scale) };
  });
  return { rows: out, rotation: k, scale };
}

// ─── snap ────────────────────────────────────────────────────────────────────

/** How far a control may move onto a feature, mm (90 m at 1:15 000). */
export const SNAP_RADIUS_MM = 6;
/** Two controls on different features stand at least this far apart, mm (60 m at 1:15 000, IOF). */
export const MIN_SPACING_MM = 4;

function nearestOnSegment(px, py, [x1, y1, x2, y2]) {
  const dx = x2 - x1, dy = y2 - y1, l = dx * dx + dy * dy;
  const t = l === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / l));
  return [x1 + t * dx, y1 + t * dy];
}

/**
 * Move fitted controls onto the map's features: each control (by `seq`
 * order) onto the nearest free point feature within `radius` that keeps
 * `spacing` from the controls already placed; each start and finish onto
 * the nearest point of a path within `radius`. A control with no such
 * feature keeps its fitted position. Unplaced controls stay unplaced.
 *
 * @returns {{ rows: object[], snapped: number, kept: object[] }} the rows, how many moved, and the controls that kept their place
 */
export function snapControls(rows, region, { radius = SNAP_RADIUS_MM, spacing = MIN_SPACING_MM } = {}) {
  const used = new Set();
  const placed = [];
  const kept = [];
  let snapped = 0;
  const order = [...rows.keys()].sort((a, b) => rows[a].seq - rows[b].seq);
  const out = [...rows];
  for (const i of order) {
    const c = rows[i];
    if (c.xpos === 0 && c.ypos === 0) continue;
    const type = siteType(c);
    let best = null;
    if (type === "Control") {
      region.features.forEach((f, k) => {
        if (used.has(k)) return;
        const d = Math.hypot(f.x - c.xpos, f.y - c.ypos);
        if (d > radius || (best && d >= best.d)) return;
        if (placed.some((p) => Math.hypot(p[0] - f.x, p[1] - f.y) < spacing)) return;
        best = { d, x: f.x, y: f.y, k };
      });
      if (best) used.add(best.k);
    } else {
      for (const seg of region.paths) {
        const [x, y] = nearestOnSegment(c.xpos, c.ypos, seg);
        const d = Math.hypot(x - c.xpos, y - c.ypos);
        if (d <= radius && (!best || d < best.d) && !region.forbiddenAt(x, y)) best = { d, x, y };
      }
    }
    if (best) {
      out[i] = { ...c, ...placedAt(best.x, best.y) };
      snapped++;
    } else kept.push(c);
    if (type === "Control" && !c.removed) placed.push([out[i].xpos, out[i].ypos]);
  }
  return { rows: out, snapped, kept };
}

/**
 * Whether a leg's straight line runs through an uncrossable area
 * (`region.blockedAt`), tested every 0.5 mm.
 */
export function legCrossesBlocked(a, b, region) {
  const n = Math.max(1, Math.ceil(Math.hypot(b.xpos - a.xpos, b.ypos - a.ypos) / BLOCK_CELL_MM));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    if (region.blockedAt(a.xpos + (b.xpos - a.xpos) * t, a.ypos + (b.ypos - a.ypos) * t)) return true;
  }
  return false;
}

/** Whether a control has less than `EDGE_CLEARANCE_MM` of drawn map around it (16 directions). */
export function nearMapEdge(c, region) {
  if (!region.mappedAt) return false;
  for (let k = 0; k < 16; k++) {
    const a = (k * Math.PI) / 8;
    if (!region.mappedAt(c.xpos + EDGE_CLEARANCE_MM * Math.cos(a), c.ypos + EDGE_CLEARANCE_MM * Math.sin(a))) return true;
  }
  return !region.mappedAt(c.xpos, c.ypos);
}

/**
 * The fixture's legs as pairs of control `seq`s: each live course from its
 * start (by `start_name`) through its controls to the first live finish.
 */
export function courseLegs({ controls, courses, courseControls }) {
  const byId = new Map(controls.map((c) => [c.id, c]));
  const live = controls.filter((c) => !c.removed);
  const finish = live.find((c) => c.status === "finish");
  const legs = [];
  for (const course of courses) {
    if (course.removed) continue;
    const start = live.find((c) => c.status === "start" && c.name === course.start_name);
    const middle = courseControls
      .filter((cc) => cc.course_id === course.id)
      .sort((a, b) => a.position - b.position)
      .map((cc) => byId.get(cc.control_id))
      .filter(Boolean);
    const seq = [start, ...middle, finish].filter(Boolean).map((c) => c.seq);
    for (let i = 0; i + 1 < seq.length; i++) legs.push([seq[i], seq[i + 1]]);
  }
  return legs;
}

/**
 * Fit in each quarter turn, slide the fitted cloud over the map (in `step`
 * mm, staying `margin` mm inside the region) and snap; keep the placement
 * where, in this order: the fewest controls stand in a forbidden area or
 * within `EDGE_CLEARANCE_MM` of the drawn map's edge,
 * the fewest `legs` (pairs of `seq`) cross water, marsh, out-of-bounds or
 * a building, the most controls find a feature, and the controls move
 * least. Deterministic: ties keep the first in scan order.
 *
 * @returns {{ rows: object[], rotation: number, scale: number, offset: [number, number], snapped: number, kept: object[], crossings: number }}
 */
export function placeControls(rows, region, { margin = FIT_MARGIN_MM, maxScale, step = 2, legs = [] } = {}) {
  const range = (lo, hi) => {
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v);
    return out.length ? out : [0];
  };
  const better = (a, b) => {
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-9) return a[i] < b[i];
    return false;
  };
  let best = null;
  for (let rotation = 0; rotation < 4; rotation++) {
    const fit = fitControls(rows, region, { margin, rotation, ...(maxScale === undefined ? {} : { maxScale }) });
    const placed = fit.rows.filter((c) => c.xpos !== 0 || c.ypos !== 0);
    if (placed.length === 0) return { ...fit, offset: [0, 0], snapped: 0, kept: [], crossings: 0 };
    const b = bbox(placed.map((c) => [c.xpos, c.ypos]));
    for (const dx of range(region.minX + margin - b.minX, region.maxX - margin - b.maxX)) {
      for (const dy of range(region.minY + margin - b.minY, region.maxY - margin - b.maxY)) {
        const moved = fit.rows.map((c) => (c.xpos === 0 && c.ypos === 0 ? c : { ...c, ...placedAt(c.xpos + dx, c.ypos + dy) }));
        const snap = snapControls(moved, region);
        const bySeq = new Map(snap.rows.map((c) => [c.seq, c]));
        const bad = snap.rows.filter((c) => !c.removed && (c.xpos !== 0 || c.ypos !== 0) && (region.forbiddenAt(c.xpos, c.ypos) || nearMapEdge(c, region))).length;
        let crossings = 0;
        for (const [p, q] of legs) {
          const a = bySeq.get(p), z = bySeq.get(q);
          if (a && z && (a.xpos !== 0 || a.ypos !== 0) && (z.xpos !== 0 || z.ypos !== 0) && legCrossesBlocked(a, z, region)) crossings++;
        }
        let shift = 0;
        snap.rows.forEach((c, i) => (shift += Math.hypot(c.xpos - moved[i].xpos, c.ypos - moved[i].ypos)));
        const score = [bad, crossings, snap.kept.length, shift];
        if (!best || better(score, best.score)) best = { score, snap, rotation, scale: fit.scale, offset: [dx, dy], crossings };
      }
    }
  }
  return { rows: best.snap.rows, rotation: best.rotation, scale: best.scale, offset: best.offset, snapped: best.snap.snapped, kept: best.snap.kept, crossings: best.crossings };
}

// ─── apply ───────────────────────────────────────────────────────────────────

/** A site's drawn role from its row, as `course-geometry.ts` reads it. */
function siteType(c) {
  if (c.kind === "start" || c.status === "start") return "Start";
  if (c.kind === "finish" || c.status === "finish") return "Finish";
  return "Control";
}

function displayCode(c) {
  const first = c.codes.split(";")[0]?.trim();
  return first || c.name || String(c.seq);
}

/**
 * The derived `legs`, `length_m` and `length_source` of every course over
 * the given control rows: `loadCourseSequences` + `rebuildCourseLengths`
 * (packages/api/src/course-geometry.ts) on the fixture's rows, with no
 * stored structure (the fixture writes it NULL).
 */
export async function deriveCourseLengths({ controls, courses, courseControls }, scale = DEMO_MAP_SCALE) {
  const { courseGeometry, courseStructure } = await loadCourseModules();
  const byId = new Map(controls.map((c) => [c.id, c]));
  const live = controls.filter((c) => !c.removed).sort((a, b) => a.seq - b.seq);
  const starts = live.filter((c) => c.status === "start");
  const finishes = live.filter((c) => c.status === "finish");
  const out = new Map();
  for (const course of courses) {
    if (course.removed) continue;
    const ccIds = courseControls
      .filter((cc) => cc.course_id === course.id)
      .sort((a, b) => a.position - b.position)
      .map((cc) => cc.control_id);
    const parts = courseStructure.courseSequenceOf(
      { structure: null, firstAsStart: course.first_as_start, lastAsFinish: course.last_as_finish, startName: course.start_name, finishControlId: course.finish_control_id },
      ccIds,
      { site: (id) => byId.get(id), starts, finishes },
    );
    const seq = [];
    if (parts.start) seq.push({ id: parts.start.id, code: displayCode(parts.start), type: "Start", xMm: parts.start.xpos, yMm: parts.start.ypos });
    for (const c of parts.middle.flatMap((id) => byId.get(id) ?? [])) seq.push({ id: c.id, code: displayCode(c), type: siteType(c), xMm: c.xpos, yMm: c.ypos });
    if (parts.finish) seq.push({ id: parts.finish.id, code: displayCode(parts.finish), type: "Finish", xMm: parts.finish.xpos, yMm: parts.finish.ypos });

    const layer = courseGeometry.editorCourseLayer(course.id, seq, course.order_mode);
    const derived = { lengthSource: courseGeometry.hasPositionedItems(layer) ? "derived" : null, legs: course.legs, lengthM: course.length_m };
    if (course.order_mode !== "free_order") {
      const distances = courseGeometry.legDistancesMm(layer);
      if (distances.length > 0) {
        derived.legs = distances.map((d) => Math.round((d * scale) / 1000)).join(";") + ";";
        derived.lengthM = courseGeometry.courseLengthM(distances, scale);
      }
    }
    out.set(course.id, derived);
  }
  return out;
}

let courseModules;
async function loadCourseModules() {
  await loadApiModules(); // registers tsx under plain node
  courseModules ??= Promise.all([
    import(path.join(ROOT, "packages", "api", "src", "course-geometry.ts")),
    import(path.join(ROOT, "packages", "api", "src", "course-structure.ts")),
  ]).then(([courseGeometry, courseStructure]) => ({ courseGeometry, courseStructure }));
  return courseModules;
}

const sqlText = (s) => (s === null ? "NULL" : `E'${s.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`);

/**
 * Write the positions into the fixture: each control row's `xpos` /
 * `ypos` from the file (by `seq`), its `lat` / `lng` NULL (the pin derives
 * them from the positions on load); each course row's `structure` NULL
 * and its `legs` / `length_m` / `length_source` re-derived. Every control
 * row must have an entry and every entry a row. Applying twice changes
 * nothing.
 */
export async function applyControls(sql, doc) {
  const bySeq = new Map();
  for (const c of doc.controls) {
    if (bySeq.has(c.seq)) throw new Error(`showcase-controls.json: seq ${c.seq} appears twice`);
    bySeq.set(c.seq, c);
  }
  const lines = sql.split("\n");
  const seen = new Set();
  const controlRows = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("INSERT INTO controls ")) continue;
    const parsed = parseInsert(lines[i]);
    const row = rowObject(parsed);
    const pos = bySeq.get(row.seq);
    if (!pos) throw new Error(`showcase-controls.json has no entry for control seq ${row.seq}`);
    if (seen.has(row.seq)) throw new Error(`The fixture has two controls with seq ${row.seq}`);
    seen.add(row.seq);
    lines[i] = withTokens(parsed, { xpos: fmt(pos.xpos), ypos: fmt(pos.ypos), lat: "NULL", lng: "NULL" });
    controlRows.push({ ...row, xpos: num(pos.xpos), ypos: num(pos.ypos) });
  }
  const extra = [...bySeq.keys()].filter((s) => !seen.has(s));
  if (extra.length) {
    throw new Error(`showcase-controls.json has controls the fixture does not (seq ${extra.join(", ")}); the demo keeps the source event's controls — move an existing one instead`);
  }

  const { courses, courseControls } = readFixtureRows(sql);
  const lengths = await deriveCourseLengths({ controls: controlRows, courses, courseControls }, doc.scale);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("INSERT INTO courses ")) continue;
    const parsed = parseInsert(lines[i]);
    const row = rowObject(parsed);
    const d = lengths.get(row.id);
    const changes = { structure: "NULL" };
    if (d) Object.assign(changes, { legs: sqlText(d.legs), length_m: String(d.lengthM), length_source: sqlText(d.lengthSource) });
    lines[i] = withTokens(parsed, changes);
  }
  return lines.join("\n");
}

// ─── export ──────────────────────────────────────────────────────────────────

/** `pg` lives in packages/api's dependencies. */
export function pgClient(connectionString) {
  const { Client } = createRequire(path.join(ROOT, "packages", "api", "package.json"))("pg");
  // Prisma's `?schema=` is not a libpq parameter.
  return new Client({ connectionString: connectionString.replace(/([?&])schema=[^&]*&?/, "$1").replace(/[?&]$/, "") });
}

/** The positions of an event's controls as the positions file holds them. */
export async function exportControls(client, nameId) {
  const { rows } = await client.query(
    `SELECT c.seq, c.codes, c.name, c.xpos, c.ypos
       FROM oxygen.controls c JOIN oxygen.events e ON e.id = c.event_id
      WHERE e.name_id = $1
      ORDER BY c.seq`,
    [nameId],
  );
  if (rows.length === 0) throw new Error(`No controls for event ${nameId}`);
  return controlsDocument(rows.map((r) => ({ ...r, seq: Number(r.seq), xpos: Number(r.xpos), ypos: Number(r.ypos) })));
}
