/** The course-setting rules as geometry (course-layer.md §3.2–3.5). */

import { describe, expect, it } from "vitest";
import { deriveCourse, type CourseMetrics } from "../derive.js";
import { SITES, layerInput, linear, site } from "./helpers.js";
import type { CourseLayerInput } from "../types.js";

/** ISOM at 1:15 000: R 2.5, finish 3.0, start circumradius 3.46, em 4 / (1409/2048). */
const M: CourseMetrics = { circleRadiusMm: 2.5, finishRadiusMm: 3, startRadiusMm: 6 / Math.sqrt(3), numberEmMm: 4 * (2048 / 1409), scale: 1 };
const derive = (over: Partial<CourseLayerInput> = {}) => deriveCourse(layerInput(over), M);
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

describe("legs (§3.2)", () => {
  it("connect consecutive sites, clipped at each site's extent + 0.2 R", () => {
    const d = derive();
    const legs = d.courses[0].legs;
    expect(legs.map((l) => `${l.from}-${l.to}`)).toEqual(["S-31", "31-32", "32-33", "33-F"]);
    const [first] = legs[0].pieces;
    expect(dist(first[0], SITES[0])).toBeCloseTo(M.startRadiusMm + 0.5, 6);
    expect(dist(first.at(-1)!, SITES[1])).toBeCloseTo(3, 6);
    const last = legs[3].pieces[0];
    expect(dist(last.at(-1)!, SITES[4])).toBeCloseTo(3.5, 6);
    expect(legs[0].points).toEqual([{ x: 10, y: 10 }, { x: 40, y: 10 }]);
  });

  it("are cut at any drawn circle in their way, and skip unpositioned sites", () => {
    const d = derive({ sites: [...SITES.slice(0, 5), site("mid", "control", 25, 10), site("lost", "control", 0, 0)], structure: linear(["S", "lost", "31", "mid"]) });
    const leg = d.courses[0].legs[0];
    expect(`${leg.from}-${leg.to}`).toBe("S-31");
    expect(leg.pieces).toHaveLength(2);
    expect(dist(leg.pieces[0].at(-1)!, { x: 25, y: 10 })).toBeCloseTo(3, 6);
  });

  it("carry automatic gaps over cut features, and authored gaps instead of them", () => {
    const auto = derive({ cutFeatures: [{ x: 25, y: 10.2 }] }).courses[0].legs[0];
    expect(auto.gaps).toHaveLength(1);
    expect(auto.pieces).toHaveLength(2);
    const authored = derive({ cutFeatures: [{ x: 25, y: 10.2 }], structure: linear(undefined, { items: [{ siteId: "S" }, { siteId: "31", leg: { gaps: [] } }, { siteId: "32" }] }) }).courses[0].legs[0];
    expect(authored.gaps).toEqual([]);
    expect(authored.pieces).toHaveLength(1);
  });

  it("draw authored pieces as given and follow an authored path's bends", () => {
    const pieces = [[{ x: 14, y: 10 }, { x: 20, y: 12 }], [{ x: 22, y: 12 }, { x: 37, y: 10 }]];
    const bends = [{ x: 40, y: 10 }, { x: 70, y: 20 }, { x: 60, y: 40 }];
    const d = derive({ structure: linear(undefined, { items: [{ siteId: "S" }, { siteId: "31", leg: { pieces } }, { siteId: "32", leg: { path: bends } }] }) });
    const [a, b] = d.courses[0].legs;
    expect(a).toMatchObject({ preclipped: true, pieces });
    expect(b.points).toEqual(bends);
    expect(b.pieces).toHaveLength(1);
    expect(b.pieces[0]).toHaveLength(3); // the bend survives the clipping
  });

  it("free order draws no legs and labels codes", () => {
    const d = derive({ structure: linear(undefined, { orderMode: "free_order" }) });
    expect(d.courses[0].legs).toEqual([]);
    expect(d.sites.find((s) => s.id === "32")!.label!.text).toBe("32");
  });
});

describe("circles (§3.3)", () => {
  it("cut automatically at features on the rim, authored gaps replace them, start / finish never cut", () => {
    const features = [{ x: 42.5, y: 10 }, { x: 10, y: 12.5 }];
    const d = derive({ cutFeatures: features });
    expect(d.sites.find((s) => s.id === "31")!.cuts).toHaveLength(1);
    expect(d.sites.find((s) => s.id === "S")!.cuts).toEqual([]);
    const authored = derive({ cutFeatures: features, structure: linear(undefined, { items: [{ siteId: "S" }, { siteId: "31", circleGaps: [{ start: 200, end: 220 }] }] }) });
    expect(authored.sites.find((s) => s.id === "31")!.cuts).toEqual([{ start: 200, end: 220 }]);
  });

  it("all-controls draws every positioned site, codes as labels", () => {
    const d = derive({ structure: null, viewOptions: { allControls: true } });
    expect(d.sites.map((s) => s.id)).toEqual(["S", "31", "32", "33", "F", "99"]);
    expect(d.courses).toEqual([]);
    expect(d.sites.find((s) => s.id === "99")!.label!.text).toBe("99");
    expect(d.sites.find((s) => s.id === "S")!.label).toBeUndefined();
  });
});

describe("start (§3.3)", () => {
  it("turns the apex towards the first control; north without one", () => {
    expect(derive().sites[0].angleDeg).toBeCloseTo(-90, 9); // 31 is due east
    const north = derive({ sites: [site("S", "start", 0, 1), site("31", "control", 0, 20)], structure: linear(["S", "31"]) });
    expect(north.sites[0].angleDeg).toBeCloseTo(0, 9);
    expect(derive({ structure: null, viewOptions: { allControls: true } }).sites[0].angleDeg).toBeUndefined();
  });
});

describe("numbers (§3.5)", () => {
  it("sequence for one ordered course; a repeated visit gets both numbers", () => {
    const d = derive({ structure: linear(["S", "31", "32", "31", "F"]) });
    expect(d.sites.find((s) => s.id === "31")!.label!.text).toBe("1/3");
    expect(d.sites.find((s) => s.id === "32")!.label!.text).toBe("2");
    expect(derive({ viewOptions: { labelMode: "code" } }).sites.find((s) => s.id === "32")!.label!.text).toBe("32");
  });

  it("an uncontested number sits up and to the right (placement in y-down, flipped back)", () => {
    const d = derive({ sites: [site("31", "control", 50, 50)], structure: linear(["31"]) });
    const l = d.sites[0].label!;
    expect(l.x).toBeGreaterThan(50);
    expect(l.y).toBeGreaterThan(50);
  });

  it("a manual offset is the number's centre", () => {
    const d = derive({ structure: linear(undefined, { labelOffsets: { "32": { dx: -4, dy: -1 } } }) });
    expect(d.sites.find((s) => s.id === "32")!.label).toMatchObject({ x: 56, y: 39 });
  });

  it("multi-course views label codes and draw both courses' legs", () => {
    const d = derive({ structure: [linear(), linear(["S", "99", "F"], { id: "c2" })] });
    expect(d.courses.map((c) => c.legs.length)).toEqual([4, 2]);
    expect(d.sites.find((s) => s.id === "31")!.label!.text).toBe("31");
  });
});
