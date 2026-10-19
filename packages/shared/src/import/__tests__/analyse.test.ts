import { describe, expect, it } from "vitest";
import { analyseDocumentInput, analyseMapDocument, isMeridianCode } from "../analyse.js";
import { encodeMapDocument, decodeMapDocument, type MapDocumentInput, type MapObjectInput } from "../../map-document/index.js";
import type { DocumentSymbolInput } from "../../map-document/header.js";

const sym = (code: string, origin: DocumentSymbolInput["origin"] = "source"): DocumentSymbolInput => ({ code, name: code, kind: "line", origin, hidden: false, sourceIndex: 0, render: null });

/** A line from (x, y) going `len` units at `tiltDeg` from paper +Y. */
function line(symbolIdx: number, x: number, y: number, len: number, tiltDeg: number, i: number): MapObjectInput {
  const a = (tiltDeg * Math.PI) / 180;
  return { symbolIdx, type: 2, sourceIndex: i, coords: [x, y, Math.round(x + len * Math.sin(a)), Math.round(y + len * Math.cos(a))], flags: [0, 0] };
}

function doc(objects: MapObjectInput[], opts: { unitsPerMm?: number; symbols?: DocumentSymbolInput[]; georeferenced?: boolean } = {}): MapDocumentInput {
  return {
    header: {
      format: { version: 1, importer: "test" },
      source: { kind: "ocad", version: "2018", hash: "0".repeat(64), bytes: 0 },
      unitsPerMm: opts.unitsPerMm ?? 100,
      mapScale: 15000,
      georeferencing: opts.georeferenced === false
        ? { crs: null, paperOrigin: null, gridRotationDeg: 0, gridScaleFactor: 1 }
        : { crs: { authority: "EPSG", code: 3006, name: "SWEREF99 TM" }, paperOrigin: { x: 687000, y: 6574000 }, gridRotationDeg: 0, gridScaleFactor: 1 },
      colours: [],
      symbols: opts.symbols ?? [sym("101.0"), sym("601.0"), sym("601.1")],
      warnings: [],
    },
    objects,
  };
}

/** n tilted meridians 10 mm long (OCAD units). */
const meridians = (symbolIdx: number, n: number, tilt: number, len = 1000, offset = 0) =>
  Array.from({ length: n }, (_, i) => line(symbolIdx, i * 500, -2000, len, tilt + (i % 2 ? 0.02 : -0.02), offset + i));

describe("isMeridianCode", () => {
  it("accepts 601 and 601.x only", () => {
    expect(["601", "601.0", "601.1", "601.12"].every(isMeridianCode)).toBe(true);
    expect(["6010", "602", "601a", "1601.0", ""].some(isMeridianCode)).toBe(false);
  });
});

describe("analyseDocumentInput", () => {
  it("finds the tilted meridian cluster and reports its symbol", () => {
    const a = analyseDocumentInput(doc([line(0, 0, 0, 5000, 40, 0), ...meridians(1, 12, 3.3, 1000, 1)]));
    expect(a.north.meridian).toMatchObject({ symbolIdx: 1, code: "601.0", count: 12 });
    expect(a.north.meridian!.medianTiltDeg).toBeCloseTo(3.3, 1);
    expect(a.north.meridian!.stddevDeg).toBeLessThan(0.1);
  });

  it("keeps symbols apart, drops lines shorter than 5 mm and ignores other symbols", () => {
    // 6 + 6 lines split over two 601 symbols: neither group reaches 10.
    expect(analyseDocumentInput(doc([...meridians(1, 6, 0), ...meridians(2, 6, 0, 1000, 6)])).north.meridian).toBeNull();
    // 12 lines of 4.99 mm.
    expect(analyseDocumentInput(doc(meridians(1, 12, 0, 499))).north.meridian).toBeNull();
    // 12 parallel 101 lines.
    expect(analyseDocumentInput(doc(meridians(0, 12, 0))).north.meridian).toBeNull();
    // Graphic objects never count, whatever their code.
    expect(analyseDocumentInput(doc(meridians(0, 12, 0), { symbols: [sym("601.0", "graphic")] })).north.meridian).toBeNull();
  });

  it("scales the 5 mm floor with unitsPerMm (OMAP µm)", () => {
    expect(analyseDocumentInput(doc(meridians(1, 12, 0, 4999), { unitsPerMm: 1000 })).north.meridian).toBeNull();
    expect(analyseDocumentInput(doc(meridians(1, 12, 0, 5000), { unitsPerMm: 1000 })).north.meridian?.count).toBe(12);
  });

  it("projects the georeference: EPSG, convergence at the origin, WGS 84 extent and the display north offset", () => {
    const a = analyseDocumentInput(doc(meridians(1, 12, 3.3)));
    expect(a.georeference).toMatchObject({ crs: "EPSG:3006", method: "epsg", projectable: true, gridRotationDeg: 0 });
    expect(a.georeference.gridConvergenceDeg!).toBeCloseTo(-2.82, 1);
    expect(a.georeference.originWgs84!.lat).toBeCloseTo(59.26, 1);
    expect(a.georeference.wgs84Bounds!.north).toBeGreaterThan(a.georeference.wgs84Bounds!.south);
    expect(a.north.paperNorthBearingDeg!).toBeCloseTo(2.82, 1);
    expect(a.north.displayNorthOffsetDeg!).toBeCloseTo(a.north.paperNorthBearingDeg! + a.north.meridian!.medianTiltDeg, 9);
  });

  it("reports an un-georeferenced map with method none and null projections; the meridian probe still runs", () => {
    const a = analyseDocumentInput(doc(meridians(1, 12, 0), { georeferenced: false }));
    expect(a.georeference).toEqual({ crs: null, method: "none", projectable: false, gridRotationDeg: 0, gridConvergenceDeg: null, originWgs84: null, wgs84Bounds: null });
    expect(a.north.paperNorthBearingDeg).toBeNull();
    expect(a.north.displayNorthOffsetDeg).toBeNull();
    expect(a.north.meridian?.count).toBe(12);
  });

  it("reports a CRS proj4 cannot project as resolved but not projectable", () => {
    const d = doc(meridians(1, 12, 0));
    d.header.georeferencing.crs = { authority: "EPSG", code: 31467, name: "DHDN / 3-degree Gauss-Kruger zone 3" };
    expect(analyseDocumentInput(d).georeference).toMatchObject({ crs: "EPSG:31467", method: "epsg", projectable: false, gridConvergenceDeg: null });
  });
});

describe("analyseMapDocument", () => {
  it("gives the same analysis over the decoded document as over its input", () => {
    const input = doc([line(0, 0, 0, 5000, 40, 0), ...meridians(1, 12, 3.3, 1000, 1)]);
    expect(analyseMapDocument(decodeMapDocument(encodeMapDocument(input)))).toEqual(analyseDocumentInput(input));
  });
});
