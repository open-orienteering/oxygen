import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildE2eTestOcad,
  buildSymbolTypesOcad,
  buildStaleBorderOcad,
  STALE_BORDER_OCAD,
  buildRotatedPointsOcad,
  ROTATED_POINTS_OCAD,
  SYMBOL_TYPES_OCAD,
  E2E_TEXT_SYMBOLS,
} from "../lib/ocad-fixture.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(path.join(ROOT, "packages/api/package.json"));

describe("OCAD fixtures", () => {
  it("rebuilds e2e/test.ocd byte-identically", () => {
    const committed = readFileSync(path.join(ROOT, "e2e/test.ocd"));
    const generated = buildE2eTestOcad();
    assert.equal(generated.length, committed.length);
    assert.ok(committed.equals(generated), "generated e2e/test.ocd must match the committed file");
  });

  it("builds the stale-border fixture: the reader sees a border symbol that is the area itself, and one that is missing", async () => {
    const { readOcad } = require("ocad2geojson");
    const file = await readOcad(buildStaleBorderOcad(), { quietWarnings: true });
    const bySym = new Map(file.symbols.map((s) => [s.symNum, s]));
    const self = bySym.get(STALE_BORDER_OCAD.self.symNum);
    assert.equal(self.borderOn, true);
    assert.equal(self.borderSym, STALE_BORDER_OCAD.self.symNum);
    const missing = bySym.get(STALE_BORDER_OCAD.missing.symNum);
    assert.equal(missing.borderSym, STALE_BORDER_OCAD.missing.borderSym);
    assert.equal(bySym.has(STALE_BORDER_OCAD.missing.borderSym), false);
  });

  it("builds the rotated-points fixture: the reader sees each symbol's rotatable flag and each object's angle", async () => {
    const { readOcad } = require("ocad2geojson");
    const file = await readOcad(buildRotatedPointsOcad(), { quietWarnings: true });
    const t = ROTATED_POINTS_OCAD;
    const kinds = [t.barrier, t.footbridge, t.tunnel, t.rotatable, t.knoll];
    const bySym = new Map(file.symbols.map((s) => [s.symNum, s]));
    for (const k of kinds) {
      assert.equal(bySym.get(k.symNum).type, 1);
      assert.equal(bySym.get(k.symNum).flags, k.flags);
      assert.equal(bySym.get(k.symNum).elements.length, k.elements.length);
    }
    assert.deepEqual(file.objects.map((o) => [o.sym, o.ang]), [...kinds.map((k) => [k.symNum, k.ang]), [t.footbridge.symNum, 0]]);
  });
});

describe("OCAD fixture symbol types", () => {
  it("writes text, line-text and rectangle symbols the reader reads back (docs/map-import.md §3.3)", async () => {
    const { readOcad } = require("ocad2geojson");
    const file = await readOcad(buildSymbolTypesOcad(), { quietWarnings: true });
    assert.deepEqual(file.warnings, []);
    const bySym = new Map(file.symbols.map((s) => [s.symNum, s]));
    for (const def of Object.values(SYMBOL_TYPES_OCAD)) {
      const { symNum, description, ...fields } = def;
      const s = bySym.get(symNum);
      assert.ok(s, `symbol ${symNum}`);
      assert.equal(s.description, description);
      for (const [k, v] of Object.entries(fields)) {
        if (Array.isArray(v)) assert.deepEqual(s[k].slice(0, v.length), v, `${symNum}.${k}`);
        else assert.equal(s[k], v, `${symNum}.${k}`);
      }
    }
    assert.deepEqual(
      file.objects.map((o) => [o.objType, o.text]),
      [[4, "Framed"], [4, "Shadow"], [5, "Wrapped inside its box\n7\tTab"], [6, "Along the path"], [7, ""], [7, ""]],
    );
  });

  it("puts a framed text and a rectangle into e2e/test.ocd", async () => {
    const { readOcad } = require("ocad2geojson");
    const file = await readOcad(buildE2eTestOcad(), { quietWarnings: true });
    assert.deepEqual(file.warnings, []);
    const text = file.symbols.find((s) => s.symNum === E2E_TEXT_SYMBOLS.spotHeight.symNum);
    assert.equal(text.type, 4);
    assert.deepEqual([text.frMode, text.frColor, text.frWidth], [2, 4, 10]);
    const frame = file.symbols.find((s) => s.symNum === E2E_TEXT_SYMBOLS.frame.symNum);
    assert.equal(frame.type, 7);
    assert.equal(file.objects.filter((o) => o.objType === 7).length, 1);
    assert.equal(file.objects.find((o) => o.sym === E2E_TEXT_SYMBOLS.spotHeight.symNum).text, "112");
  });
});
