/** The small ISOM-style source document shared by the stage 6–7 and review tests. */

import { OBJECT_TYPE } from "../../map-document/header.js";
import type { MapDocumentInput } from "../../map-document/codec.js";
import { type LineSymbol, type PointSymbol, type RenderSymbol, parseRenderSymbol } from "../../render/symbol.js";
import { scaleRenderSymbol } from "../../render/transform.js";
import { getLibraryEntry } from "../../symbol-library/index.js";
import { resolveEntry } from "../../symbol-library/schema.js";

// A small ISOM-style source table, bottom to top, with Swedish names and 2022 ink values.
export const colours = [
  { id: "src:5", name: "Gul 100%", cmyk: [0, 0.27, 0.79, 0] as [number, number, number, number], sourceNumber: 5 },
  { id: "src:4", name: "Brun 50% - Vägfyllning", cmyk: [0, 0.28, 0.5, 0.09] as [number, number, number, number], sourceNumber: 4 },
  { id: "src:3", name: "Brun 100% - Linjeobjekt", cmyk: [0, 0.56, 1, 0.18] as [number, number, number, number], sourceNumber: 3 },
  { id: "src:2", name: "Svart", cmyk: [0, 0, 0, 1] as [number, number, number, number], sourceNumber: 2 },
  { id: "src:1", name: "T-bana", cmyk: [0.9, 0.32, 0, 0] as [number, number, number, number], sourceNumber: 1 },
];
export const BLACK = 3, BROWN = 2, ROAD = 1, YELLOW = 0, METRO = 4;

const contour = parseRenderSymbol({ type: "line", id: "src:101", code: "101", name: "Höjdkurva", main: { colour: BROWN, widthUm: 140 } }) as LineSymbol;
// The spec wide road, stated against the source's own colour numbers (as an OCAD set would).
const road = resolveEntry(getLibraryEntry("ISOM2017-2:502")!, new Map([["brown50-road", ROAD], ["black-road-outline", BLACK], ["black100", BLACK]])) as LineSymbol;
const boulder: PointSymbol = { type: "point", id: "src:204", code: "204", name: "Sten", glyph: { parts: [{ kind: "disc", colour: BLACK, diameterUm: 400 }], rotatable: false }, orientation: "north" };
const buildingAs527: RenderSymbol = { type: "area", id: "src:527", code: "527", name: "Byggnad", fill: BLACK };
const minBuilding: PointSymbol = { type: "point", id: "src:521.3", code: "521.3", name: "Byggnad (minimimått)", glyph: { parts: [{ kind: "fill", colour: BLACK, geometry: { coords: [-250, -250, 250, -250, 250, 250, -250, 250], closed: true } }], rotatable: false }, orientation: "north" };
const metro = parseRenderSymbol({ type: "line", id: "src:900", code: "900", name: "Tunnelbana", main: { colour: METRO, widthUm: 500 } }) as LineSymbol;

export function input(opts: { factor?: number } = {}): MapDocumentInput {
  const f = opts.factor ?? 1;
  const s = (r: RenderSymbol) => (f === 1 ? r : scaleRenderSymbol(r, f));
  return {
    header: {
      format: { version: 1, importer: "test-4" },
      source: { kind: "ocad", version: "2018", hash: "ab", bytes: 1 },
      unitsPerMm: 100,
      mapScale: 15000 / f,
      georeferencing: { crs: null, paperOrigin: null },
      colours,
      symbols: [
        { code: "101.0", name: "Höjdkurva", kind: "line", render: s(contour) },
        { code: "502.0", name: "Bred väg", kind: "line", render: s(road) },
        { code: "204.0", name: "Sten", kind: "point", render: s(boulder) },
        { code: "527.0", name: "Byggnad", kind: "area", render: buildingAs527 },
        { code: "521.3", name: "Byggnad (minimimått)", kind: "point", render: s(minBuilding) },
        { code: "900.0", name: "Tunnelbana", kind: "line", render: s(metro) },
        { code: "401.0", name: "Öppen mark", kind: "area", render: null },
        { code: "graphic", name: "graphic line", kind: "line", origin: "graphic", render: { type: "line", id: "g", code: "graphic", name: "g", main: { colour: BLACK, widthUm: 100 } } },
      ],
    },
    objects: [
      { symbolIdx: 0, type: OBJECT_TYPE.line, sourceIndex: 0, coords: [0, 0, 1000, 0], flags: [0, 0] },
      { symbolIdx: 0, type: OBJECT_TYPE.line, sourceIndex: 1, coords: [0, 100, 1000, 100], flags: [0, 0] },
      { symbolIdx: 1, type: OBJECT_TYPE.line, sourceIndex: 2, coords: [0, 0, 0, 1000], flags: [0, 0] },
      { symbolIdx: 2, type: OBJECT_TYPE.point, sourceIndex: 3, coords: [50, 50], flags: [0] },
      { symbolIdx: 3, type: OBJECT_TYPE.area, sourceIndex: 4, coords: [0, 0, 100, 0, 100, 100], flags: [0, 0, 0] },
      { symbolIdx: 4, type: OBJECT_TYPE.point, sourceIndex: 5, coords: [500, 500], flags: [0] },
      { symbolIdx: 4, type: OBJECT_TYPE.point, sourceIndex: 6, coords: [600, 600], flags: [0] },
      { symbolIdx: 5, type: OBJECT_TYPE.line, sourceIndex: 7, coords: [0, 0, 1, 1], flags: [0, 0] },
      { symbolIdx: 6, type: OBJECT_TYPE.area, sourceIndex: 8, coords: [0, 0, 100, 0, 100, 100], flags: [0, 0, 0] },
    ],
  };
}

