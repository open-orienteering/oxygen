import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildE2eTestOcad,
  buildShowcaseOcad,
  SHOWCASE_OCAD,
  assertShowcaseOcadClean,
  pgByteaLiteral,
} from "../lib/ocad-fixture.mjs";
import {
  replaceShowcaseMapFile,
  extractMapFileFromSql,
  countMapTileInserts,
  FORBIDDEN_SHOWCASE_SQL,
} from "../lib/showcase-sql.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(path.join(ROOT, "packages/api/package.json"));

describe("OCAD fixtures", () => {
  it("rebuilds e2e/test.ocd byte-identically", () => {
    const committed = readFileSync(path.join(ROOT, "e2e/test.ocd"));
    const generated = buildE2eTestOcad();
    assert.equal(generated.length, committed.length);
    assert.ok(committed.equals(generated), "generated e2e/test.ocd must match the committed file");
  });

  it("builds a small synthetic showcase map with the demo CRS", async () => {
    const buf = buildShowcaseOcad();
    assertShowcaseOcadClean(buf);
    assert.ok(buf.length < 80_000, `expected small OCAD, got ${buf.length}`);
    assert.equal(SHOWCASE_OCAD.fileName, "demo-map.ocd");

    const { readOcad } = require("ocad2geojson");
    const file = await readOcad(buf, { quietWarnings: true });
    const crs = file.getCrs();
    assert.equal(crs.scale, SHOWCASE_OCAD.scale);
    assert.equal(crs.easting, SHOWCASE_OCAD.easting);
    assert.equal(crs.northing, SHOWCASE_OCAD.northing);

    const [minX, minY, maxX, maxY] = file.getBounds();
    const [eMinX, eMinY, eMaxX, eMaxY] = SHOWCASE_OCAD.bounds;
    const slack = 500;
    assert.ok(Math.abs(minX - eMinX) <= slack, `minX ${minX} vs ${eMinX}`);
    assert.ok(Math.abs(minY - eMinY) <= slack, `minY ${minY} vs ${eMinY}`);
    assert.ok(Math.abs(maxX - eMaxX) <= slack, `maxX ${maxX} vs ${eMaxX}`);
    assert.ok(Math.abs(maxY - eMaxY) <= slack, `maxY ${maxY} vs ${eMaxY}`);
  });

  it("parses as a renderable OCAD map with terrain objects", async () => {
    const { readOcad } = require("ocad2geojson");
    const file = await readOcad(buildShowcaseOcad(), { quietWarnings: true });
    assert.ok((file.objects?.length ?? 0) > 5, "expected synthetic terrain objects");
    assert.ok(file.getBounds().length === 4);
  });
});

describe("showcase SQL map substitution", () => {
  it("substitutes map_files and drops identifying source-map names from the SQL", () => {
    const ocad = buildShowcaseOcad();
    const sql = [
      "-- header",
      `INSERT INTO map_files ("event_id", "file_name", "file_data", "uploaded_at") VALUES (9876543, E'Vinter Flaten kartutsitt.ocd', '\\x${"aa".repeat(100)}'::bytea, '2026-01-01T00:00:00.000Z');`,
      "-- H:\\Delade enheter\\Skogsluffarna\\Arrangemang",
    ].join("\n");

    const out = replaceShowcaseMapFile(sql, ocad);
    assert.match(out, /demo-map\.ocd/);
    assert.doesNotMatch(out, /Vinter Flaten/);
    assert.doesNotMatch(out, /kartutsitt/);
    assert.match(out, new RegExp(pgByteaLiteral(ocad).replace(/\\/g, "\\\\")));
    assert.equal((out.match(/INSERT INTO map_tiles/g) || []).length, 0);
  });

  it("keeps the committed fixture on the generated showcase OCAD", () => {
    const sql = readFileSync(
      path.join(ROOT, "docs/screenshots/fixtures/showcase.sql"),
      "utf8",
    );
    assert.equal(countMapTileInserts(sql), 0);
    const map = extractMapFileFromSql(sql);
    assert.equal(map?.fileName, SHOWCASE_OCAD.fileName);
    assert.ok(map?.data);
    assertShowcaseOcadClean(map.data);
    assert.ok(map.data.equals(buildShowcaseOcad()));
    assert.ok(map.data.length < 80_000);
    for (const re of FORBIDDEN_SHOWCASE_SQL) {
      assert.equal(re.test(map.fileName), false, `filename matched ${re}`);
      assert.equal(re.test(map.data.toString("latin1")), false, `OCAD matched ${re}`);
    }
    assert.doesNotMatch(sql.slice(sql.indexOf("INSERT INTO map_files")), /Vinter Flaten|kartutsitt|Delade enheter/);
  });
});
