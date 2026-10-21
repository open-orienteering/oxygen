import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../measure-parity.mjs";
import { buildParityOcad } from "../lib/ocad-fixture.mjs";

// The corpus parity tool (docs/map-rendering.md §6.4) over the synthetic fixtures.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = path.join(root, "scripts", "measure-parity.mjs");
const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" });

describe("measure-parity.mjs", () => {
  let dir;
  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), "measure-parity-"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("parses the window, density, mode and codes", () => {
    assert.deepEqual(parseArgs(["m.ocd", "--window=-10,-5,10,5", "--px-per-mm", "20", "--source", "--codes=510.0,511.2"]).value, {
      file: "m.ocd", window: { minX: -10, minY: -5, maxX: 10, maxY: 5 }, pxPerMm: 20, canonical: false, codes: ["510.0", "511.2"], out: null,
    });
    assert.match(parseArgs(["m.ocd", "--window=1,2,0,5"]).error, /x1 > x0/);
    assert.match(parseArgs(["m.ocd", "--px-per-mm=2.5"]).error, /whole number/);
    assert.match(parseArgs([]).error, /no map/);
  });

  it("writes an image triple per symbol and a ranked summary; the frame's divergence is sanctioned", () => {
    const out = path.join(dir, "test");
    const r = run(path.join(root, "e2e", "test.ocd"), `--out=${out}`);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /10 symbols compared .* 1 diverge/);
    const summary = readFileSync(path.join(out, "summary.md"), "utf8");
    assert.match(summary, /^# Corpus parity — test\.ocd/);
    assert.match(summary, /\| 1 \| 850\.1 \| Frame \|.*\| diverges \| rectangle-symbols \|/);
    for (const k of ["old", "new", "diff"]) assert.ok(existsSync(path.join(out, `702.0.${k}.png`)), k);
  });

  it("finds an OCAD power line's poles at its corner points only (B9)", () => {
    const ocd = path.join(dir, "parity.ocd");
    writeFileSync(ocd, buildParityOcad());
    const out = path.join(dir, "power");
    const r = run(ocd, "--source", "--codes=510.0", "--window=-25,-15,25,5", `--out=${out}`);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(readFileSync(path.join(out, "summary.md"), "utf8"), /\| 1 \| 510\.0 \| Power line \| line \| 1 \| source \| 0\.00 % \(0 \/ \d+\) \|.*\| close \|/);
  });

  it("exits 2 on usage errors", () => {
    assert.equal(run().status, 2);
    assert.equal(run("x.ocd", "--bogus").status, 2);
  });
});
