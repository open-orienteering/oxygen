/**
 * The Demo Competition's control positions (docs/demo.md, "Controls on
 * the demo map"). The race data — controls, courses, runners, punches —
 * comes from a real event; only the control positions belong to the demo
 * map. They live in `docs/screenshots/fixtures/showcase-controls.json`,
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
 * Positions are paper mm in the map document's frame (y up), the unit of
 * `controls.xpos/ypos`; (0, 0) is "not placed" and stays so.
 */

import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { analyseOmap } from "./inject-demo-points.mjs";
import { loadApiModules } from "./showcase-map.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CONTROLS_JSON_PATH = path.join(ROOT, "docs", "screenshots", "fixtures", "showcase-controls.json");

/** The demo map's scale; the source event's map was 1:15 000. */
export const DEMO_MAP_SCALE = 10000;
export const SOURCE_MAP_SCALE = 15000;
/** Distance kept between the fitted cloud and the map region's edge, mm. */
export const FIT_MARGIN_MM = 15;

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

/**
 * The demo map's region in document mm (y up): the contours' bounding box
 * shrunk by 6 mm (the injection's region), and the forbidden-area test —
 * water, cultivated land, paved areas, buildings — in the same frame.
 */
export function demoMapRegion(omapText) {
  const { region, forbiddenAt } = analyseOmap(omapText);
  return {
    minX: region.X0 / 1000,
    maxX: region.X1 / 1000,
    minY: -region.Y1 / 1000,
    maxY: -region.Y0 / 1000,
    forbiddenAt: (xMm, yMm) => forbiddenAt(Math.round(xMm * 1000), Math.round(-yMm * 1000)),
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
export function fitControls(rows, region, { margin = FIT_MARGIN_MM, maxScale = SOURCE_MAP_SCALE / DEMO_MAP_SCALE } = {}) {
  const placed = rows.filter((c) => c.xpos !== 0 || c.ypos !== 0);
  if (placed.length === 0) return { rows, rotation: 0, scale: 1 };
  const width = region.maxX - region.minX - 2 * margin;
  const height = region.maxY - region.minY - 2 * margin;
  let best = null;
  ROTATIONS.forEach((rotate, k) => {
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
    return { ...c, xpos: num(rx + (x - cx) * scale), ypos: num(ry + (y - cy) * scale) };
  });
  return { rows: out, rotation: k, scale };
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
