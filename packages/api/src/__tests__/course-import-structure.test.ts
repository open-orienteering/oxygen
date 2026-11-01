/** Parser GeoJSON → structure parts (docs/course-layer.md §6.4). */

import { describe, expect, it } from "vitest";
import { collectImportedObjects, legGapsFromPieces, legGapsOfFeatures } from "../course-import-structure.js";

const A = { x: 0, y: 0 };
const B = { x: 100, y: 0 };
const piece = (x1: number, x2: number, y = 0): [number, number][] => [[x1, y], [x2, y]];
const fc = (features: unknown[]) => ({ type: "FeatureCollection" as const, features: features as never });
const line = (symbolType: string, coords: [number, number][], extra: Record<string, unknown> = {}) => ({
  type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: { symbolType, ...extra },
});

describe("legGapsFromPieces", () => {
  it("one piece (circle clearance at both ends) is no gap", () => {
    expect(legGapsFromPieces(A, B, [piece(5, 95)])).toEqual([]);
  });

  it("the uncovered stretch between two pieces is a gap, as fractions of the leg", () => {
    expect(legGapsFromPieces(A, B, [piece(5, 40), piece(60, 95)])).toEqual([{ from: 0.4, to: 0.6 }]);
  });

  it("reads pieces in either direction and order", () => {
    expect(legGapsFromPieces(A, B, [piece(95, 60), piece(40, 5)])).toEqual([{ from: 0.4, to: 0.6 }]);
  });

  it("drops gaps narrower than 0.2 mm (touching pieces)", () => {
    expect(legGapsFromPieces(A, B, [piece(5, 50), piece(50.1, 95)])).toEqual([]);
  });

  it("projects off-axis pieces onto the centre line", () => {
    expect(legGapsFromPieces(A, B, [piece(5, 40, 0.3), piece(60, 95, -0.3)])).toEqual([{ from: 0.4, to: 0.6 }]);
  });
});

describe("legGapsOfFeatures", () => {
  it("keys the gaps by `from>to` codes over a course's pre-clipped legs", () => {
    const pos = new Map([["31", A], ["32", B]]);
    const geom = fc([line("leg", piece(5, 40), { from: "31", to: "32", preclipped: true }), line("leg", piece(60, 95), { from: "31", to: "32", preclipped: true }), line("leg", piece(0, 10), { from: "32", to: "33" })]);
    expect([...legGapsOfFeatures(geom, (c) => pos.get(c))]).toEqual([["31>32", [{ from: 0.4, to: 0.6 }]]]);
  });
});

describe("collectImportedObjects", () => {
  const poly = { type: "Feature", geometry: { type: "Polygon", coordinates: [[[0, 0], [5, 0], [5, 5], [0, 0]]] }, properties: { symbolType: "restricted_area" } };
  const geoms = new Map([
    ["Bana 1", fc([line("marked_route", [[1, 1], [2, 2]]), line("restricted_line", [[3, 3], [4, 4]]), line("forbidden_route", [[5, 5], [6, 6]]), poly])],
    ["Bana 2", fc([line("restricted_line", [[3, 3], [4, 4]]), line("forbidden_route", [[5, 5], [6, 6]]), poly])],
  ]);

  it("maps the kinds, scopes 707 to its courses, shares the rest per event", () => {
    const out = collectImportedObjects(geoms);
    expect(out).toHaveLength(4);
    const byKind = (k: string, props?: object) => out.filter((o) => o.body.kind === k && (!props || JSON.stringify(o.body.props) === JSON.stringify(props)));
    expect(byKind("marked_route")[0]).toMatchObject({ courseNames: ["Bana 1"], all: false, body: { geometry: [{ x: 1, y: 1 }, { x: 2, y: 2 }], props: {} } });
    expect(byKind("oob_line", {})[0]).toMatchObject({ all: true });
    expect(byKind("oob_line", { symbol: "711" })).toHaveLength(1);
    // The ring's closing vertex is dropped (an area is closed implicitly).
    expect(byKind("oob_area")[0].body.geometry).toEqual([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }]);
  });

  it("ignores leg cuts and description boxes", () => {
    expect(collectImportedObjects(new Map([["c", fc([line("leg_cut", [[0, 0], [1, 1]]), line("description_box", [[0, 0], [1, 1]])])]]))).toEqual([]);
  });
});
