#!/usr/bin/env node
/**
 * The Demo Competition's control positions (docs/demo.md, "Controls on
 * the demo map"):
 *
 *   node scripts/showcase-controls.mjs fit <source.sql>
 *       First placement: fit the control cloud of <source.sql> (a fixture
 *       still holding the source event's positions, e.g. a fresh
 *       anonymiser dump) onto the demo map and write showcase-controls.json.
 *   DATABASE_URL=… node scripts/showcase-controls.mjs export [--event demo_competition]
 *       Read the positions of a loaded demo event (after moving controls in
 *       the course editor) and write showcase-controls.json.
 *   node scripts/showcase-controls.mjs apply
 *       Write showcase-controls.json into showcase.sql: control positions,
 *       course legs and lengths.
 *
 * `fit` and `export` print the controls that sit in water, cultivated
 * land, a paved area or a building, so they can be moved first.
 */

import { readFileSync, writeFileSync } from "node:fs";
import {
  CONTROLS_JSON_PATH,
  applyControls,
  controlsDocument,
  demoMapRegion,
  exportControls,
  fitControls,
  pgClient,
  readFixtureRows,
  serialiseControls,
} from "./lib/showcase-controls.mjs";
import { DEMO_MAP_PATH } from "./lib/showcase-map.mjs";
import { FIXTURE_PATH } from "./lib/showcase-sql.mjs";

const [command, ...rest] = process.argv.slice(2);

function reportForbidden(doc) {
  const region = demoMapRegion(readFileSync(DEMO_MAP_PATH, "utf8"));
  const bad = doc.controls.filter((c) => (c.xpos !== 0 || c.ypos !== 0) && region.forbiddenAt(c.xpos, c.ypos));
  for (const c of bad) console.log(`  seq ${c.seq} (${c.codes || c.name}) is in ISOM ${region.forbiddenAt(c.xpos, c.ypos)}`);
  const outside = doc.controls.filter((c) => (c.xpos !== 0 || c.ypos !== 0) && (c.xpos < region.minX || c.xpos > region.maxX || c.ypos < region.minY || c.ypos > region.maxY));
  for (const c of outside) console.log(`  seq ${c.seq} (${c.codes || c.name}) is outside the mapped area`);
}

function write(doc) {
  writeFileSync(CONTROLS_JSON_PATH, serialiseControls(doc));
  console.log(`wrote ${CONTROLS_JSON_PATH} (${doc.controls.length} controls)`);
  reportForbidden(doc);
  console.log("next: node scripts/showcase-controls.mjs apply");
}

if (command === "fit") {
  const [src] = rest;
  if (!src) throw new Error("usage: showcase-controls.mjs fit <source.sql>");
  const { controls } = readFixtureRows(readFileSync(src, "utf8"));
  const region = demoMapRegion(readFileSync(DEMO_MAP_PATH, "utf8"));
  const fit = fitControls(controls, region);
  console.log(`fit: ${fit.rotation} quarter turn(s), scale ×${fit.scale.toFixed(3)}`);
  write(controlsDocument(fit.rows));
} else if (command === "export") {
  const i = rest.indexOf("--event");
  const nameId = i >= 0 ? rest[i + 1] : "demo_competition";
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("export reads DATABASE_URL");
  const client = pgClient(url);
  await client.connect();
  try {
    write(await exportControls(client, nameId));
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
  console.error("usage: showcase-controls.mjs fit <source.sql> | export [--event <nameId>] | apply");
  process.exit(2);
}
