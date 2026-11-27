/** Leg routes in the editor (docs/course-elevation.md §7.4). */

import { describe, it, expect } from "vitest";
import type { TerrainSampler } from "@oxygen/shared/src/terrain/profile/index.js";
import { chosenRouteMap, lineIsShortest, pairRoutes, routeItems, routeNumbers, routeShapes, type LegRouteRow } from "../leg-routes";

const route = (id: string, from: number, to: number, chosen: boolean, points = [{ x: 5, y: 5 }]): LegRouteRow =>
  ({ id, fromControlId: from, toControlId: to, points, source: "drawn", model: null, chosen });

/** Height = paper x in metres, 1 mm of paper = 10 m of ground: a plane rising east. */
const plane: TerrainSampler = { heightAt: (p: { x: number }) => p.x, confidentAt: () => true, groundMPerMm: 10, cellM: 2, datum: "relative", provider: null } as unknown as TerrainSampler;

describe("leg routes in the editor (docs/course-elevation.md §7.4)", () => {
  const routes = [route("a", 1, 2, false), route("b", 1, 2, true, [{ x: 0, y: 10 }]), route("c", 2, 1, true), route("d", 2, 3, false)];

  it("the chosen routes by the canvas's leg key", () => {
    expect([...chosenRouteMap(routes)]).toEqual([["1>2", [{ x: 0, y: 10 }]], ["2>1", [{ x: 5, y: 5 }]]]);
    expect(chosenRouteMap(undefined).size).toBe(0);
  });

  it("the automatic route (§7.5): listed as its own kind; without points it is the drawn line and not a route", () => {
    const auto: LegRouteRow = { ...route("s", 1, 2, true, [{ x: 5, y: 2 }]), source: "computed", model: "shortest", auto: true };
    const items = routeItems({ line: [{ x: 0, y: 0 }, { x: 10, y: 0 }], routes: [auto], mapScale: 10000, sampler: null });
    expect(items.map((i) => [i.id, i.source, i.chosen])).toEqual([[null, "line", false], ["s", "auto", true]]);
    const line: LegRouteRow = { ...auto, points: [] };
    expect(routeItems({ line: [{ x: 0, y: 0 }, { x: 10, y: 0 }], routes: [line], mapScale: 10000, sampler: null }).map((i) => [i.id, i.chosen])).toEqual([[null, true]]);
    expect(pairRoutes([line, auto], 1, 2).map((r) => r.points.length)).toEqual([1]);
    expect(lineIsShortest([line], 1, 2)).toBe(true);
    expect(lineIsShortest([auto], 1, 2)).toBe(false);
    expect(lineIsShortest([line], 2, 1)).toBe(false);
    expect([...chosenRouteMap([line])]).toEqual([]);
    expect(routeShapes({ from: { x: 0, y: 0 }, to: { x: 10, y: 0 }, routes: [line], draft: null, hover: null })).toEqual([]);
  });

  it("a pair's routes are its own direction's", () => {
    expect(pairRoutes(routes, 1, 2).map((r) => r.id)).toEqual(["a", "b"]);
    expect(pairRoutes(routes, 3, 2)).toEqual([]);
  });

  it("a route's metres come from the map scale; climb and descent from the field, on the route alone", () => {
    const line = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 4, y: 0 }];
    expect(routeNumbers(line, 10000, null)).toEqual({ lengthM: 160, climbM: null, descentM: null, approx: false });
    expect(routeNumbers(line, 10000, plane)).toEqual({ lengthM: 160, climbM: 10, descentM: 6, approx: false });
    const none = { ...plane, heightAt: () => null } as unknown as TerrainSampler;
    expect(routeNumbers(line, 10000, none).climbM).toBeNull();
  });

  it("the list: the drawn line first, chosen while no route is", () => {
    const line = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
    const none = routeItems({ line, routes: [route("a", 1, 2, false)], mapScale: 10000, sampler: plane });
    expect(none.map((i) => [i.id, i.source, i.chosen])).toEqual([[null, "line", true], ["a", "drawn", false]]);
    expect(none[0]).toMatchObject({ lengthM: 100, climbM: 10, descentM: 0 });
    // Through (5, 5): longer than the line, the same climb.
    expect(none[1].lengthM).toBe(141);
    expect(none[1].climbM).toBe(10);
    const one = routeItems({ line, routes: [route("b", 1, 2, true)], mapScale: 10000, sampler: null });
    expect(one.map((i) => i.chosen)).toEqual([false, true]);
    expect(routeItems({ line: [], routes, mapScale: 10000, sampler: null })).toEqual([]);
  });

  it("the map's shapes: stored routes between the leg's ends, the chosen one solid", () => {
    const shapes = routeShapes({ from: { x: 0, y: 0 }, to: { x: 10, y: 0 }, routes: pairRoutes(routes, 1, 2), draft: null, hover: null });
    expect(shapes).toHaveLength(2);
    expect(shapes[0]).toMatchObject({ kind: "line", dashed: true, data: { id: "a", chosen: "false" }, points: [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 0 }] });
    expect(shapes[1]).toMatchObject({ kind: "line", dashed: false, data: { id: "b", chosen: "true" } });
  });

  it("a draft is drawn alone: what is placed, the rest through the pointer, a handle per vertex", () => {
    const draft = { from: 1, to: 2, fromPt: { x: 0, y: 0 }, toPt: { x: 10, y: 0 }, points: [] as { x: number; y: number }[] };
    const empty = routeShapes({ from: draft.fromPt, to: draft.toPt, routes, draft, hover: { x: 3, y: 3 } });
    expect(empty.map((s) => s.testId)).toEqual(["editor-route-draft-rest"]);
    expect(empty[0]).toMatchObject({ points: [{ x: 0, y: 0 }, { x: 3, y: 3 }, { x: 10, y: 0 }] });
    const two = routeShapes({ from: draft.fromPt, to: draft.toPt, routes, draft: { ...draft, points: [{ x: 2, y: 4 }, { x: 6, y: 4 }] }, hover: null });
    expect(two.map((s) => s.testId)).toEqual(["editor-route-draft", "editor-route-draft-rest", "editor-route-draft-point", "editor-route-draft-point"]);
    expect(two[0]).toMatchObject({ points: [{ x: 0, y: 0 }, { x: 2, y: 4 }, { x: 6, y: 4 }] });
    expect(two[1]).toMatchObject({ points: [{ x: 6, y: 4 }, { x: 10, y: 0 }] });
  });
});
