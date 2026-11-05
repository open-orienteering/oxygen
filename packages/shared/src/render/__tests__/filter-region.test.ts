import { describe, expect, it } from "vitest";
import { PILOT, pilotSymbols } from "../__fixtures__/pilot-symbols.js";
import { COORD_FLAG, type PassStream, makePath, sortPassStream } from "../pass-stream.js";
import { type RenderObject, symbolise } from "../symbolise.js";
import {
  type FilterRegion,
  applyFilterRegions,
  boundsMeetRegion,
  filterStream,
  objectBounds,
  passMeetsRegion,
  regionRings,
  selectsPass,
} from "../filter-region.js";
import { liberation } from "./fonts.js";

const BROWN = 6, BLACK = 8;
const square = (x0: number, y0: number, x1: number, y1: number) => makePath([x0, y0, x1, y0, x1, y1, x0, y1], undefined, true);
/** 10 mm square region at (10..20, 10..20) mm. */
const box = square(10_000, 10_000, 20_000, 20_000);

function stream(objects: RenderObject[]): PassStream {
  return symbolise({ objects, symbols: pilotSymbols, fonts: [liberation().sans] }).stream;
}

/** Contour through the box, contour beside it, footpath through it, footpath beside it, a 403 area around it. */
const objects: RenderObject[] = [
  { symbolIdx: PILOT.contour101, path: makePath([0, 15_000, 30_000, 15_000]) }, // 0 crosses
  { symbolIdx: PILOT.contour101, path: makePath([0, 40_000, 30_000, 40_000]) }, // 1 away
  { symbolIdx: PILOT.footpath505, path: makePath([15_000, 0, 15_000, 30_000]) }, // 2 crosses
  { symbolIdx: PILOT.footpath505, path: makePath([0, 45_000, 30_000, 45_000]) }, // 3 away
  { symbolIdx: PILOT.roughOpen403, path: square(0, 0, 30_000, 30_000) }, // 4 contains the box
];

describe("filter regions — selection", () => {
  const r = (symbols: FilterRegion["symbols"], invert = false): FilterRegion => ({ path: box, mode: "clip", symbols, invert });
  it("all, symbol list, colour list", () => {
    expect(selectsPass(r("all"), 3, 5)).toBe(true);
    expect(selectsPass(r([PILOT.footpath505]), PILOT.footpath505, BLACK)).toBe(true);
    expect(selectsPass(r([PILOT.footpath505]), PILOT.contour101, BROWN)).toBe(false);
    expect(selectsPass(r({ colours: [BROWN] }), PILOT.contour101, BROWN)).toBe(true);
    expect(selectsPass(r({ colours: [BROWN] }), PILOT.footpath505, BLACK)).toBe(false);
  });
  it("invert is the complement of the selection (show only these)", () => {
    expect(selectsPass(r([PILOT.footpath505], true), PILOT.footpath505, BLACK)).toBe(false);
    expect(selectsPass(r([PILOT.footpath505], true), PILOT.contour101, BROWN)).toBe(true);
    expect(selectsPass(r("all", true), 0, 0)).toBe(false);
  });
});

describe("filter regions — predicates", () => {
  const rings = regionRings(box);
  it("the exact predicate: vertex inside, edge crossing, region inside an area", () => {
    const s = stream(objects);
    const meets = (o: number) => s.passes.some((p, i) => s.objectIdx[i] === o && passMeetsRegion(p, rings));
    expect([0, 1, 2, 3, 4].map(meets)).toEqual([true, false, true, false, true]);
  });
  it("the fast predicate on bounds", () => {
    expect(boundsMeetRegion({ minX: 0, minY: 0, maxX: 30_000, maxY: 30_000 }, rings)).toBe(true); // contains the region
    expect(boundsMeetRegion({ minX: 12_000, minY: 12_000, maxX: 13_000, maxY: 13_000 }, rings)).toBe(true); // inside
    expect(boundsMeetRegion({ minX: 0, minY: 14_000, maxX: 30_000, maxY: 16_000 }, rings)).toBe(true); // crosses
    expect(boundsMeetRegion({ minX: 0, minY: 22_000, maxX: 30_000, maxY: 26_000 }, rings)).toBe(false);
  });
  it("a hole of the region is outside it", () => {
    const holed = makePath(
      [10_000, 10_000, 20_000, 10_000, 20_000, 20_000, 10_000, 20_000, 13_000, 13_000, 17_000, 13_000, 17_000, 17_000, 13_000, 17_000],
      [0, 0, 0, 0, COORD_FLAG.hole, 0, 0, 0],
      true,
    );
    const s = stream([{ symbolIdx: PILOT.tree418, path: makePath([15_000, 15_000]) }]);
    expect(passMeetsRegion(s.passes[0], regionRings(holed))).toBe(false);
    expect(passMeetsRegion(s.passes[0], regionRings(box))).toBe(true);
  });
  it("symbolised bounds include half the stroke width", () => {
    const s = stream([objects[0]]);
    expect(objectBounds(s).get(0)).toEqual({ minX: -70, minY: 15_000 - 70, maxX: 30_070, maxY: 15_070 });
  });
});

describe("filter regions — filterStream", () => {
  const s = stream(objects);
  it("hide drops whole selected objects that meet the region", () => {
    const r = filterStream(s, [{ path: box, mode: "hide", symbols: [PILOT.footpath505] }]);
    expect(r.hidden).toEqual([2]);
    expect(r.maskIdx).toBeUndefined();
  });
  it("hide + invert drops the meeting objects of every other symbol", () => {
    const r = filterStream(s, [{ path: box, mode: "hide", symbols: [PILOT.footpath505], invert: true }]);
    expect(r.hidden).toEqual([0, 4]);
  });
  it("hide by colour", () => {
    expect(filterStream(s, [{ path: box, mode: "hide", symbols: { colours: [BROWN] } }]).hidden).toEqual([0]);
  });
  it("clip masks the selected passes of objects near the region, one mask per region set", () => {
    const r = filterStream(s, [{ path: box, mode: "clip", symbols: { colours: [BROWN] } }]);
    expect(r.masks).toEqual([{ regions: [box] }]);
    const masked = [...r.maskIdx!].flatMap((m, i) => (m >= 0 ? [s.objectIdx[i]] : []));
    expect(masked).toEqual([0]); // object 1 is brown too, but far from the region
    expect(r.hidden).toEqual([]);
  });
  it("two clip regions on one pass share a mask with both regions", () => {
    const other = square(12_000, 0, 18_000, 30_000);
    const r = filterStream(s, [
      { path: box, mode: "clip", symbols: "all" },
      { path: other, mode: "clip", symbols: [PILOT.contour101] },
    ]);
    const maskOfObject = (o: number) => r.maskIdx![s.objectIdx.indexOf(o)];
    expect(r.masks[maskOfObject(0)].regions).toEqual([box, other]);
    expect(r.masks[maskOfObject(2)].regions).toEqual([box]); // the footpath is not a 101
    expect(r.masks).toHaveLength(2);
  });
  it("objects at or past objectLimit (the course layer) are never filtered", () => {
    const r = filterStream(s, [{ path: box, mode: "hide", symbols: "all" }], { objectLimit: 2 });
    expect(r.hidden).toEqual([0]);
  });
  it("fast and exact agree on this scene; a moved region changes both", () => {
    for (const path of [box, square(25_000, 10_000, 35_000, 20_000)]) {
      const regions: FilterRegion[] = [{ path, mode: "hide", symbols: "all" }];
      expect(filterStream(s, regions, { fast: true }).hidden).toEqual(filterStream(s, regions).hidden);
    }
    expect(filterStream(s, [{ path: square(25_000, 10_000, 35_000, 20_000), mode: "hide", symbols: [PILOT.footpath505] }]).hidden).toEqual([]);
  });
  it("a region with fewer than three points warns and does nothing", () => {
    const r = filterStream(s, [{ path: makePath([0, 0, 10, 10], undefined, true), mode: "hide", symbols: "all" }]);
    expect(r).toMatchObject({ hidden: [], maskIdx: undefined, masks: [] });
    expect(r.warnings.map((w) => w.code)).toEqual(["FILTER_EMPTY_REGION"]);
  });
  it("deterministic, and the mask index survives the canonical sort", () => {
    const regions: FilterRegion[] = [{ path: box, mode: "clip", symbols: "all" }, { path: box, mode: "hide", symbols: [PILOT.footpath505] }];
    const a = applyFilterRegions(s, regions), b = applyFilterRegions(s, regions);
    expect(a).toEqual(b);
    expect(a.hidden).toEqual([2]);
    expect([...a.stream.objectIdx]).not.toContain(2);
    expect(sortPassStream(a.stream)).toEqual(a.stream);
    const masked = new Set([...a.stream.maskIdx!].flatMap((m, i) => (m >= 0 ? [a.stream.objectIdx[i]] : [])));
    expect([...masked].sort()).toEqual([0, 4]);
  });
});
