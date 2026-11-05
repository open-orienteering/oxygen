/**
 * Filter-region scenes (docs/map-rendering.md §4.11, §6.3; research 04 §8
 * row "Filter regions"): each symbolises warning-free, matches its
 * committed stream snapshot (`__fixtures__/streams/filter/<name>.stream.json`,
 * `diffPassStreams` at 1 µm) and shows the row's assertions: the clipped
 * pass set, the hidden object set, the fast bbox predicate equal to the
 * exact one, and the moved polygon changing both. Regenerate the
 * snapshots only when a rule change is intended:
 * `UPDATE_STREAMS=1 pnpm --filter @oxygen/shared exec vitest run src/render/__tests__/filter-fixtures.test.ts`,
 * then review the diff and re-render the goldens.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FILTER_BROWN, FILTER_SYMBOL, type FilterSceneName, filterScene, filterSceneNames } from "../__fixtures__/filter/index.js";
import { type PassStream } from "../pass-stream.js";
import { diffPassStreams, passStreamFromJson, passStreamToJson, type PassStreamJson } from "../stream-json.js";
import { symbolise } from "../symbolise.js";
import { filterStream } from "../filter-region.js";
import { liberation } from "./fonts.js";

const SNAP_DIR = fileURLToPath(new URL("../__fixtures__/streams/filter/", import.meta.url));

function run(name: FilterSceneName) {
  const scene = filterScene(name);
  const fonts = [liberation().sans];
  const plain = symbolise({ objects: scene.objects, symbols: scene.symbols, fonts }).stream;
  const filtered = symbolise({ objects: scene.objects, symbols: scene.symbols, fonts, regions: scene.regions, regionObjectLimit: scene.regionObjectLimit });
  return { scene, plain, ...filtered };
}

function formatStream(j: PassStreamJson): string {
  const list = (xs: unknown[]) => (xs.length ? `[\n${xs.map((x) => JSON.stringify(x)).join(",\n")}\n]` : "[]");
  const masks = j.masks ? `,\n"masks": ${list(j.masks)},\n"maskIdx": ${JSON.stringify(j.maskIdx)}` : "";
  return `{\n"objectIdx": ${JSON.stringify(j.objectIdx)},\n"symbolIdx": ${JSON.stringify(j.symbolIdx)},\n"passes": ${list(j.passes)},\n"glyphTable": ${list(j.glyphTable ?? [])},\n"fontTable": ${JSON.stringify(j.fontTable)}${masks}\n}\n`;
}

function matchSnapshot(name: FilterSceneName, stream: PassStream): void {
  const file = `${SNAP_DIR}${name}.stream.json`;
  if (process.env.UPDATE_STREAMS) {
    mkdirSync(SNAP_DIR, { recursive: true });
    writeFileSync(file, formatStream(passStreamToJson(stream)));
  }
  expect(existsSync(file), `missing ${name}.stream.json — see the header of this file`).toBe(true);
  expect(diffPassStreams(passStreamFromJson(JSON.parse(readFileSync(file, "utf8"))), stream)).toEqual([]);
}

/** Objects whose passes carry a mask, ascending. */
const maskedObjects = (s: PassStream) => [...new Set([...(s.maskIdx ?? [])].flatMap((m, i) => (m >= 0 ? [s.objectIdx[i]] : [])))].sort((a, b) => a - b);

describe("filter scenes", () => {
  for (const name of filterSceneNames) {
    it(`${name}: symbolises warning-free and matches its stream snapshot`, () => {
      const { stream, warnings } = run(name);
      expect(warnings).toEqual([]);
      matchSnapshot(name, stream);
    });
  }

  it("filter-clip-brown: the two contours through the pentagon are masked, nothing else; nothing is hidden", () => {
    const { stream, hidden } = run("filter-clip-brown");
    expect(hidden).toEqual([]);
    expect(maskedObjects(stream)).toEqual([1, 2]);
    stream.maskIdx!.forEach((m, i) => { if (m >= 0) expect(stream.passes[i].colour).toBe(FILTER_BROWN); });
    expect(stream.masks).toHaveLength(1);
  });

  it("filter-hide-505: only the footpath crossing the pentagon vanishes, whole", () => {
    const { stream, plain, hidden } = run("filter-hide-505");
    expect(hidden).toEqual([4]);
    expect(stream.maskIdx).toBeUndefined();
    expect(stream.passes.length).toBe(plain.passes.filter((_, i) => plain.objectIdx[i] !== 4).length);
    expect([...stream.objectIdx]).not.toContain(4);
  });

  it("filter-moved: the moved pentagon hides the other footpath and masks the contours it now meets", () => {
    const { stream, hidden } = run("filter-moved");
    expect(hidden).toEqual([5]);
    expect(maskedObjects(stream)).toEqual([1, 2]);
  });

  it("filter-show-only: invert keeps 101 and 505 inside; the 407 hatch is the one masked pass", () => {
    const { stream, hidden } = run("filter-show-only");
    expect(hidden).toEqual([]);
    expect(maskedObjects(stream)).toEqual([0]);
    const masked = stream.passes.filter((_, i) => stream.maskIdx![i] >= 0);
    expect(masked.map((p) => p.kind)).toEqual(["hatch"]);
    expect(stream.symbolIdx[stream.maskIdx!.indexOf(0)]).toBe(FILTER_SYMBOL.area407);
  });

  it("the fast bbox predicate equals the exact result on every scene", () => {
    for (const name of filterSceneNames) {
      const { scene, plain } = run(name);
      const opts = { objectLimit: scene.regionObjectLimit };
      const exact = filterStream(plain, scene.regions, opts);
      const fast = filterStream(plain, scene.regions, { ...opts, fast: true });
      expect(fast.hidden, name).toEqual(exact.hidden);
      expect(fast.masks, name).toEqual(exact.masks);
    }
  });
});
