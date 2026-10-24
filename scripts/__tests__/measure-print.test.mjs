import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../measure-print.mjs";

// The corpus print run (docs/course-print.md §11) on the E2E fixture map.
// `qpdf` and `rsvg-convert` are optional locally (their part is skipped and
// the assertion with it) and required under CI, like the PDF golden tier (§9.3).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = path.join(root, "scripts", "measure-print.mjs");
const fixture = path.join(root, "e2e", "test.ocd");
const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" });
const CI = !!process.env.CI;

describe("measure-print.mjs", () => {
  let dir;
  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), "measure-print-"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("parses paper, print scale, centre, density and the skips", () => {
    assert.deepEqual(parseArgs(["m.ocd", "--paper=a3:landscape", "--print-scale", "10000", "--centre=-12.5,40", "--px-per-mm=5", "--no-legacy", "--no-symbols"]).value, {
      file: "m.ocd", paper: { size: "A3", orientation: "landscape" }, printScale: 10000, centre: { x: -12.5, y: 40 }, pxPerMm: 5, legacy: false, symbols: false, out: null,
    });
    assert.deepEqual(parseArgs(["m.ocd", "--paper=A4"]).value.paper, { size: "A4" });
    assert.match(parseArgs(["m.ocd", "--paper=Letter"]).error, /A3, A4 or A5/);
    assert.match(parseArgs(["m.ocd", "--print-scale=7.5"]).error, /whole denominator/);
    assert.match(parseArgs(["m.ocd", "--centre=1"]).error, /x,y/);
    assert.match(parseArgs([]).error, /no map/);
    assert.match(parseArgs(["a.ocd", "b.ocd"]).error, /one map/);
  });

  it("prints one page in both modes, checks it and writes the summary", () => {
    const out = path.join(dir, "test");
    const r = run(fixture, `--out=${out}`);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^test\.ocd: A4 landscape at 1:7500 \(bounds\), \d+ objects/);
    assert.match(r.stdout, /PASS/);

    const report = JSON.parse(readFileSync(path.join(out, "summary.json"), "utf8"));
    assert.equal(report.pass, true);
    assert.deepEqual(report.failures, []);
    assert.equal(report.source, "bounds");
    assert.deepEqual([report.paper.widthMm, report.paper.heightMm], [297, 210]);
    assert.equal(report.printScale, 7500);
    assert.deepEqual(report.course, { controls: 4, description: true });
    assert.equal(report.previous, null);
    for (const mode of ["rgb", "cmyk"]) {
      const m = report.modes[mode];
      assert.match(m.sha256, /^[0-9a-f]{64}$/);
      assert.ok(m.bytes > 1000, `${mode} bytes`);
      assert.deepEqual(m.pageMm, { width: 297, height: 210 });
      assert.ok(m.parity.ratio <= 0.005, `${mode} parity ${m.parity.ratio}`);
      if (CI || m.qpdf !== "skipped") assert.equal(m.qpdf, "ok", mode);
      assert.ok(m.sanctioned.includes("course-symbol-sizes"));
      assert.equal(m.sanctioned.includes("cmyk-colour"), mode === "cmyk");
    }
    if (CI || !("skipped" in report.legacy)) {
      assert.deepEqual(report.legacy.pageMm, { width: 297, height: 210 });
      assert.ok(report.legacy.unexplainedRatio < 0.1, `legacy unexplained ${report.legacy.unexplainedRatio}`);
      for (const f of ["legacy.pdf", "legacy.png", "diff.legacy.png"]) assert.ok(existsSync(path.join(out, f)), f);
    }
    // e2e/test.ocd's frame symbol is the one divergence, and it is sanctioned (map-rendering.md §6.4).
    assert.deepEqual(report.symbols.diverging.map((s) => [s.code, s.sanctioned]), [["850.1", ["rectangle-symbols"]]]);
    assert.equal(report.symbols.unsanctioned, 0);

    const summary = readFileSync(path.join(out, "summary.md"), "utf8");
    assert.match(summary, /^# Corpus print — test\.ocd/);
    assert.match(summary, /\*\*PASS\*\*/);
    assert.match(summary, /\| rgb \| \d+ kB \| \d+ ms \| 297 × 210 \| (ok|skipped) \| \d\.\d{3} % /);
    assert.match(summary, /\| cmyk \| .*cmyk-colour/);
    assert.match(summary, /\| 850\.1 \| Frame \| rectangle \| .* \| rectangle-symbols \|/);
    for (const f of ["page.rgb.pdf", "page.cmyk.pdf", "page.rgb.png", "page.cmyk.png", "oracle.rgb.png", "oracle.cmyk.png", "diff.oracle.rgb.png", "diff.oracle.cmyk.png", "symbol.850.1.diff.png"]) {
      assert.ok(existsSync(path.join(out, f)), f);
    }
  });

  it("compares with the previous run: equal input, equal bytes", () => {
    const out = path.join(dir, "test");
    const r = run(fixture, "--no-legacy", "--no-symbols", `--out=${out}`);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /previous run: same bytes rgb true, cmyk true/);
    const report = JSON.parse(readFileSync(path.join(out, "summary.json"), "utf8"));
    assert.deepEqual(report.previous.sameBytes, { rgb: true, cmyk: true });
    assert.deepEqual(report.previous.bytesDelta, { rgb: 0, cmyk: 0 });
    assert.equal(report.previous.legacyUnexplainedDelta, null);
    assert.ok(existsSync(path.join(out, "summary.previous.json")));
    assert.match(readFileSync(path.join(out, "summary.md"), "utf8"), /## Against the previous run/);
  });

  it("prints on an ISO sheet at another scale when asked", () => {
    const out = path.join(dir, "a5");
    const r = run(fixture, "--paper=A5:landscape", "--print-scale=5000", "--no-legacy", "--no-symbols", `--out=${out}`);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const report = JSON.parse(readFileSync(path.join(out, "summary.json"), "utf8"));
    assert.equal(report.source, "override");
    assert.deepEqual([report.paper.widthMm, report.paper.heightMm], [210, 148]);
    assert.equal(report.printScale, 5000);
    // The window is the frame at 1:5000 on a 1:7500 map.
    assert.equal(report.window.widthMm, ((210 - 6) * 5000) / 7500);
    assert.deepEqual(report.legacy, { skipped: "--no-legacy" });
  });

  it("exits 2 on usage errors", () => {
    assert.equal(run().status, 2);
    assert.equal(run("x.ocd", "--bogus").status, 2);
  });
});
