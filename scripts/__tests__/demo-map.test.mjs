import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PyRandom } from "../lib/py-random.mjs";
import { DEMO_NOTE, DEMO_SEED, INJECTED_TAG, INJECTION_PLAN, analyseOmap, injectDemoPoints } from "../lib/inject-demo-points.mjs";
import { DEMO_MAP_PATH, ORIGINAL_MAP, ORIGINAL_MAP_PATH, buildDemoMap, sha256Hex } from "../lib/showcase-map.mjs";

// The Demo Competition's map (docs/demo.md, "The map"): the CC0 Puit de
// Laven map plus invented point features, made by a seeded injection.

describe("PyRandom", () => {
  // Reference values from CPython 3.10: random.Random(42) / Random(7).
  it("draws what CPython's random.Random draws for the same seed", () => {
    const r = new PyRandom(42);
    assert.deepEqual([r.getrandbits(32), r.getrandbits(32), r.getrandbits(32)], [2746317213, 478163327, 107420369]);
    assert.equal(r.random(), 0.7415504997598329);
    assert.equal(r.uniform(1200, 9000), 3110.1564596671146);
    assert.equal(r.randint(-5000, 300000), 68158);
    assert.equal(r.choice([...Array(77).keys()]), 13);
    assert.equal(r.randint(0, 1), 0);
    assert.equal(new PyRandom(7).random(), 0.32383276483316237);
  });

  it("refuses what it does not model", () => {
    assert.throws(() => new PyRandom(-1), /unsupported seed/);
    assert.throws(() => new PyRandom(42).randbelow(2 ** 32), /unsupported n/);
  });
});

describe("demo map injection", () => {
  let original;
  let demo;
  before(() => {
    original = readFileSync(ORIGINAL_MAP_PATH, "utf8");
    demo = injectDemoPoints(original);
  });

  it("starts from the CC0 file as published upstream", () => {
    assert.equal(sha256Hex(readFileSync(ORIGINAL_MAP_PATH)), ORIGINAL_MAP.sha256, `${ORIGINAL_MAP_PATH} is not ${ORIGINAL_MAP.repository} ${ORIGINAL_MAP.path}`);
    assert.equal(ORIGINAL_MAP.license, "CC0-1.0");
  });

  it("reproduces the committed demo map, the approved placement, byte for byte", () => {
    const committed = readFileSync(DEMO_MAP_PATH);
    assert.ok(buildDemoMap().equals(committed), "run `node scripts/patch-showcase-map.mjs` after changing the injection");
    // The placement the user approved (made with the Python original, seed 42).
    assert.equal(sha256Hex(committed), "dfd0b69b1362a068bde8ac4b1d1fef58717db43cf33d8036339c53908c12c3dc");
  });

  it("is deterministic and depends on the seed", () => {
    assert.equal(injectDemoPoints(original).text, demo.text);
    assert.notEqual(injectDemoPoints(original, DEMO_SEED + 1).text, demo.text);
  });

  it("places the planned number of each symbol, every object tagged", () => {
    assert.deepEqual(demo.placed, Object.fromEntries(INJECTION_PLAN.map((p) => [p.code, p.count])));
    const injected = demo.text.split("\n").filter((l) => l.includes(INJECTED_TAG));
    assert.equal(injected.length, 358);
    const { code2id } = analyseOmap(original);
    const idToCode = new Map([...code2id].map(([c, id]) => [id, c]));
    const counts = {};
    for (const l of injected) {
      const code = idToCode.get(l.match(/symbol="(\d+)"/)[1]);
      counts[code] = (counts[code] ?? 0) + 1;
      assert.equal(/ rotation="/.test(l), code === "110", `only 110 is rotated: ${l}`);
    }
    assert.deepEqual(counts, demo.placed);
  });

  it("changes nothing else: removing the injected objects and the note gives the original back", () => {
    const before = Number(original.match(/<part name="points"><objects count="(\d+)">/)[1]);
    const after = Number(demo.text.match(/<part name="points"><objects count="(\d+)">/)[1]);
    assert.equal(after - before, 358);
    const stripped = demo.text
      .replace(/\n<object type="0" symbol="\d+"[^>]*><tags><t k="oxygen-demo">injected<\/t><\/tags><coords count="1">[^<]*<\/coords><\/object>/g, "")
      .replace(`<part name="points"><objects count="${after}">`, `<part name="points"><objects count="${before}">`)
      .replace(`<notes>${DEMO_NOTE}</notes>`, "<notes></notes>");
    assert.equal(stripped, original);
  });

  it("says in the map's notes that the features are invented and where the map comes from", () => {
    assert.match(demo.text, /<notes>[^<]*invented, not surveyed[^<]*github\.com\/dmkaplan2000\/orienteering-maps \(CC0-1\.0\)[^<]*<\/notes>/);
  });

  it("keeps every injected feature in the map region, clear of lines, forbidden areas and other points", () => {
    const { region, nearLine, forbiddenAt, points } = analyseOmap(original);
    const added = [...demo.text.matchAll(/<object type="0" symbol="\d+"[^>]*><tags><t k="oxygen-demo">injected<\/t><\/tags><coords count="1">(-?\d+) (-?\d+);<\/coords>/g)].map((m) => [
      Number(m[1]),
      Number(m[2]),
    ]);
    assert.equal(added.length, 358);
    const minClear = Math.min(...INJECTION_PLAN.map((p) => p.clear));
    for (const [x, y] of added) {
      assert.ok(region.X0 <= x && x <= region.X1 && region.Y0 <= y && y <= region.Y1, `${x} ${y} outside the region`);
      assert.equal(nearLine(x, y, minClear), false, `${x} ${y} within ${minClear} µm of a line`);
      assert.equal(forbiddenAt(x, y), null, `${x} ${y} in a forbidden area`);
    }
    const all = [...points, ...added];
    for (const [i, [x, y]] of added.entries()) {
      for (const [j, [qx, qy]] of all.entries()) {
        if (j === points.length + i) continue;
        assert.ok(Math.hypot(x - qx, y - qy) >= 1300, `${x} ${y} closer than 1.3 mm to another point`);
      }
    }
  });
});
