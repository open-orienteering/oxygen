/**
 * Synthetic map documents with contours for the height-field tests
 * (docs/map-storage.md §4.7): the shared terrain tests' ISOM symbols and
 * hill, encoded, with a salt in the importer string so each test run
 * stores its own document hash.
 */

import { mapDocument, symbolLibrary } from "@oxygen/shared";
import { S, SYMBOLS, mapped, ring, type Obj } from "@oxygen/shared/src/terrain/graph/__tests__/synthetic.js";
import { tick } from "@oxygen/shared/src/terrain/solve/__tests__/fixtures.js";

const lib = symbolLibrary.materialiseLibrary("ISOM2017-2");

/** Four rings around (30, 30) with a slope tick pointing out: the shared derive test's hill. */
export const HILL: Obj[] = mapped([...[5, 10, 15, 20].map((r) => ({ sym: S.contour, coords: ring(30, 30, r, 96) })), tick(50, 30, 1, 0)]);
/** A mapped area without contours. */
export const FLAT: Obj[] = mapped([], [0, 0, 10, 10]);

/** A georeference for `encodeTerrainDoc`: SWEREF 99 TM with the paper origin at (e, n), unrotated (the DEM tests, docs/map-terrain.md §7). */
export const sweref99 = (e: number, n: number): mapDocument.MapDocumentHeader["georeferencing"] => ({ crs: { authority: "EPSG", code: 3006, name: "SWEREF99 TM" }, paperOrigin: { x: e, y: n }, gridRotationDeg: 0 });

export function encodeTerrainDoc(objects: Obj[], salt: string, sourceHash = "00".repeat(32), georeferencing?: mapDocument.MapDocumentHeader["georeferencing"]): Uint8Array {
  const input: mapDocument.MapObjectInput[] = objects.map((o, i) => ({
    symbolIdx: o.sym,
    type: o.type ?? (SYMBOLS[o.sym].kind === "point" ? mapDocument.OBJECT_TYPE.point : SYMBOLS[o.sym].kind === "area" ? mapDocument.OBJECT_TYPE.area : mapDocument.OBJECT_TYPE.line),
    angleDeciDeg: o.angleDeciDeg,
    sourceIndex: i,
    coords: o.coords.map((v) => Math.round(v * 100)),
    flags: o.flags ?? new Array<number>(o.coords.length / 2).fill(0),
  }));
  return mapDocument.encodeMapDocument({
    header: {
      format: { version: 1, importer: `terrain-test-${salt}` },
      source: { kind: "ocad", version: "2018", hash: sourceHash, bytes: 1 },
      unitsPerMm: 100,
      mapScale: 15000,
      library: { id: "ISOM2017-2", version: symbolLibrary.SYMBOL_LIBRARY_VERSION },
      georeferencing: georeferencing ?? { crs: null, paperOrigin: { x: 0, y: 0 }, gridRotationDeg: 0 },
      colours: lib.colours,
      symbols: SYMBOLS,
    },
    objects: input,
  });
}
