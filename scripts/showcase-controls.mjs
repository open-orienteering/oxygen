#!/usr/bin/env node
/**
 * The Demo Competition's control positions (docs/ops/demo.md, "Controls on
 * the demo map"):
 *
 *   node scripts/showcase-controls.mjs fit <source.sql> [--max-scale <f>]
 *       First placement: fit the control cloud of <source.sql> (a fixture
 *       holding the source event's positions, e.g. a fresh anonymiser
 *       dump) onto the demo map (the quarter turn and place where the
 *       fewest legs cross water or buildings), move each control onto a nearby point
 *       feature and each start and finish onto a path, and write
 *       showcase-controls.json. The scale is capped at <f> (default 1:
 *       the source and demo maps are both 1:15 000, so legs keep their
 *       terrain length).
 *   DATABASE_URL=… node scripts/showcase-controls.mjs export [--event demo_competition]
 *       Read the positions of a loaded demo event (after moving controls in
 *       the course editor) and write showcase-controls.json.
 *   node scripts/showcase-controls.mjs apply
 *       Write showcase-controls.json into showcase.sql: control positions,
 *       course legs and lengths.
 *
 * `fit` and `export` print the controls that sit in water, fight,
 * cultivated land, a paved area or a building, so they can be moved first.
 */

import { readFileSync, writeFileSync } from "node:fs";
import {
  CONTROLS_JSON_PATH,
  applyControls,
  controlsDocument,
  courseLegs,
  demoMapRegion,
  exportControls,
  pgClient,
  placeControls,
  readFixtureRows,
  serialiseControls,
} from "./lib/showcase-controls.mjs";
import { DEMO_MAP_PATH } from "./lib/showcase-map.mjs";
import { FIXTURE_PATH } from "./lib/showcase-sql.mjs";

const [command, ...rest] = process.argv.slice(2);

const loadRegion = () => demoMapRegion(readFileSync(DEMO_MAP_PATH));

async function reportForbidden(doc) {
  const region = await loadRegion();
  const bad = doc.controls.filter((c) => (c.xpos !== 0 || c.ypos !== 0) && region.forbiddenAt(c.xpos, c.ypos));
  for (const c of bad) console.log(`  seq ${c.seq} (${c.codes || c.name}) is in ISOM ${region.forbiddenAt(c.xpos, c.ypos)}`);
  const outside = doc.controls.filter((c) => (c.xpos !== 0 || c.ypos !== 0) && (c.xpos < region.minX || c.xpos > region.maxX || c.ypos < region.minY || c.ypos > region.maxY));
  for (const c of outside) console.log(`  seq ${c.seq} (${c.codes || c.name}) is outside the mapped area`);
}

async function write(doc) {
  writeFileSync(CONTROLS_JSON_PATH, serialiseControls(doc));
  console.log(`wrote ${CONTROLS_JSON_PATH} (${doc.controls.length} controls)`);
  await reportForbidden(doc);
  console.log("next: node scripts/showcase-controls.mjs apply");
}

if (command === "fit") {
  const [src] = rest;
  if (!src) throw new Error("usage: showcase-controls.mjs fit <source.sql> [--max-scale <f>]");
  const i = rest.indexOf("--max-scale");
  const maxScale = i >= 0 ? Number(rest[i + 1]) : undefined;
  if (maxScale !== undefined && !(maxScale > 0)) throw new Error("--max-scale takes a positive number");
  const fixture = readFixtureRows(readFileSync(src, "utf8"));
  const region = await loadRegion();
  const place = placeControls(fixture.controls, region, { maxScale, legs: courseLegs(fixture) });
  console.log(`fit: ${place.rotation} quarter turn(s), scale ×${place.scale.toFixed(3)}, shifted (${place.offset.join(", ")}) mm`);
  console.log(`legs through water, out-of-bounds or a building: ${place.crossings}`);
  console.log(`snap: ${place.snapped} moved onto a feature or path`);
  for (const c of place.kept) console.log(`  seq ${c.seq} (${c.codes || c.name}) has no free feature within reach; it keeps its fitted place`);
  await write(controlsDocument(place.rows));
} else if (command === "export") {
  const i = rest.indexOf("--event");
  const nameId = i >= 0 ? rest[i + 1] : "demo_competition";
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("export reads DATABASE_URL");
  const client = pgClient(url);
  await client.connect();
  try {
    await write(await exportControls(client, nameId));
  } finally {
    await client.end();
  }
} else if (command === "apply") {
  const doc = JSON.parse(readFileSync(CONTROLS_JSON_PATH, "utf8"));
  const before = readFileSync(FIXTURE_PATH, "utf8");
  const after = await applyControls(before, doc);
  writeFileSync(FIXTURE_PATH, after);
  console.log(after === before ? `${FIXTURE_PATH} already holds these positions` : `patched ${FIXTURE_PATH}`);
} else {
  console.error("usage: showcase-controls.mjs fit <source.sql> [--max-scale <f>] | export [--event <nameId>] | apply");
  process.exit(2);
}
