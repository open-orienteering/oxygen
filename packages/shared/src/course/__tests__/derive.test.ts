/** The course-setting rules as geometry (course-layer.md §3.2–3.5). */

import { describe, expect, it } from "vitest";
import { deriveCourse, legLengthMm, routedBends, type CourseMetrics } from "../derive.js";
import { SITES, isomContext, layerInput, linear, site } from "./helpers.js";
import type { CourseLayerInput, CourseLegProps } from "../types.js";

/** ISOM at 1:15 000: R 2.5, finish 3.0, start circumradius 3.46, em 4 / (1409/2048). */
const M: CourseMetrics = { circleRadiusMm: 2.5, finishRadiusMm: 3, startRadiusMm: 6 / Math.sqrt(3), numberEmMm: 4 * (2048 / 1409), lineWidthMm: 0.35 };
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
    const authored = derive({ cutFeatures: [{ x: 25, y: 10.2 }], structure: linear(undefined, { items: [{ siteId: "S" }, { siteId: "31", leg: { gaps: [{ from: 0.1, to: 0.2 }] } }, { siteId: "32" }] }) }).courses[0].legs[0];
    expect(authored.gaps).toEqual([{ from: 0.1, to: 0.2 }]);
  });

  it("authored leg gaps replace the automatic ones; an empty list means automatic", () => {
    const gaps = [{ from: 0.4, to: 0.6 }];
    const feature = [{ x: 25, y: 10.2 }];
    const empty = derive({ cutFeatures: feature, structure: linear(undefined, { items: [{ siteId: "S" }, { siteId: "31", leg: { gaps: [] } }, { siteId: "32" }] }) }).courses[0].legs[0];
    expect(empty.gaps).toHaveLength(1); // empty = automatic
    const authored = derive({ cutFeatures: feature, structure: linear(undefined, { items: [{ siteId: "S" }, { siteId: "31", leg: { gaps } }, { siteId: "32" }] }) }).courses[0].legs[0];
    expect(authored.gaps).toEqual(gaps);
    expect(authored.pieces).toHaveLength(2);
  });

  it("with the event's auto cuts off, no automatic gaps; authored leg gaps still apply", () => {
    const feature = [{ x: 25, y: 10.2 }];
    const off = derive({ cutFeatures: feature, viewOptions: { autoCuts: false } }).courses[0].legs[0];
    expect(off.gaps).toEqual([]);
    expect(off.pieces).toHaveLength(1);
    const gaps = [{ from: 0.4, to: 0.6 }];
    const authored = derive({ cutFeatures: feature, viewOptions: { autoCuts: false }, structure: linear(undefined, { items: [{ siteId: "S" }, { siteId: "31", leg: { gaps } }, { siteId: "32" }] }) }).courses[0].legs[0];
    expect(authored.gaps).toEqual(gaps);
    expect(authored.pieces).toHaveLength(2);
    expect(derive({ cutFeatures: feature, viewOptions: { autoCuts: true } }).courses[0].legs[0].gaps).toHaveLength(1);
  });

  it("numberHidden skips the visit's number, the site stays drawn", () => {
    const d = derive({ structure: linear(undefined, { items: [{ siteId: "S" }, { siteId: "31", numberHidden: true }, { siteId: "32" }] }) });
    expect(d.sites.find((s) => s.id === "31")!.label).toBeUndefined();
    expect(d.sites.find((s) => s.id === "32")!.label!.text).toBe("2");
  });

  it("free order draws no legs and labels codes", () => {
    const d = derive({ structure: linear(undefined, { orderMode: "free_order" }) });
    expect(d.courses[0].legs).toEqual([]);
    expect(d.sites.find((s) => s.id === "32")!.label!.text).toBe("32");
  });
});

/** S → 31 with `leg` on 31, then 32. */
const withLeg = (leg: CourseLegProps, over: Partial<CourseLayerInput> = {}) =>
  derive({ structure: linear(undefined, { items: [{ siteId: "S" }, { siteId: "31", leg }, { siteId: "32" }] }), ...over }).courses[0].legs;
const along = (pts: { x: number; y: number }[]) => legLengthMm(pts);
const BEND = { x: 25, y: 20 };

describe("bends and styles (§10.1, F1)", () => {
  it("legLengthMm sums the polyline", () => {
    expect(legLengthMm([{ x: 0, y: 0 }, { x: 3, y: 4 }])).toBe(5);
    expect(legLengthMm([{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 10 }])).toBe(11);
    expect(legLengthMm([{ x: 1, y: 1 }])).toBe(0);
  });

  it("a bent leg is the polyline through its bends, clipped at both sites", () => {
    const [leg] = withLeg({ bends: [BEND] });
    expect(leg.points).toEqual([{ x: 10, y: 10 }, BEND, { x: 40, y: 10 }]);
    expect(leg.style).toBe("line");
    expect(leg.pieces).toHaveLength(1);
    const piece = leg.pieces[0];
    expect(piece).toContainEqual(BEND);
    expect(dist(piece[0], SITES[0])).toBeCloseTo(M.startRadiusMm + 0.5, 6);
    expect(dist(piece.at(-1)!, SITES[1])).toBeCloseTo(3, 6);
  });

  it("drops a bend on a site and repeated bends", () => {
    const [leg] = withLeg({ bends: [{ x: 10, y: 10 }, BEND, BEND, { x: 40, y: 10 }] });
    expect(leg.points).toEqual([{ x: 10, y: 10 }, BEND, { x: 40, y: 10 }]);
  });

  it("places stored gaps as fractions of the bent length", () => {
    const [leg] = withLeg({ bends: [BEND], gaps: [{ from: 0.45, to: 0.55 }] });
    expect(leg.pieces).toHaveLength(2);
    const total = along(leg.points);
    // The bend is the polyline's mid-length: the gap is centred on it, not on the chord's midpoint.
    expect(dist(leg.pieces[0].at(-1)!, BEND)).toBeCloseTo(0.05 * total, 6);
    expect(dist(leg.pieces[1][0], BEND)).toBeCloseTo(0.05 * total, 6);
    for (const p of leg.pieces) expect(p).not.toContainEqual(BEND);
  });

  it("keeps a piece whole through a bend just after a gap", () => {
    const total = along([{ x: 10, y: 10 }, BEND, { x: 40, y: 10 }]);
    const toBend = Math.hypot(15, 10);
    const [leg] = withLeg({ bends: [BEND], gaps: [{ from: 0.2, to: (toBend - 0.5) / total }] });
    expect(leg.pieces).toHaveLength(2);
    expect(leg.pieces[1]).toContainEqual(BEND);
    expect(dist(leg.pieces[1][0], BEND)).toBeCloseTo(0.5, 6);
  });

  it("draws nothing within a site's clearance, a bend inside it included", () => {
    // A drawn control 1 mm from the bend (all controls): both segments are cut, the leg splits there.
    const mid = site("mid", "control", 25, 10);
    const near = { x: 25, y: 11 };
    const [leg] = withLeg({ bends: [near] }, { sites: [...SITES, mid], viewOptions: { allControls: true } });
    expect(leg.pieces).toHaveLength(2);
    for (const piece of leg.pieces) {
      for (const p of piece) expect(dist(p, mid)).toBeGreaterThanOrEqual(3 - 1e-9);
      expect(along(piece)).toBeGreaterThan(1);
    }
    expect(leg.pieces.flat()).not.toContainEqual(near);
    // A bend inside the leg's own end site: the stretch into it is not drawn.
    const [, into] = derive({ structure: linear(undefined, { items: [{ siteId: "S" }, { siteId: "31" }, { siteId: "32", leg: { bends: [{ x: 42, y: 10 }] } }] }) }).courses[0].legs;
    expect(into.pieces).toHaveLength(1);
    expect(dist(into.pieces[0][0], SITES[1])).toBeCloseTo(3, 6);
  });

  it("cuts a bent leg over a feature beside its bend", () => {
    const [leg] = withLeg({ bends: [BEND] }, { cutFeatures: [{ x: 25, y: 20.2 }] });
    expect(leg.gaps).toHaveLength(1);
    expect(leg.gaps[0].from).toBeLessThan(0.5);
    expect(leg.gaps[0].to).toBeGreaterThan(0.5);
    expect(leg.pieces).toHaveLength(2);
  });

  it("resolves the style; a none leg keeps its pieces", () => {
    expect(withLeg({ style: "marked_route" })[0].style).toBe("marked_route");
    const none = withLeg({ style: "none", bends: [BEND] });
    expect(none[0].style).toBe("none");
    expect(none[0].pieces).toHaveLength(1);
    expect(none[1].style).toBe("line");
  });
});

describe("corridors (§10.2, F2)", () => {
  const corridor = { widthM: 60, edge: true, whiteMm: 3, whiteOpacity: 0.4 };

  it("resolve to paper mm at the document's map scale; whiteMm stays paper mm", () => {
    const [leg] = withLeg({ corridor }, { document: { ...isomContext(1.5) } });
    // 1:10 000: 60 m = 6 mm.
    expect(leg.corridor).toEqual({ widthMm: 6, whiteMm: 3, edge: true });
    const [at15] = withLeg({ corridor });
    expect(at15.corridor!.widthMm).toBeCloseTo(4, 9);
  });

  it("never change the leg's points, gaps, pieces or length; a `none` leg keeps its corridor", () => {
    const [plain] = withLeg({ bends: [BEND] });
    const [cor] = withLeg({ bends: [BEND], corridor });
    expect({ ...cor, corridor: undefined }).toEqual({ ...plain, corridor: undefined });
    expect(along(cor.points)).toBe(along(plain.points));
    expect(withLeg({ style: "none", corridor })[0].corridor).toBeDefined();
    expect(plain).not.toHaveProperty("corridor");
  });
});

describe("crossings and map-issue points (§10.3, F4)", () => {
  // S (10,10) → 31 (40,10): a crossing point just above the leg, a free one, a map-issue point, an exchange.
  const P = site("P", "crossing_point", 25, 12, "P1");
  const Q = site("Q", "crossing_point", 70, 70, "Q1");
  const MI = site("MI", "map_issue", 50, 60, "M1");
  const X = site("X", "map_exchange", 60, 10, "X1");
  const sites = [...SITES, P, Q, MI, X];
  const crossed = (leg: CourseLegProps = { crossing: { controlId: "P" } }, over: Partial<CourseLayerInput> = {}) =>
    derive({ sites, structure: linear(undefined, { items: [{ siteId: "S" }, { siteId: "31", leg }, { siteId: "32" }] }), ...over });

  it("routedBends puts the crossing on the nearest segment of the bent polyline", () => {
    const a = { x: 0, y: 0 }, b = { x: 40, y: 0 };
    expect(routedBends(a, undefined, { x: 10, y: 1 }, b)).toEqual([{ x: 10, y: 1 }]);
    expect(routedBends(a, [{ x: 20, y: 10 }], { x: 5, y: 2 }, b)).toEqual([{ x: 5, y: 2 }, { x: 20, y: 10 }]);
    expect(routedBends(a, [{ x: 20, y: 10 }], { x: 35, y: 4 }, b)).toEqual([{ x: 20, y: 10 }, { x: 35, y: 4 }]);
  });

  it("routes the leg through the crossing point: its points pass the site, the length grows", () => {
    const leg = crossed().courses[0].legs[0];
    expect(leg.points).toEqual([{ x: 10, y: 10 }, { x: 25, y: 12 }, { x: 40, y: 10 }]);
    expect(leg.crossing).toBe("P");
    expect(legLengthMm(leg.points)).toBeGreaterThan(30);
    // Through a bend: before or after it, by the nearest segment.
    const bent = crossed({ bends: [{ x: 30, y: 20 }], crossing: { controlId: "P" } }).courses[0].legs[0];
    expect(bent.points).toEqual([{ x: 10, y: 10 }, { x: 25, y: 12 }, { x: 30, y: 20 }, { x: 40, y: 10 }]);
  });

  it("the site is drawn as 710, numberless, turned along the leg; it never clips the leg", () => {
    const d = crossed();
    const p = d.sites.find((x) => x.id === "P")!;
    expect(p.role).toBe("crossing_point");
    expect(p.label).toBeUndefined();
    expect(p.cuts).toEqual([]);
    // The chord S → 31 is due east.
    expect(p.angleDeg).toBeCloseTo(0, 9);
    // One piece runs through the site (no clearance around it).
    const leg = d.courses[0].legs[0];
    expect(leg.pieces).toHaveLength(1);
    expect(leg.pieces[0]).toContainEqual({ x: 25, y: 12 });
    // The numbering is unchanged: 31 is 1, 32 is 2.
    expect(d.sites.find((x) => x.id === "31")!.label!.text).toBe("1");
    expect(d.sites.find((x) => x.id === "32")!.label!.text).toBe("2");
  });

  it("the section form is reported; a crossing no drawn leg names is not drawn without setter marks", () => {
    expect(crossed({ crossing: { controlId: "P", section: true } }).sites.find((x) => x.id === "P")!.section).toBe(true);
    const d = crossed();
    expect(d.sites.find((x) => x.id === "Q")).toBeUndefined();
    expect(d.sites.find((x) => x.id === "MI")).toBeUndefined();
  });

  it("setter marks draw every crossing point (an unreferenced one north–south) and the map-issue points", () => {
    const d = crossed(undefined, { viewOptions: { setterMarks: true } });
    const q = d.sites.find((x) => x.id === "Q")!;
    expect(q.role).toBe("crossing_point");
    expect(q.angleDeg).toBe(90);
    const mi = d.sites.find((x) => x.id === "MI")!;
    expect(mi.role).toBe("map_issue");
    expect(mi.label).toBeUndefined();
    // No setter marks in an all-controls view without the option: crossings yes (sites), map-issue points no.
    const all = derive({ sites, structure: null, viewOptions: { allControls: true } });
    expect(all.sites.find((x) => x.id === "Q")?.role).toBe("crossing_point");
    expect(all.sites.find((x) => x.id === "MI")).toBeUndefined();
  });

  it("a map exchange is an item drawn and numbered as a control", () => {
    const d = derive({ sites, structure: linear(["S", "31", "X", "32", "F"]) });
    const x = d.sites.find((s) => s.id === "X")!;
    expect(x.role).toBe("control");
    expect(x.label!.text).toBe("2");
    expect(d.sites.find((s) => s.id === "32")!.label!.text).toBe("3");
  });

  it("a crossing or map-issue site named as an item is skipped (never items)", () => {
    const d = derive({ sites, structure: linear(["S", "31", "P", "MI", "32", "F"]) });
    expect(d.courses[0].sequence.map((e) => e.siteId)).toEqual(["S", "31", "32", "F"]);
  });
});

describe("circles (§3.3)", () => {
  it("cut automatically at features on the rim, authored gaps replace them, start / finish never cut", () => {
    const features = [{ x: 42.5, y: 10 }, { x: 10, y: 12.5 }];
    const d = derive({ cutFeatures: features });
    expect(d.sites.find((s) => s.id === "31")!.cuts).toHaveLength(1);
    expect(d.sites.find((s) => s.id === "S")!.cuts).toEqual([]);
    const authored = derive({ cutFeatures: features, sites: SITES.map((s) => (s.id === "31" ? { ...s, circleGaps: [{ start: 200, end: 220 }] } : s)) });
    expect(authored.sites.find((s) => s.id === "31")!.cuts).toEqual([{ start: 200, end: 220 }]);
  });

  it("with the event's auto cuts off, no automatic slits; authored circle gaps still apply", () => {
    const features = [{ x: 42.5, y: 10 }];
    const off = derive({ cutFeatures: features, viewOptions: { autoCuts: false } });
    expect(off.sites.find((s) => s.id === "31")!.cuts).toEqual([]);
    const authored = derive({ cutFeatures: features, viewOptions: { autoCuts: false }, sites: SITES.map((s) => (s.id === "32" ? { ...s, circleGaps: [{ start: 200, end: 220 }] } : s)) });
    expect(authored.sites.find((s) => s.id === "31")!.cuts).toEqual([]);
    expect(authored.sites.find((s) => s.id === "32")!.cuts).toEqual([{ start: 200, end: 220 }]);
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

describe("number collisions (§3.5)", () => {
  it("surface the placer's collides flag on the label, absent on a clear map", () => {
    expect(derive().sites.every((s) => s.label?.collides === undefined)).toBe(true);
    // 31 boxed in by a tight ring of start-sized obstacles: no ring slot is free.
    const ring = Array.from({ length: 30 }, (_, i) => {
      const a = (i / 30) * 2 * Math.PI;
      return site(`o${i}`, "finish", 50 + Math.cos(a) * 9, 50 + Math.sin(a) * 9);
    });
    const outer = Array.from({ length: 48 }, (_, i) => {
      const a = (i / 48) * 2 * Math.PI;
      return site(`p${i}`, "finish", 50 + Math.cos(a) * 16, 50 + Math.sin(a) * 16);
    });
    const outer2 = Array.from({ length: 64 }, (_, i) => {
      const a = (i / 64) * 2 * Math.PI;
      return site(`q${i}`, "finish", 50 + Math.cos(a) * 23, 50 + Math.sin(a) * 23);
    });
    const sites = [site("31", "control", 50, 50), ...ring, ...outer, ...outer2];
    const d = derive({ sites, structure: null, viewOptions: { allControls: true } });
    expect(d.sites.find((s) => s.id === "31")?.label?.collides).toBe(true);
  });
});
