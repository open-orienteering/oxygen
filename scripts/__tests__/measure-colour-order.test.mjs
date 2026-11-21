import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The colour-order harness (docs/map-rendering.md §6.5) on the committed CC0 map.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = path.join(root, "scripts", "measure-colour-order.mjs");
const map = path.join(root, "fixtures", "showcase", "puit-de-laven.omap");
const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" });

describe("measure-colour-order.mjs", () => {
  let dir, out, first, summary;
  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), "measure-colour-order-"));
    out = path.join(dir, ".local", "colour-order");
    const list = path.join(dir, "maps.tsv");
    writeFileSync(list, `# label\tpath\n\npuit\t${map}\n`);
    first = run("--maps", list, "--out", out);
    summary = JSON.parse(readFileSync(path.join(out, "puit", "summary.json"), "utf8"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("draws the map in both orders, names the changes and fails while any is unclassified", () => {
    assert.equal(first.status, 1, first.stdout + first.stderr);
    assert.ok(summary.changedPx > 0, "the layered stack changes puit-de-laven");
    assert.equal(summary.candidate, "layers");
    assert.deepEqual(summary.settings, { tileMm: 60, pxPerMm: 6, tolerance: 16, window: null });
    assert.ok(summary.tiles > 0 && summary.tilesChanged > 0 && summary.tilesChanged <= summary.tiles);
    assert.ok(summary.changedPx < summary.inked && summary.inked <= summary.px);
    // every changed pixel has exactly one kind; nearly all are named by two layers
    assert.equal(summary.kinds.reduce((t, k) => t + k.px, 0), summary.changedPx);
    assert.ok(summary.namedShare >= 0.95, `named share ${summary.namedShare}`);
    assert.equal(summary.unclassifiedPx, summary.changedPx); // no classification file
    assert.equal(summary.unclassifiedShare, 1);
    // both orders are named in the layered stack's layers: one role each, so no multi-role name
    const paletteName = /^[a-z0-9-]+(#\d+)?$/;
    assert.ok(summary.kinds.some((k) => paletteName.test(k.from) && paletteName.test(k.to)), "a change between two palette layers");
    for (const k of summary.kinds) assert.ok(!k.from.includes("+") && !k.to.includes("+"), `${k.from} → ${k.to}`);
    assert.match(first.stdout, /^ {2}changed {4}[\d ]+ px of [\d ]+ \([\d.]+ %\), of ink [\d ]+ \([\d.]+ %\); named [\d.]+ %$/m);
    assert.match(first.stdout, /unclassified\s+[\d ]+ of [\d ]+ changed px \(100\.0 %\)\s+FAIL/);
  });

  it("writes the census, the tiles, suggested classes and the worst tiles' images", () => {
    const c = summary.census;
    assert.ok(c.used > 0 && c.used <= c.colours);
    assert.ok(c.multi.length > 0, "puit-de-laven has colours serving several palette ids");
    assert.equal(c.symbols.used, c.symbols.auto + c.symbols.suggested + c.symbols.unmatched + c.symbols.none);
    assert.ok(c.lowerAt >= 0 && c.upperAt > c.lowerAt);
    const tiles = JSON.parse(readFileSync(path.join(out, "puit", "tiles.json"), "utf8"));
    assert.equal(tiles.tiles.length, summary.tiles);
    assert.ok(summary.worst.length > 0 && summary.worst.length <= 3);
    for (const w of summary.worst) assert.ok(existsSync(path.join(out, "puit", w.file)), w.file);
    const suggested = JSON.parse(readFileSync(path.join(out, "puit", "classes.suggested.json"), "utf8"));
    assert.equal(suggested.version, 1);
    assert.ok(suggested.rules.length > 0 && suggested.rules.every((r) => r.map === "puit"));
    assert.ok(existsSync(path.join(out, "run.json")));
    // standard output names layers by palette id, never by the map's own colour names (every one of them)
    const names = [...readFileSync(map, "utf8").matchAll(/<color\b[^>]*\bname="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(names.length > 30 && names.includes(c.unidentifiedList[0].name));
    for (const name of names) assert.ok(!first.stdout.includes(name), name);
  });

  it("reports the layered stack: rows, split colours, inserted rows", () => {
    const l = summary.layers;
    assert.ok(l.rows > summary.census.colours, "split colours add rows");
    assert.ok(l.split.length > 0 && l.split.every((s) => s.includes("+")));
    assert.ok(l.inserted.includes("purple-lower") && l.inserted.includes("purple-upper"));
    assert.match(first.stdout, /^ {2}layers {5}rows \d+ {2}split \d+/m);
    // I4: rows placed by the source order by reason, parts kept in their symbol's order, the deviations
    assert.deepEqual(Object.keys(l.sourceOrdered), ["no-role", "graphic", "mask"]);
    assert.ok(l.ownOrder > 0, "puit-de-laven has symbols the layers would draw inside out");
    assert.ok(l.deviations.dropped > 0 && Array.isArray(l.deviations.kept));
    assert.match(first.stdout, /^ {13}source order: no-role \d+ \/ graphic \d+ \/ mask \d+ \(above lower purple: .*\) {2}own order \d+$/m);
    assert.match(first.stdout, /^ {13}deviations kept .* {2}implied \d+ {2}blocked .* {2}dropped \d+$/m);
  });

  it("classifies every change on the CC0 map by the committed classification file, from the candidate's own report", () => {
    const r = run(map, "--out", path.join(out, "committed"), "--classes", path.join(root, "scripts", "colour-order-classes.json"));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const s = JSON.parse(readFileSync(path.join(out, "committed", "puit-de-laven", "summary.json"), "utf8"));
    assert.equal(s.unclassifiedPx, 0);
    assert.ok(s.byClass["deviation-dropped"] > 0);
    assert.equal(s.kinds.reduce((t, k) => t + k.px, 0), s.changedPx);
    assert.match(r.stdout, /unclassified\s+0 of [\d ]+ changed px \(0\.0 %\)\s+pass/);
  });

  it("still runs the experiment's permutation as a candidate, naming a multi-role colour as one layer", () => {
    const r = run(map, "--out", path.join(out, "permutation"), "--candidate", "permutation");
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const p = JSON.parse(readFileSync(path.join(out, "permutation", "puit-de-laven", "summary.json"), "utf8"));
    assert.equal(p.candidate, "permutation");
    assert.equal(p.layers, null);
    assert.ok(p.changedPx > 0 && p.kinds.some((k) => k.from.includes("+") || k.to.includes("+")));
    assert.equal(p.kinds.reduce((t, k) => t + k.px, 0), p.changedPx);
  });

  it("passes on a window whose changes a classification file names", () => {
    const tiles = JSON.parse(readFileSync(path.join(out, "puit", "tiles.json"), "utf8")).tiles;
    const tile = tiles.find((t) => t.changed > 0 && t.unattributed === 0);
    assert.ok(tile, "a changed tile with every pixel named");
    const [x0, y0, x1, y1] = tile.boundsMm;
    const window = [x0 + 1, y0 + 1, x1 - 1, y1 - 1].join(",");
    const probe = run(map, "--out", path.join(out, "probe"), "--window", window);
    const kinds = JSON.parse(readFileSync(path.join(out, "probe", "puit-de-laven", "summary.json"), "utf8")).kinds;
    const classes = path.join(dir, "classes.json");
    writeFileSync(classes, JSON.stringify({ version: 1, rules: kinds.map((k) => ({ map: "puit-de-laven", from: k.from, to: k.to, class: "multi-role" })) }));
    const r = run(map, "--out", path.join(out, "classified"), "--window", window, "--classes", classes);
    assert.equal(probe.status, 1, probe.stdout + probe.stderr);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /tiles {6}1 of 60 mm/);
    assert.match(r.stdout, /unclassified\s+0 of [\d ]+ changed px \(0\.0 %\)\s+pass/);
  });

  it("fails a map whose window meets no tile, rather than passing it with nothing compared", () => {
    const r = run(map, "--out", path.join(out, "nowhere"), "--window", "100000,100000,100001,100001");
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /window meets no tile/);
    assert.match(r.stdout, /map errors\s+1\s+FAIL/);
  });

  it("refuses bad usage with exit 2", () => {
    for (const args of [
      [],
      [map, "--out", path.join(dir, "elsewhere")],
      [map, "--out", out, "--candidate", "bogus"],
      [map, "--out", out, "--window", "1,2,0,4"],
      [map, "--out", out, "--tile-mm", "0"],
      [map, "--out", out, "--bogus"],
      [path.join(dir, "missing.omap"), "--out", out],
    ]) {
      const r = run(...args);
      assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
      assert.match(r.stderr, /usage:/);
    }
    const bad = path.join(dir, "bad-classes.json");
    writeFileSync(bad, JSON.stringify({ version: 1, rules: [{ from: "a", to: "b", class: "pretty" }] }));
    const r = run(map, "--out", out, "--classes", bad);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--classes: classification: rule 0/);
  });
});
