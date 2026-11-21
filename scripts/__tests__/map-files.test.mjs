import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PUBLIC_MAPS, isMapSource, isPublicMap } from "../lib/map-files.mjs";

// scripts/check-map-files.mjs: a club's map never reaches git as a vector source.

const OCAD = Buffer.from([0xad, 0x0c, 0x01, 0x00]);
const MAPPER = Buffer.from('<?xml version="1.0"?>\n<map xmlns="http://openorienteering.org/apps/mapper/xml/v2" version="9">');

describe("isMapSource", () => {
  it("knows map sources by extension, also as a backup or archive", () => {
    for (const p of ["club/flaten.ocd", "a/b.OMAP", "x.xmap", "flaten.ocd.bak", "flaten.omap.zip", "f.ocd.gz"]) {
      assert.equal(isMapSource(p, Buffer.alloc(0)), true, p);
    }
  });
  it("knows an OCAD file by its 0x0CAD mark whatever it is called, code extensions included", () => {
    for (const p of [".local/renamed.bin", "a.json", "notes.md", "x.ts"]) assert.equal(isMapSource(p, OCAD), true, p);
  });
  it("knows a Mapper file by its root element whatever it is called", () => {
    assert.equal(isMapSource("export/map.xml", MAPPER), true);
    assert.equal(isMapSource("export/map.json", MAPPER), true);
  });
  it("finds the Mapper root element with its attributes in any order, after a long prologue", () => {
    const late = Buffer.from(`<?xml version="1.0"?>\n<!--${"x".repeat(1500)}-->\n<map version="9" xmlns="http://openorienteering.org/apps/mapper/xml/v2">`);
    assert.equal(isMapSource("a.xml", late), true);
  });
  it("leaves code and docs that quote a Mapper header alone", () => {
    const quoted = Buffer.from('const s = `<map xmlns="http://openorienteering.org/apps/mapper/xml/v2">`;');
    assert.equal(isMapSource("packages/shared/src/x.test.ts", quoted), false);
    assert.equal(isMapSource("README.md", quoted), false);
  });
  it("leaves other files alone", () => {
    assert.equal(isMapSource("docs/screenshots/course-editor.png", Buffer.from([0x89, 0x50, 0x4e, 0x47])), false);
  });
});

describe("isPublicMap", () => {
  it("lists only test maps and the CC0 demo map", () => {
    for (const p of PUBLIC_MAPS.keys()) assert.match(p, /^(e2e\/|fixtures\/showcase\/puit-de-laven)/);
  });
  it("accepts a listed map only with its listed content", () => {
    const [p, sha] = [...PUBLIC_MAPS][0];
    assert.equal(isPublicMap(p, sha), true);
    assert.equal(isPublicMap(p, "0".repeat(64)), false);
    assert.equal(isPublicMap("club/flaten.ocd", sha), false);
  });
});
