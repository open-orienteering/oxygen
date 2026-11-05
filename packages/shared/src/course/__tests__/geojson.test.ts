/** `courseLayerGeoJson()` in today's `courses.geometry` shape (course-layer.md §4). */

import { describe, expect, it } from "vitest";
import { courseLayer } from "../layer.js";
import { courseLayerGeoJson } from "../geojson.js";
import { layerInput, linear, site } from "./helpers.js";

describe("courseLayerGeoJson", () => {
  it("reproduces the editor's pre-C5 shape with cuts for an editor course", () => {
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

  it("authored leg gaps and site cuts carry into the artifact", () => {
    const structure = linear(["S", "31"], { items: [{ siteId: "S" }, { siteId: "31", leg: { gaps: [{ from: 0.4, to: 0.6 }] } }] });
    const fc = courseLayerGeoJson(courseLayer(layerInput({ structure })));
    const leg = fc.features.find((f) => f.properties.symbolType === "leg")!;
    expect(leg.properties).toEqual({ symbolType: "leg", from: "S1", to: "31", gaps: [{ from: 0.4, to: 0.6 }] });
  });

  it("picks a course of a multi-course layer by id; none → empty", () => {
    const layer = courseLayer(layerInput({ structure: [linear(), linear(["S", "99", "F"], { id: "c2" })] }));
    expect(courseLayerGeoJson(layer, "c2").features.filter((f) => f.geometry.type === "Point")).toHaveLength(3);
    expect(courseLayerGeoJson(courseLayer(layerInput({ structure: null, viewOptions: { allControls: true } }))).features).toEqual([]);
  });
});
