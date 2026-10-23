/** `courseLayerGeoJson()` in today's `courses.geometry` shape (course-layer.md §4). */

import { describe, expect, it } from "vitest";
import { courseLayer } from "../layer.js";
import { courseLayerGeoJson } from "../geojson.js";
import { layerInput, linear, site } from "./helpers.js";

describe("courseLayerGeoJson", () => {
  it("reproduces buildEditorGeometry + decorateOverprintCuts for an editor course", () => {
    const sites = [site("S", "start", 0, 5, "S1"), site("31", "control", 10, 0), site("32", "control", 40, 0), site("F", "finish", 40, 20, "F1")];
    const layer = courseLayer(layerInput({ sites, structure: linear(["S", "31", "32", "F"]), cutFeatures: [{ x: 12.5, y: 0 }, { x: 25, y: 0 }] }));
    const fc = courseLayerGeoJson(layer);
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features.map((f) => f.properties.symbolType)).toEqual(["start", "control", "control", "finish", "leg", "leg", "leg"]);
    expect(fc.features[0]).toEqual({ type: "Feature", geometry: { type: "Point", coordinates: [0, 5] }, properties: { symbolType: "start", code: "S1", id: "S1" } });
    expect(fc.features[1].properties.cuts).toHaveLength(1);
    expect(fc.features[2].properties).not.toHaveProperty("cuts");
    expect(fc.features[5]).toMatchObject({ geometry: { type: "LineString", coordinates: [[10, 0], [40, 0]] }, properties: { symbolType: "leg", from: "31", to: "32" } });
    const gaps = fc.features[5].properties.gaps as { from: number; to: number }[];
    expect(gaps).toHaveLength(1);
    expect(gaps[0].from).toBeLessThan(0.5);
    expect(gaps[0].to).toBeGreaterThan(0.5);
    expect(fc.features[4].properties).not.toHaveProperty("gaps");
  });

  it("free order: points only", () => {
    const fc = courseLayerGeoJson(courseLayer(layerInput({ structure: linear(undefined, { orderMode: "free_order" }) })));
    expect(fc.features.every((f) => f.geometry.type === "Point")).toBe(true);
    expect(fc.features).toHaveLength(5);
  });

  it("imported legs: authored pieces as preclipped LineStrings; extras under their imported names", () => {
    const pieces = [[{ x: 14, y: 10 }, { x: 20, y: 12 }], [{ x: 22, y: 12 }, { x: 37, y: 10 }]];
    const structure = linear(["S", "31"], {
      items: [{ siteId: "S" }, { siteId: "31", leg: { pieces } }],
      extras: [{ kind: "marked_route", points: [{ x: 0, y: 0 }, { x: 5, y: 5 }] }, { kind: "oob_area", points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }] }],
    });
    const fc = courseLayerGeoJson(courseLayer(layerInput({ structure })));
    const legs = fc.features.filter((f) => f.properties.symbolType === "leg");
    expect(legs.map((f) => f.properties)).toEqual([
      { symbolType: "leg", from: "S1", to: "31", preclipped: true },
      { symbolType: "leg", from: "S1", to: "31", preclipped: true },
    ]);
    expect(fc.features.at(-2)).toMatchObject({ geometry: { type: "LineString" }, properties: { symbolType: "marked_route" } });
    expect(fc.features.at(-1)).toMatchObject({ geometry: { type: "Polygon", coordinates: [[[0, 0], [5, 0], [5, 5], [0, 0]]] }, properties: { symbolType: "restricted_area" } });
  });

  it("picks a course of a multi-course layer by id; none → empty", () => {
    const layer = courseLayer(layerInput({ structure: [linear(), linear(["S", "99", "F"], { id: "c2" })] }));
    expect(courseLayerGeoJson(layer, "c2").features.filter((f) => f.geometry.type === "Point")).toHaveLength(3);
    expect(courseLayerGeoJson(courseLayer(layerInput({ structure: null, viewOptions: { allControls: true } }))).features).toEqual([]);
  });
});
