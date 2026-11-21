import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CONTROLS_JSON_PATH,
  applyControls,
  controlsDocument,
  courseLegs,
  demoMapRegion,
  exportControls,
  fitControls,
  legCrossesBlocked,
  nearMapEdge,
  placeControls,
  snapControls,
  parseInsert,
  readFixtureRows,
  serialiseControls,
  splitSqlValues,
  sqlValue,
} from "../lib/showcase-controls.mjs";
import { DEMO_MAP_PATH } from "../lib/showcase-map.mjs";
import { FIXTURE_PATH } from "../lib/showcase-sql.mjs";

// The Demo Competition's control positions (docs/ops/demo.md, "Controls on the
// demo map"): fitted once, adjusted in the editor, exported and applied.

const CONTROL_COLS = ["id", "event_id", "seq", "name", "codes", "status", "xpos", "ypos", "lat", "lng", "removed", "kind"];
const control = (id, seq, status, x, y, extra = {}) => ({ id, seq, name: extra.name ?? "", codes: extra.codes ?? String(seq), status, xpos: x, ypos: y, removed: extra.removed ?? false, kind: extra.kind ?? "control" });
const controlLine = (c) =>
  `INSERT INTO controls (${CONTROL_COLS.map((n) => `"${n}"`).join(", ")}) VALUES ('${c.id}'::uuid, 1, ${c.seq}, E'${c.name}', E'${c.codes}', E'${c.status}'::oxygen.control_status, ${c.xpos}, ${c.ypos}, 59.25, 18.15, ${c.removed ? "TRUE" : "FALSE"}, E'${c.kind}');`;

/** A two-control course from a start: legs 300 m and 400 m at 1:10 000 once applied. */
function tinyFixture() {
  const controls = [
    control("s", 900, "start", 1, 1, { name: "Start 1", codes: "" }),
    control("a", 31, "ok", 2, 2),
    control("b", 32, "ok", 3, 3),
    control("f", 901, "finish", 4, 4, { name: "Mål", codes: "" }),
    control("u", 1, "clear", 0, 0),
  ];
  const lines = [
    "-- head",
    ...controls.map(controlLine),
    `INSERT INTO courses ("id", "name", "length_m", "start_name", "legs", "first_as_start", "last_as_finish", "finish_control_id", "removed", "order_mode", "structure", "length_source") VALUES ('k'::uuid, E'A', 999, E'Start 1', E'1;2;', FALSE, FALSE, NULL, FALSE, E'ordered'::oxygen.course_order_mode, E'{"id":"x","items":[{"siteId":"stale"}]}'::jsonb, E'derived');`,
    `INSERT INTO course_controls ("course_id", "position", "control_id") VALUES ('k'::uuid, 2, 'b'::uuid);`,
    `INSERT INTO course_controls ("course_id", "position", "control_id") VALUES ('k'::uuid, 1, 'a'::uuid);`,
    "-- tail",
  ];
  const doc = {
    scale: 10000,
    controls: [
      { seq: 1, codes: "1", name: "", xpos: 0, ypos: 0 },
      { seq: 31, codes: "31", name: "", xpos: 0, ypos: 30 },
      { seq: 32, codes: "32", name: "", xpos: 40, ypos: 30 },
      { seq: 900, codes: "", name: "Start 1", xpos: 0, ypos: 0.01 },
      { seq: 901, codes: "", name: "Mål", xpos: 40, ypos: 30 },
    ],
  };
  return { sql: lines.join("\n"), doc };
}

describe("fixture SQL rows", () => {
  it("splits a VALUES list on top-level commas only", () => {
    assert.deepEqual(splitSqlValues(`'a'::uuid, E'x, y', E'it''s', E'back\\\\slash\\', still', NULL, -1.5, TRUE, E'{"a":[1,2]}'::jsonb`), [
      `'a'::uuid`,
      `E'x, y'`,
      `E'it''s'`,
      `E'back\\\\slash\\', still'`,
      "NULL",
      "-1.5",
      "TRUE",
      `E'{"a":[1,2]}'::jsonb`,
    ]);
    assert.equal(sqlValue(`E'it''s'`), "it's");
    assert.equal(sqlValue(`E'ordered'::oxygen.course_order_mode`), "ordered");
    assert.equal(sqlValue("NULL"), null);
    assert.equal(sqlValue("-33.01"), -33.01);
  });

  it("reads every control, course and course control of the committed fixture", () => {
    const rows = readFixtureRows(readFileSync(FIXTURE_PATH, "utf8"));
    assert.equal(rows.controls.length, 37);
    assert.equal(rows.courses.length, 5);
    assert.equal(rows.courseControls.length, 62);
    assert.equal(new Set(rows.controls.map((c) => c.seq)).size, 37, "seq is the positions file's key");
  });

  it("refuses an INSERT whose values do not match its columns", () => {
    assert.throws(() => parseInsert(`INSERT INTO controls ("a", "b") VALUES (1);`), /2 columns, 1 values/);
  });
});

describe("fit", () => {
  const region = { minX: -100, maxX: 100, minY: -50, maxY: 50 };

  it("keeps the relative layout: one rotation, one scale, unplaced controls untouched", () => {
    // A cloud taller than wide: the region is wider, so a quarter turn fits it larger.
    const rows = [control("a", 1, "ok", 0, 0), control("b", 2, "ok", 10, 0), control("c", 3, "ok", 10, 60), control("d", 4, "ok", 0, 60), control("e", 5, "ok", 5, 30)];
    rows[0] = { ...rows[0], xpos: 0.0001 }; // placed (not exactly 0, 0)
    const unplaced = control("u", 6, "clear", 0, 0);
    const fit = fitControls([...rows, unplaced], region, { margin: 10, maxScale: 1.5 });
    assert.equal(fit.rotation % 2, 1, "a quarter turn");
    assert.ok(fit.scale <= 1.5);
    const out = fit.rows;
    assert.deepEqual(out[5], unplaced);
    const d = (p, q) => Math.hypot(p.xpos - q.xpos, p.ypos - q.ypos);
    const ratio = d(out[1], out[2]) / d(rows[1], rows[2]);
    for (const [i, j] of [[0, 1], [0, 3], [1, 3], [2, 4]]) assert.ok(Math.abs(d(out[i], out[j]) / d(rows[i], rows[j]) - ratio) < 0.01, `pair ${i},${j}`);
    for (const c of out.slice(0, 5)) {
      assert.ok(c.xpos >= region.minX + 10 - 0.01 && c.xpos <= region.maxX - 10 + 0.01, `x ${c.xpos}`);
      assert.ok(c.ypos >= region.minY + 10 - 0.01 && c.ypos <= region.maxY - 10 + 0.01, `y ${c.ypos}`);
    }
    assert.deepEqual(fitControls([...rows, unplaced], region, { margin: 10, maxScale: 1.5 }), fit, "deterministic");
  });

  it("caps the scale at the ratio of the map scales (both 1:15 000), keeping terrain lengths when the cloud fits", () => {
    const rows = [control("a", 1, "ok", 1, 1), control("b", 2, "ok", 11, 1)];
    assert.equal(fitControls(rows, region).scale, 1);
    const half = fitControls(rows, region, { maxScale: 0.5 });
    assert.equal(half.scale, 0.5);
    assert.equal(Math.hypot(half.rows[0].xpos - half.rows[1].xpos, half.rows[0].ypos - half.rows[1].ypos), 5);
    assert.equal(fitControls(rows, region, { rotation: 1 }).rotation, 1, "a fixed quarter turn");
  });
});

/** A synthetic map: 100 × 100 mm, a lake in x 40…60, features on a grid, a path along y = 0. */
function syntheticRegion() {
  const features = [];
  for (let x = -45; x <= 45; x += 5) for (let y = -45; y <= 45; y += 5) if (x < 40 || x > 60) features.push({ x, y, symbol: "204" });
  const lake = (x, y) => x > 40 && x < 60 && y > -50 && y < 50;
  return {
    minX: -50, maxX: 50, minY: -50, maxY: 50,
    features: features.filter((f) => !lake(f.x, f.y)),
    paths: [[-50, 0, 50, 0]],
    forbiddenAt: (x, y) => (lake(x, y) ? "301" : null),
    blockedAt: lake,
    mappedAt: (x, y) => Math.abs(x) <= 50 && Math.abs(y) <= 50,
  };
}

describe("snap and place", () => {
  it("moves each control onto the nearest free feature within reach, starts and finishes onto a path, keeping 4 mm apart", () => {
    const region = syntheticRegion();
    const rows = [
      control("s", 900, "start", 1, 3, { name: "Start 1", codes: "" }),
      control("a", 31, "ok", 1.2, 1.1),
      control("b", 32, "ok", 1.4, 1.3), // nearest feature (0, 0) is a's; (5, 0) is 3.7 mm from it: too close; next is beyond 4 mm
      control("f", 901, "finish", 20, -2, { name: "Mål", codes: "" }),
      control("u", 1, "clear", 0, 0),
      control("x", 33, "ok", -49.9, 30, { removed: false }),
    ];
    const { rows: out, snapped, kept } = snapControls(rows, region, { radius: 6, spacing: 4 });
    const at = (seq) => out.find((c) => c.seq === seq);
    assert.deepEqual([at(900).xpos, at(900).ypos], [1, 0], "start onto the path");
    assert.deepEqual([at(901).xpos, at(901).ypos], [20, 0], "finish onto the path");
    assert.deepEqual([at(31).xpos, at(31).ypos], [0, 0]);
    const b = at(32);
    assert.ok(Math.hypot(b.xpos, b.ypos) >= 4, "spaced from 31");
    assert.ok(region.features.some((f) => f.x === b.xpos && f.y === b.ypos));
    assert.deepEqual(at(1), rows[4], "unplaced stays unplaced");
    assert.equal(snapped, 5);
    assert.deepEqual(kept, []);
    assert.deepEqual(snapControls(rows, region), snapControls(rows, region), "deterministic");
  });

  it("keeps a control with no feature within reach where it was", () => {
    const region = { ...syntheticRegion(), features: [] };
    const { rows: out, kept } = snapControls([control("a", 31, "ok", 3, 3)], region);
    assert.deepEqual([out[0].xpos, out[0].ypos], [3, 3]);
    assert.equal(kept.length, 1);
  });

  it("tests a leg's line against uncrossable areas, and a control's clearance from the map's edge", () => {
    const region = syntheticRegion();
    assert.equal(legCrossesBlocked({ xpos: 30, ypos: 0 }, { xpos: 70, ypos: 0 }, region), true);
    assert.equal(legCrossesBlocked({ xpos: 30, ypos: 0 }, { xpos: 35, ypos: 20 }, region), false);
    assert.equal(nearMapEdge({ xpos: 0, ypos: 0 }, region), false);
    assert.equal(nearMapEdge({ xpos: 45, ypos: 0 }, region), true);
  });

  it("places the cloud where no leg crosses the lake and every control finds a feature", () => {
    const region = syntheticRegion();
    // A 10 mm leg: at the fit's centre (x 0) it is clear of the lake, but the search must also keep it so.
    const rows = [control("a", 31, "ok", 0, 0), control("b", 32, "ok", 10, 0)];
    const place = placeControls(rows, region, { legs: [[31, 32]], maxScale: 1 });
    assert.equal(place.crossings, 0);
    assert.equal(place.kept.length, 0);
    for (const c of place.rows) {
      assert.equal(region.forbiddenAt(c.xpos, c.ypos), null);
      assert.equal(nearMapEdge(c, region), false);
    }
    assert.deepEqual(placeControls(rows, region, { legs: [[31, 32]], maxScale: 1 }), place, "deterministic");
  });

  it("reads the fixture's legs: start, controls in order, finish", () => {
    const { sql } = tinyFixture();
    assert.deepEqual(courseLegs(readFixtureRows(sql)), [[900, 31], [31, 32], [32, 901]]);
  });
});

describe("the demo map", () => {
  let region;
  before(async () => {
    region = await demoMapRegion(readFileSync(DEMO_MAP_PATH));
  });

  it("reads the region, forbidden areas, features and paths in document mm", () => {
    // Inside the imported document's bounds (x −87.6…82.7, y −108.8…107.5 mm).
    assert.ok(region.minX > -87.7 && region.maxX < 82.8 && region.minY > -108.9 && region.maxY < 107.6 && region.minX < region.maxX && region.minY < region.maxY);
    const kinds = new Set();
    for (let x = Math.ceil(region.minX); x < region.maxX; x += 2) for (let y = Math.ceil(region.minY); y < region.maxY; y += 2) kinds.add(region.forbiddenAt(x, y));
    assert.ok(kinds.has(null), "most of the map is runnable");
    assert.ok([...kinds].some((k) => typeof k === "string" && /^(301|521)/.test(k)), "and some of it is not");
    assert.ok(region.features.length > 500, "the invented boulders and landforms");
    assert.ok(region.paths.length > 100);
    // The map is slanted: a corner of the contours' box is not drawn.
    assert.equal(region.mappedAt(region.maxX - 1, region.maxY - 1) && region.mappedAt(region.minX + 1, region.maxY - 1) && region.mappedAt(region.maxX - 1, region.minY + 1) && region.mappedAt(region.minX + 1, region.minY + 1), false);
  });

  it("the committed positions stand on the map's features, clear of forbidden areas and the map's edge", () => {
    const doc = JSON.parse(readFileSync(CONTROLS_JSON_PATH, "utf8"));
    assert.equal(doc.scale, 15000);
    const placed = doc.controls.filter((c) => c.xpos !== 0 || c.ypos !== 0);
    assert.ok(placed.length >= 30);
    const { controls } = readFixtureRows(readFileSync(FIXTURE_PATH, "utf8"));
    const kind = new Map(controls.map((c) => [c.seq, c.status]));
    for (const c of placed) {
      assert.equal(region.forbiddenAt(c.xpos, c.ypos), null, `seq ${c.seq} in a forbidden area`);
      assert.equal(nearMapEdge(c, region), false, `seq ${c.seq} near the map's edge`);
      if (kind.get(c.seq) === "start" || kind.get(c.seq) === "finish") continue;
      assert.ok(region.features.some((f) => Math.hypot(f.x - c.xpos, f.y - c.ypos) < 0.02), `seq ${c.seq} is not on a feature`);
    }
  });
});

describe("apply", () => {
  it("writes positions, clears lat/lng and the stale structure, and re-derives legs and length", async () => {
    const { sql, doc } = tinyFixture();
    const out = await applyControls(sql, doc);
    const rows = readFixtureRows(out);
    const bySeq = new Map(rows.controls.map((c) => [c.seq, c]));
    assert.deepEqual([bySeq.get(31).xpos, bySeq.get(31).ypos], [0, 30]);
    assert.deepEqual([bySeq.get(901).xpos, bySeq.get(901).ypos], [40, 30]);
    for (const c of rows.controls) assert.deepEqual([c.lat, c.lng], [null, null]);
    const [course] = rows.courses;
    // Start (0, 0.01) → 31 (0, 30) → 32 (40, 30) → finish (40, 30): 29.99 + 40 + 0 mm at 1:10 000.
    assert.equal(course.legs, "300;400;0;");
    assert.equal(course.length_m, 700);
    assert.equal(course.length_source, "derived");
    assert.equal(course.structure, null);
    assert.ok(out.startsWith("-- head\n") && out.endsWith("\n-- tail"));
    assert.equal(await applyControls(out, doc), out, "applying twice changes nothing");
  });

  it("refuses a positions file that does not match the fixture's controls", async () => {
    const { sql, doc } = tinyFixture();
    await assert.rejects(applyControls(sql, { ...doc, controls: doc.controls.slice(1) }), /no entry for control seq 1/);
    await assert.rejects(applyControls(sql, { ...doc, controls: [...doc.controls, { seq: 77, xpos: 1, ypos: 1 }] }), /seq 77/);
    await assert.rejects(applyControls(sql, { ...doc, controls: [...doc.controls, doc.controls[0]] }), /appears twice/);
  });

  it("the committed fixture holds the committed positions", async () => {
    const sql = readFileSync(FIXTURE_PATH, "utf8");
    const doc = JSON.parse(readFileSync(CONTROLS_JSON_PATH, "utf8"));
    assert.equal(await applyControls(sql, doc), sql, "run `node scripts/showcase-controls.mjs apply`");
    assert.equal(serialiseControls(doc), readFileSync(CONTROLS_JSON_PATH, "utf8"), "the positions file is in the export's format");
  });
});

describe("export", () => {
  it("reads an event's positions in the file's shape, ordered by seq", async () => {
    const queries = [];
    const client = {
      async query(text, params) {
        queries.push([text, params]);
        return { rows: [{ seq: "32", codes: "32", name: "", xpos: 4.567, ypos: -1 }, { seq: "31", codes: "31", name: "", xpos: 0, ypos: 0 }] };
      },
    };
    const doc = await exportControls(client, "demo_competition");
    assert.deepEqual(queries[0][1], ["demo_competition"]);
    assert.deepEqual(doc, { scale: 15000, controls: [{ seq: 31, codes: "31", name: "", xpos: 0, ypos: 0 }, { seq: 32, codes: "32", name: "", xpos: 4.57, ypos: -1 }] });
    assert.deepEqual(controlsDocument(doc.controls), doc);
    assert.equal(serialiseControls(doc), `{\n  "scale": 15000,\n  "controls": [\n    {"seq":31,"codes":"31","name":"","xpos":0,"ypos":0},\n    {"seq":32,"codes":"32","name":"","xpos":4.57,"ypos":-1}\n  ]\n}\n`);
    await assert.rejects(exportControls({ query: async () => ({ rows: [] }) }, "nope"), /No controls for event nope/);
  });
});
