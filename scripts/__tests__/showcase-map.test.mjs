import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildShowcaseOcad, assertShowcaseOcadClean, SHOWCASE_OCAD } from "../lib/ocad-fixture.mjs";
import { buildShowcaseMapRows } from "../lib/showcase-map.mjs";
import {
  mapSourceInsert,
  mapDocumentInsert,
  mapFileInsert,
  replaceShowcaseMap,
  extractShowcaseMap,
  legacyMapStorageUses,
  FORBIDDEN_SHOWCASE_SQL,
} from "../lib/showcase-sql.mjs";

// The Demo Competition's map on the document pipeline (docs/demo.md,
// docs/map-storage.md): a map_sources row, the map_documents row the
// importer makes of it, and the pinned map_files row.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE = path.join(ROOT, "docs/screenshots/fixtures/showcase.sql");
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const REPIN = "run `node scripts/patch-showcase-map.mjs` to re-pin the committed fixture";

describe("showcase map rows", () => {
  let rows;
  before(async () => {
    rows = await buildShowcaseMapRows();
  });

  it("imports the synthetic OCAD into a source, a document and a pin that agree", () => {
    assert.equal(rows.source.kind, "ocad");
    assert.equal(rows.source.fileName, SHOWCASE_OCAD.fileName);
    assert.equal(rows.source.fileHash, sha256(rows.source.bytes));
    assert.ok(rows.source.bytes.equals(buildShowcaseOcad()));
    assert.equal(rows.document.hash, sha256(rows.document.bytes));
    assert.equal(rows.document.sourceHash, rows.source.fileHash);
    assert.equal(rows.document.sizeBytes, rows.document.bytes.length);
    assert.equal(rows.pin.sourceHash, rows.source.fileHash);
    assert.equal(rows.pin.documentHash, rows.document.hash);
  });

  it("resolves the SWEREF99 TM georeference and the pin's quick-access columns", () => {
    const geo = rows.document.header.georeferencing;
    assert.equal(geo.crs?.code, 3006);
    assert.equal(rows.document.header.mapScale, SHOWCASE_OCAD.scale);
    assert.equal(rows.pin.scale, SHOWCASE_OCAD.scale);
    assert.ok(rows.pin.bounds && rows.pin.bounds.west < rows.pin.bounds.east && rows.pin.bounds.south < rows.pin.bounds.north);
    assert.equal(rows.pin.calibration?.length, 4);
    assert.equal(typeof rows.pin.northOffset, "number");
    assert.equal(rows.document.report.warnings.some((w) => w.code === "CRS_UNRESOLVED"), false);
  });

  it("is byte-identical on a second run (fixed report date, zeroed timings)", async () => {
    const again = await buildShowcaseMapRows();
    assert.equal(again.document.hash, rows.document.hash);
    assert.deepEqual(again.document.report, rows.document.report);
    assert.deepEqual(again.pin, rows.pin);
  });

  it("computes the pin's columns under the row's rotation correction", async () => {
    const rotated = await buildShowcaseMapRows({ rotationCorrection: 3 });
    assert.equal(rotated.document.hash, rows.document.hash);
    assert.equal(rotated.pin.rotationCorrection, 3);
    assert.notDeepEqual(rotated.pin.calibration, rows.pin.calibration);
  });

  it("carries nothing identifying", () => {
    assertShowcaseOcadClean(rows.source.bytes);
    const text = JSON.stringify([rows.document.header, rows.document.report]) + rows.document.bytes.toString("latin1");
    for (const re of FORBIDDEN_SHOWCASE_SQL) assert.equal(re.test(text), false, `document matched ${re}`);
  });
});

describe("showcase map SQL", () => {
  let rows;
  before(async () => {
    rows = await buildShowcaseMapRows();
  });

  it("writes content-addressed rows as ON CONFLICT DO NOTHING single lines, without dropped columns", () => {
    const lines = [mapSourceInsert(rows.source), mapDocumentInsert(rows.document), mapFileInsert({ eventId: 9876543, uploadedAt: "2026-01-01T00:00:00.000Z" }, rows.pin, rows.source.fileName)];
    for (const line of lines) assert.equal(line.includes("\n"), false);
    assert.match(lines[0], /ON CONFLICT \("file_hash"\) DO NOTHING;$/);
    assert.match(lines[1], /ON CONFLICT \("hash"\) DO NOTHING;$/);
    assert.deepEqual(legacyMapStorageUses(lines.join("\n")), []);
    assert.match(lines[2], new RegExp(`'${rows.source.fileHash}', '${rows.document.hash}'\\);$`));
  });

  it("flags SQL that writes the storage the E5 migration dropped", () => {
    assert.deepEqual(
      legacyMapStorageUses(
        `INSERT INTO map_files ("event_id", "file_name", "file_data", "uploaded_at") VALUES (1, E'a', '\\xaa'::bytea, 't');\nINSERT INTO map_tiles ("x") VALUES (1);`,
      ),
      ["map_tiles", "map_files.file_data"],
    );
  });

  it("replaces the map block of a fixture and keeps the rest, the event id and uploaded_at", () => {
    const stale = [
      "-- header",
      `INSERT INTO map_sources ("file_hash", "kind", "bytes", "size_bytes", "file_name") VALUES ('${"a".repeat(64)}', 'ocad', '\\xaa'::bytea, 1, E'Vinter Flaten kartutsitt.ocd') ON CONFLICT ("file_hash") DO NOTHING;`,
      `INSERT INTO map_documents ("hash") VALUES ('${"b".repeat(64)}') ON CONFLICT ("hash") DO NOTHING;`,
      `INSERT INTO map_files ("event_id", "file_name", "uploaded_at", "source_hash", "document_hash") VALUES (42, E'Vinter Flaten kartutsitt.ocd', '2026-03-04T05:06:07.000Z', '${"a".repeat(64)}', '${"b".repeat(64)}');`,
      "-- footer",
    ].join("\n");
    const out = replaceShowcaseMap(stale, rows);
    const found = extractShowcaseMap(out);
    assert.equal(found.source.fileHash, rows.source.fileHash);
    assert.ok(found.source.bytes.equals(rows.source.bytes));
    assert.equal(found.document.hash, rows.document.hash);
    assert.equal(found.mapFile.sourceHash, rows.source.fileHash);
    assert.equal(found.mapFile.documentHash, rows.document.hash);
    assert.match(found.mapFile.line, /VALUES \(42, E'demo-map\.ocd', '2026-03-04T05:06:07\.000Z', /);
    assert.ok(out.startsWith("-- header\n") && out.endsWith("\n-- footer"));
    assert.doesNotMatch(out, /Vinter Flaten|kartutsitt/);
    assert.equal(replaceShowcaseMap(out, rows), out, "patching twice changes nothing");
  });

  it("refuses a fixture without the map block", () => {
    assert.throws(() => replaceShowcaseMap("-- nothing\n", rows), /Could not find/);
  });
});

describe("committed showcase.sql", () => {
  const sql = readFileSync(FIXTURE, "utf8");

  it("writes no dropped map storage (loads on a v0.6.1 schema)", () => {
    assert.deepEqual(legacyMapStorageUses(sql), []);
  });

  it("holds the synthetic source and its pinned document", () => {
    const map = extractShowcaseMap(sql);
    assert.ok(map, "map_sources / map_documents / map_files INSERTs");
    assert.equal(map.source.fileName, SHOWCASE_OCAD.fileName);
    assert.ok(map.source.bytes.equals(buildShowcaseOcad()));
    assert.equal(map.source.fileHash, sha256(map.source.bytes));
    assert.equal(map.document.hash, sha256(map.document.bytes));
    assert.equal(map.mapFile.fileName, SHOWCASE_OCAD.fileName);
    assert.equal(map.mapFile.sourceHash, map.source.fileHash);
    assert.equal(map.mapFile.documentHash, map.document.hash);
    assert.match(sql, /INSERT INTO map_files .*VALUES \(9876543, /);
  });

  it("is the document the current importer and symbol library make", async () => {
    const rows = await buildShowcaseMapRows();
    const map = extractShowcaseMap(sql);
    assert.equal(map.document.hash, rows.document.hash, `the importer or the symbol library changed: ${REPIN}`);
    assert.equal(map.source.line, mapSourceInsert(rows.source));
    assert.equal(map.document.line, mapDocumentInsert(rows.document));
    const eventId = map.mapFile.line.match(/VALUES \((\d+), /)[1];
    const uploadedAt = map.mapFile.line.match(/, '(\d{4}-[0-9T:.Z+-]+)', /)[1];
    assert.equal(map.mapFile.line, mapFileInsert({ eventId, uploadedAt }, rows.pin, rows.source.fileName), REPIN);
  });

  it("names nothing of the source map or its club", () => {
    const mapSection = sql.slice(sql.indexOf("INSERT INTO map_sources"));
    for (const re of [/Vinter Flaten/i, /kartutsitt/i, /Delade enheter/i]) {
      assert.equal(re.test(mapSection), false, `map section matched ${re}`);
    }
    const map = extractShowcaseMap(sql);
    for (const re of FORBIDDEN_SHOWCASE_SQL) {
      assert.equal(re.test(map.source.fileName), false);
      assert.equal(re.test(map.source.bytes.toString("latin1")), false);
      assert.equal(re.test(map.document.bytes.toString("latin1")), false);
    }
  });
});
