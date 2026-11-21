import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PUBLIC_MAPS } from "../lib/map-files.mjs";
import { DEMO_MAP_FILE_NAME, DEMO_MAP_PATH, ORIGINAL_MAP, ORIGINAL_MAP_PATH, importShowcaseMap, sha256Hex, showcaseSource } from "../lib/showcase-map.mjs";
import {
  FIXTURE_PATH,
  FORBIDDEN_SHOWCASE_SQL,
  extractShowcaseMap,
  legacyMapStorageUses,
  mapBytesInSql,
  mapFileInsert,
  replaceShowcaseMap,
} from "../lib/showcase-sql.mjs";

// The Demo Competition's map (docs/ops/demo.md, "The map"): the fixture names
// the committed o-kartan demo map by its source hash; load-showcase.sh inserts
// the source and the re-match imports and pins the document.
const REPIN = "run `node scripts/patch-showcase-map.mjs` to re-pin the committed fixture";

describe("showcase map source", () => {
  let imported;
  before(async () => {
    imported = await importShowcaseMap();
  });

  it("is the committed demo map as an OCAD source", () => {
    const source = showcaseSource();
    assert.equal(source.kind, "ocad");
    assert.equal(source.fileName, DEMO_MAP_FILE_NAME);
    assert.equal(source.fileHash, sha256Hex(readFileSync(DEMO_MAP_PATH)));
    assert.equal(source.sizeBytes, source.bytes.length);
  });

  it("imports as an OCAD 12 map at 1:15 000 whose document names this source", () => {
    assert.equal(imported.header.mapScale, 15000);
    assert.equal(imported.header.source.kind, "ocad");
    assert.equal(imported.header.source.hash, showcaseSource().fileHash);
  });
});

describe("showcase map SQL", () => {
  const source = { fileName: DEMO_MAP_FILE_NAME, fileHash: "c".repeat(64) };

  it("writes the map_files row source-only, without dropped columns", () => {
    const line = mapFileInsert({ eventId: 9876543, uploadedAt: "2026-01-01T00:00:00.000Z", rotationCorrection: 2 }, source);
    assert.equal(line.includes("\n"), false);
    assert.match(line, new RegExp(`VALUES \\(9876543, E'okartan-demo\\.ocd', '2026-01-01T00:00:00\\.000Z', 2, '${"c".repeat(64)}', NULL\\);$`));
    assert.deepEqual(legacyMapStorageUses(line), []);
    assert.deepEqual(mapBytesInSql(line), []);
  });

  it("flags SQL that writes the storage the E5 migration dropped, or map bytes", () => {
    assert.deepEqual(
      legacyMapStorageUses(
        `INSERT INTO map_files ("event_id", "file_name", "file_data", "uploaded_at") VALUES (1, E'a', '\\xaa'::bytea, 't');\nINSERT INTO map_tiles ("x") VALUES (1);`,
      ),
      ["map_tiles", "map_files.file_data"],
    );
    assert.deepEqual(mapBytesInSql(`INSERT INTO map_sources ("x") VALUES (1);\nINSERT INTO map_documents ("x") VALUES (1);`), ["map_sources", "map_documents"]);
  });

  it("replaces the E-demo map block with the source-only row, keeping the event id, uploaded_at and rotation", () => {
    const stale = [
      "-- header",
      `INSERT INTO map_sources ("file_hash", "kind", "bytes", "size_bytes", "file_name") VALUES ('${"a".repeat(64)}', 'ocad', '\\xaa'::bytea, 1, E'Vinter Flaten kartutsitt.ocd') ON CONFLICT ("file_hash") DO NOTHING;`,
      `INSERT INTO map_documents ("hash") VALUES ('${"b".repeat(64)}') ON CONFLICT ("hash") DO NOTHING;`,
      `INSERT INTO map_files ("event_id", "file_name", "uploaded_at", "scale", "rotation_correction", "source_hash", "document_hash") VALUES (42, E'Vinter Flaten kartutsitt.ocd', '2026-03-04T05:06:07.000Z', 15000, 3, '${"a".repeat(64)}', '${"b".repeat(64)}');`,
      "-- footer",
    ].join("\n");
    const out = replaceShowcaseMap(stale, source);
    const found = extractShowcaseMap(out);
    assert.equal(found.sourceHash, source.fileHash);
    assert.equal(found.documentHash, null);
    assert.equal(found.rotationCorrection, 3);
    assert.match(found.line, /VALUES \(42, E'okartan-demo\.ocd', '2026-03-04T05:06:07\.000Z', 3, /);
    assert.deepEqual(mapBytesInSql(out), []);
    assert.ok(out.startsWith("-- header\n") && out.endsWith("\n-- footer"));
    assert.doesNotMatch(out, /Vinter Flaten|kartutsitt/);
    assert.equal(replaceShowcaseMap(out, source), out, "patching twice changes nothing");
  });

  it("refuses a fixture without the map_files row", () => {
    assert.throws(() => replaceShowcaseMap("-- nothing\n", source), /Could not find/);
  });
});

describe("committed showcase.sql", () => {
  const sql = readFileSync(FIXTURE_PATH, "utf8");

  it("writes no dropped map storage (loads on a v0.6.1 schema) and no map bytes", () => {
    assert.deepEqual(legacyMapStorageUses(sql), []);
    assert.deepEqual(mapBytesInSql(sql), []);
  });

  it("has one map, the committed demo map, named by its source hash with no document", () => {
    assert.equal(sql.match(/^INSERT INTO map_files /gm)?.length, 1);
    const map = extractShowcaseMap(sql);
    assert.equal(map.eventId, "9876543");
    assert.equal(map.fileName, DEMO_MAP_FILE_NAME);
    assert.equal(map.documentHash, null);
    assert.equal(map.sourceHash, sha256Hex(readFileSync(DEMO_MAP_PATH)), REPIN);
  });

  it("names a map source on the public-map list, made from the licensed o-kartan original — no club map", () => {
    assert.equal(sha256Hex(readFileSync(ORIGINAL_MAP_PATH)), ORIGINAL_MAP.sha256);
    assert.equal(PUBLIC_MAPS.get("fixtures/okartan/okartan-original.ocd"), ORIGINAL_MAP.sha256);
    assert.equal(PUBLIC_MAPS.get("fixtures/okartan/okartan-demo.ocd"), extractShowcaseMap(sql).sourceHash, "update the demo map's hash in scripts/lib/map-files.mjs");
  });

  it("names nothing of the source map or its club", () => {
    const mapSection = sql.slice(sql.indexOf("-- ─── map_files"));
    for (const re of FORBIDDEN_SHOWCASE_SQL) assert.equal(re.test(mapSection), false, `map section matched ${re}`);
    // OCAD 12 keeps its strings as UTF-16, older parts as 8-bit: read the file both ways.
    const bytes = readFileSync(DEMO_MAP_PATH);
    for (const text of [bytes.toString("latin1"), bytes.toString("utf16le"), bytes.subarray(1).toString("utf16le")]) {
      for (const re of FORBIDDEN_SHOWCASE_SQL) assert.equal(re.test(text), false, `demo map matched ${re}`);
    }
    assert.match(bytes.toString("utf16le") + bytes.subarray(1).toString("utf16le"), /Contour/, "the UTF-16 reading sees the symbol names");
  });
});
