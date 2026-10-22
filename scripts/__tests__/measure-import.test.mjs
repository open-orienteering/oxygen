import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildStaleBorderOcad } from "../lib/ocad-fixture.mjs";

// The S0 corpus check (docs/map-import.md §7) over the synthetic fixtures.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = path.join(root, "scripts", "measure-import.mjs");
const ocd = path.join(root, "e2e", "test.ocd");
const xmap = path.join(root, "e2e", "test.xmap");
const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" });

describe("measure-import.mjs", () => {
  let dir;
  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), "measure-import-"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("imports a map, writes its hashes and finds the same hash in a second process", () => {
    const hashes = path.join(dir, "hashes.json");
    const first = run(ocd, "--hashes", hashes);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const written = JSON.parse(readFileSync(hashes, "utf8"));
    const fileHash = createHash("sha256").update(readFileSync(ocd)).digest("hex");
    const entry = written.maps[fileHash];
    assert.equal(entry.name, "test.ocd");
    assert.match(entry.documentHash, /^[0-9a-f]{64}$/);
    assert.match(entry.importer, /^ocad-\d+$/);
    assert.match(entry.libraryVersion, /^ISOM2017-2@/);
    assert.equal(entry.georeference, undefined);

    const second = run(ocd, "--previous", hashes);
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.match(second.stdout, /sameAsPrevious yes/);
    assert.match(second.stdout, /sameAsPrevious\s+1\/1\s+pass/);
  });

  it("fails on a hash that differs from the previous run and says why", () => {
    const previous = path.join(dir, "previous.json");
    run(ocd, "--hashes", previous);
    const json = JSON.parse(readFileSync(previous, "utf8"));
    for (const entry of Object.values(json.maps)) entry.documentHash = "0".repeat(64);
    writeFileSync(previous, JSON.stringify(json));
    const r = run(ocd, "--previous", previous);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /determinism failure/);
  });

  it("matches a previous run by source file hash, whatever the file was called", () => {
    const out = path.join(dir, "named.json");
    run(ocd, "--out", out);
    const json = JSON.parse(readFileSync(out, "utf8"));
    json.maps = { "renamed.ocd": { ...json.maps["test.ocd"], name: "renamed.ocd" } };
    writeFileSync(out, JSON.stringify(json));
    const r = run(ocd, "--previous", out);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /sameAsPrevious yes/);
  });

  it("fails on unsupported-primitive warnings and lists them", () => {
    const out = path.join(dir, "run.json");
    const r = run(xmap, "--out", out);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /! TEXT_BOX_DROPPED ×1/);
    // The per-emission detail from the report is printed under each unsupported warning.
    assert.match(r.stdout, /^ {4}1 text box\(es\) imported as single-anchor texts$/m);
    const map = JSON.parse(readFileSync(out, "utf8")).maps["test.xmap"];
    assert.equal(map.importer.startsWith("omap-"), true);
    assert.deepEqual(map.unsupported.map((w) => w.code).sort(), ["COLOUR_OPACITY_IGNORED", "TEXT_ALIGNMENT_PER_OBJECT", "TEXT_BOX_DROPPED", "TEXT_VERTICAL_ALIGNMENT_DROPPED"]);
    assert.equal(map.georeference.crs, "EPSG:32633");
  });

  // A14: a stale symbol reference is a source data error. It is reported per symbol and does not fail the gate.
  it("reports a stale area-border reference per symbol as a data error, not an unsupported primitive", () => {
    const stale = path.join(dir, "stale.ocd");
    writeFileSync(stale, buildStaleBorderOcad());
    const out = path.join(dir, "stale.json");
    const r = run(stale, "--out", out);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /SYMBOL_REFERENCE_INVALID 2/);
    assert.doesNotMatch(r.stdout, /^ {2}! /m);
    assert.match(r.stdout, /~ SYMBOL_REFERENCE_INVALID ×2/);
    assert.match(r.stdout, /symbol \d+ {2}301\.2: border symbol 301002 is the symbol itself/);
    assert.match(r.stdout, /symbol \d+ {2}301\.3: border symbol 524000 is not in the symbol table/);
    const map = JSON.parse(readFileSync(out, "utf8")).maps["stale.ocd"];
    assert.deepEqual(map.unsupported, []);
    assert.equal(map.sourceErrors.length, 1);
    assert.equal(map.sourceErrors[0].code, "SYMBOL_REFERENCE_INVALID");
    assert.deepEqual(map.sourceErrors[0].details.map((d) => d.symbolIdx), [0, 1]);
  });

  it("exits 2 on usage errors", () => {
    assert.equal(run().status, 2);
    assert.equal(run(path.join(dir, "missing")).status, 2);
  });
});
