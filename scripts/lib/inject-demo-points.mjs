/**
 * The Demo Competition's map (docs/demo.md, "The map"): the CC0 Puit de
 * Laven map (`scripts/fixtures/puit-de-laven.omap`) has hardly any point
 * features, so this adds invented ones — boulders (ISOM 204/205/207),
 * knolls (109/110), depressions (111) and pits (112) — at seeded random
 * positions in forest and open land, clear of every line and of each
 * other. Each injected object carries the tag `oxygen-demo=injected`, and
 * the map's notes say the features are invented and name the source.
 *
 * A port of the Python script the placement was first made and approved
 * with; `PyRandom` reproduces its generator, so the default seed gives the
 * approved map byte for byte (`scripts/__tests__/demo-map.test.mjs`).
 * Coordinates are Mapper's: 1/1000 mm on paper, y down.
 */

import { PyRandom } from "./py-random.mjs";

export const DEMO_SEED = 42;
export const INJECTED_TAG = '<t k="oxygen-demo">injected</t>';
export const DEMO_NOTE =
  "Point features tagged oxygen-demo=injected (boulders, knolls, depressions, pits) were added at random " +
  "positions for the Oxygen demo. They are invented, not surveyed. Original map: " +
  "github.com/dmkaplan2000/orienteering-maps (CC0-1.0).";

const FORBID_AREA = ["301", "302", "412", "413", "501", "521", "529"]; // water, fields, orchard, paved, buildings
const IGNORE_AREA = ["3", "601"]; // border area, north-line pattern
const CELL = 2000;

/** Per symbol: how many, the share placed near cliffs, the clearance from lines. */
export const INJECTION_PLAN = [
  { code: "204", count: 140, cliffShare: 0.6, clear: 450 },
  { code: "205", count: 30, cliffShare: 0.6, clear: 550 },
  { code: "207", count: 18, cliffShare: 0.7, clear: 600 },
  { code: "109", count: 90, cliffShare: 0.15, clear: 550 },
  { code: "110", count: 25, cliffShare: 0.15, clear: 650 },
  { code: "111", count: 30, cliffShare: 0.1, clear: 550 },
  { code: "112", count: 25, cliffShare: 0.3, clear: 500 },
];
const LANDFORM = ["109", "110", "111", "112"];

const startsWithAny = (s, prefixes) => prefixes.some((p) => s.startsWith(p));
const cellOf = (v) => Math.floor(v / CELL);
const key = (gx, gy) => `${gx},${gy}`;

function parseCoords(coords) {
  const pts = [];
  for (const tok of coords.split(";")) {
    const q = tok.split(/\s+/).filter(Boolean);
    if (q.length >= 2) pts.push([parseInt(q[0], 10), parseInt(q[1], 10), q.length > 2 ? parseInt(q[2], 10) : 0]);
  }
  return pts;
}

/** Split an area's coordinates into rings; flag 16 marks a ring's last point. */
function rings(pts) {
  const out = [];
  let cur = [];
  for (const [x, y, f] of pts) {
    cur.push([x, y]);
    if (f & 16) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const L = dx * dx + dy * dy;
  const t = L === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / L));
  return Math.hypot(px - x1 - t * dx, py - y1 - t * dy);
}

function inside(px, py, ring) {
  let c = false;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    if (y1 > py !== y2 > py && px < x1 + ((py - y1) * (x2 - x1)) / (y2 - y1)) c = !c;
  }
  return c;
}

/**
 * What the injection (and the control fit, scripts/lib/showcase-controls.mjs)
 * needs to know of a Mapper map: its symbols, existing points, lines on a
 * grid index, the forbidden areas and the map region (the contours'
 * bounding box shrunk by 6 mm), all in Mapper units.
 *
 * @param {string} text a Mapper `.omap` (XML) text
 */
export function analyseOmap(text) {
  const syms = new Map();
  for (const m of text.matchAll(/<symbol type="(\d+)" id="(\d+)" code="([^"]+)"/g)) syms.set(m[2], { type: parseInt(m[1], 10), code: m[3] });
  const code2id = new Map();
  for (const [id, { code }] of syms) code2id.set(code, id);

  const areas = [];
  const lines = [];
  const points = [];
  for (const m of text.matchAll(/<object type="(\d)"[^>]*?symbol="(\d+)"[^>]*>.*?<coords count="\d+">(.*?)<\/coords>/gs)) {
    const [, otype, sid, coords] = m;
    const sym = syms.get(sid);
    if (!sym) continue;
    const { type: stype, code } = sym;
    const pts = parseCoords(coords);
    if (otype === "0") {
      points.push([pts[0][0], pts[0][1]]);
      continue;
    }
    if (otype !== "1") continue;
    if (stype === 4 || (stype === 16 && startsWithAny(code, FORBID_AREA))) {
      if (startsWithAny(code, IGNORE_AREA) && code !== "301" && code !== "302") continue;
      if (code === "3" || code.startsWith("601")) continue;
      areas.push({ code, rings: rings(pts) });
    }
    if (stype === 2 || stype === 16) lines.push({ code, pts: pts.map(([x, y]) => [x, y]) });
  }

  // Map region: the contours' bounding box, shrunk by 6 mm.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const { code, pts } of lines) {
    if (code !== "101" && code !== "102") continue;
    for (const [x, y] of pts) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (minX === Infinity) throw new Error("analyseOmap: the map has no contours (ISOM 101/102)");
  const region = { X0: minX + 6000, X1: maxX - 6000, Y0: minY + 6000, Y1: maxY - 6000 };

  const grid = new Map();
  for (const { code, pts } of lines) {
    for (let i = 0; i + 1 < pts.length; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[i + 1];
      for (let gx = cellOf(Math.min(x1, x2)) - 1; gx < cellOf(Math.max(x1, x2)) + 2; gx++) {
        for (let gy = cellOf(Math.min(y1, y2)) - 1; gy < cellOf(Math.max(y1, y2)) + 2; gy++) {
          const k = key(gx, gy);
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push([code, x1, y1, x2, y2]);
        }
      }
    }
  }
  const nearLine = (px, py, d, codes) => {
    for (const [code, x1, y1, x2, y2] of grid.get(key(cellOf(px), cellOf(py))) ?? []) {
      if (codes && !startsWithAny(code, codes)) continue;
      if (segDist(px, py, x1, y1, x2, y2) < d) return true;
    }
    return false;
  };

  const forbid = areas.filter(({ code }) => startsWithAny(code, FORBID_AREA));
  /** The forbidden area's symbol code at the point, or null. */
  const forbiddenAt = (px, py) => forbid.find(({ rings: rs }) => rs.filter((r) => inside(px, py, r)).length % 2 === 1)?.code ?? null;

  return { code2id, points, lines, region, nearLine, forbiddenAt };
}

/**
 * Add the invented point features to a Mapper `.omap` (XML) text.
 *
 * @param {string} text the original map
 * @param {number} [seed]
 * @returns {{ text: string, placed: Record<string, number> }} the new map and how many of each symbol were placed
 */
export function injectDemoPoints(text, seed = DEMO_SEED) {
  const rng = new PyRandom(seed);
  const { code2id, points, lines, region, nearLine, forbiddenAt } = analyseOmap(text);
  const { X0, X1, Y0, Y1 } = region;
  const inForbidden = (px, py) => forbiddenAt(px, py) !== null;

  const pgrid = new Map();
  const addPlaced = ([x, y]) => {
    const k = key(cellOf(x), cellOf(y));
    if (!pgrid.has(k)) pgrid.set(k, []);
    pgrid.get(k).push([x, y]);
  };
  points.forEach(addPlaced);
  const crowded = (px, py, d) => {
    for (let gx = cellOf(px) - 1; gx <= cellOf(px) + 1; gx++) {
      for (let gy = cellOf(py) - 1; gy <= cellOf(py) + 1; gy++) {
        for (const [qx, qy] of pgrid.get(key(gx, gy)) ?? []) if (Math.hypot(px - qx, py - qy) < d) return true;
      }
    }
    return false;
  };

  const cliffs = lines.filter(({ code }) => startsWithAny(code, ["201", "202"])).flatMap(({ pts }) => pts);
  const candidate = (nearCliff) => {
    if (nearCliff && cliffs.length) {
      const [bx, by] = rng.choice(cliffs);
      const a = rng.uniform(0, 2 * Math.PI);
      const r = rng.uniform(1200, 9000);
      return [Math.trunc(bx + r * Math.cos(a)), Math.trunc(by + r * Math.sin(a))];
    }
    return [rng.randint(X0, X1), rng.randint(Y0, Y1)];
  };

  const added = [];
  const placed = {};
  for (const { code, count, cliffShare, clear } of INJECTION_PLAN) {
    if (!code2id.has(code)) continue;
    let got = 0;
    let tries = 0;
    while (got < count && tries < count * 400) {
      tries++;
      const [x, y] = candidate(rng.random() < cliffShare);
      if (!(X0 <= x && x <= X1 && Y0 <= y && y <= Y1)) continue;
      if (nearLine(x, y, clear)) continue;
      if (LANDFORM.some((c) => code.startsWith(c)) && nearLine(x, y, 900, ["101", "102"])) continue;
      if (crowded(x, y, 1300)) continue;
      if (inForbidden(x, y)) continue;
      const rot = code === "110" ? ` rotation="${rng.uniform(0, Math.PI).toFixed(4)}"` : "";
      added.push(`<object type="0" symbol="${code2id.get(code)}"${rot}><tags>${INJECTED_TAG}</tags><coords count="1">${x} ${y};</coords></object>`);
      addPlaced([x, y]);
      got++;
    }
    placed[code] = got;
  }

  const part = /(<part name="points"><objects count=")(\d+)(">)/.exec(text);
  if (!part) throw new Error('injectDemoPoints: the map has no <part name="points">');
  let out =
    text.slice(0, part.index) +
    part[1] +
    String(parseInt(part[2], 10) + added.length) +
    part[3] +
    "\n" +
    added.join("\n") +
    text.slice(part.index + part[0].length);
  out = out.replace("<notes></notes>", () => `<notes>${DEMO_NOTE}</notes>`);
  return { text: out, placed };
}
