import { describe, expect, it } from "vitest";
import {
  calibrationCorners,
  epsgOf,
  gridConvergence,
  mapFileMetadata,
  paperNorthBearingDeg,
  paperToProjected,
  paperToWgs84,
  projectedToPaper,
  wgs84Bounds,
  wgs84ToPaper,
  type PaperFrame,
} from "../projection.js";

/** Nackareservatet origin (SWEREF99 TM), OCAD units, 1:15 000 — the numbers `map-north.test.ts` pins for the legacy path. */
function nacka(gridRotationDeg = 0, correctionDeg = 0): PaperFrame {
  return {
    unitsPerMm: 100,
    mapScale: 15000,
    georeferencing: { crs: { authority: "EPSG", code: 3006, name: "SWEREF99 TM" }, paperOrigin: { x: 687000, y: 6574000 }, gridRotationDeg, gridScaleFactor: 1 },
    correctionDeg,
  };
}

/** `e2e/test.xmap`: UTM 33N, 1:10 000, grid scale 0.9996, grivation 2.5°, Mapper ref point (50, 40) mm → (500 000, 6 600 000). */
function xmapFrame(): PaperFrame {
  const s = (0.9996 * 10000) / 1000;
  const a = (2.5 * Math.PI) / 180;
  const dx = -50 * s, dy = 40 * s;
  return {
    unitsPerMm: 1000,
    mapScale: 10000,
    georeferencing: {
      crs: { authority: "EPSG", code: 32633, name: "WGS 84 / UTM zone 33N" },
      paperOrigin: { x: 500000 + dx * Math.cos(a) + dy * Math.sin(a), y: 6600000 - dx * Math.sin(a) + dy * Math.cos(a) },
      gridRotationDeg: 2.5,
      gridScaleFactor: 0.9996,
    },
  };
}

describe("epsgOf", () => {
  it("names the proj4 definition for a registered EPSG code", () => {
    expect(epsgOf(nacka())).toBe("EPSG:3006");
    expect(epsgOf(xmapFrame())).toBe("EPSG:32633");
  });
  it("is null without a CRS, without a paper origin, or for a code proj4 does not know", () => {
    const f = nacka();
    expect(epsgOf({ ...f, georeferencing: { ...f.georeferencing, crs: null } })).toBeNull();
    expect(epsgOf({ ...f, georeferencing: { ...f.georeferencing, paperOrigin: null } })).toBeNull();
    expect(epsgOf({ ...f, georeferencing: { ...f.georeferencing, crs: { authority: "EPSG", code: 999999, name: "" } } })).toBeNull();
    expect(epsgOf({ ...f, georeferencing: { ...f.georeferencing, crs: { authority: "ESRI", code: 3006, name: "" } } })).toBeNull();
  });
});

describe("paper ↔ projected", () => {
  it("maps paper (0, 0) to the paper origin and scales native units by mapScale", () => {
    expect(paperToProjected(nacka(), 0, 0)).toEqual([687000, 6574000]);
    // 100 mm on paper at 1:15 000 = 1500 m.
    const [e, n] = paperToProjected(nacka(), 10000, 0)!;
    expect(e).toBeCloseTo(688500, 6);
    expect(n).toBeCloseTo(6574000, 6);
  });

  it("rotates by −(grid rotation + correction): a clockwise grivation turns paper +Y east of grid north", () => {
    const [e, n] = paperToProjected(nacka(3, 2), 0, 10000)!;
    const g = (5 * Math.PI) / 180;
    expect(e).toBeCloseTo(687000 + 1500 * Math.sin(g), 6);
    expect(n).toBeCloseTo(6574000 + 1500 * Math.cos(g), 6);
    // Correction composes with the declared rotation.
    expect(paperToProjected(nacka(5, 0), 0, 10000)![0]).toBeCloseTo(e, 6);
  });

  it("applies the grid scale factor", () => {
    const f = nacka();
    const [e] = paperToProjected({ ...f, georeferencing: { ...f.georeferencing, gridScaleFactor: 0.9996 } }, 10000, 0)!;
    expect(e).toBeCloseTo(687000 + 1500 * 0.9996, 6);
  });

  it("round-trips through projectedToPaper", () => {
    const f = nacka(4.98, 1.5);
    const [e, n] = paperToProjected(f, 1234, -5678)!;
    const [x, y] = projectedToPaper(f, e, n)!;
    expect(x).toBeCloseTo(1234, 6);
    expect(y).toBeCloseTo(-5678, 6);
  });

  it("reproduces Mapper's reference point on the OMAP fixture (map (50, 40) mm y-down → (500 000, 6 600 000))", () => {
    const [e, n] = paperToProjected(xmapFrame(), 50000, -40000)!;
    expect(e).toBeCloseTo(500000, 6);
    expect(n).toBeCloseTo(6600000, 6);
    const ll = paperToWgs84(xmapFrame(), 50000, -40000)!;
    expect(ll.lng).toBeCloseTo(15, 6);
    expect(ll.lat).toBeCloseTo(59.5, 1);
  });

  it("is null when the frame has no paper origin", () => {
    const f = nacka();
    expect(paperToProjected({ ...f, georeferencing: { ...f.georeferencing, paperOrigin: null } }, 0, 0)).toBeNull();
  });
});

describe("paper ↔ WGS84", () => {
  it("round-trips", () => {
    const f = nacka(2);
    const ll = paperToWgs84(f, 5000, 3000)!;
    const p = wgs84ToPaper(f, ll.lat, ll.lng)!;
    expect(p.x).toBeCloseTo(5000, 4);
    expect(p.y).toBeCloseTo(3000, 4);
  });
  it("is null without a usable CRS", () => {
    const f = nacka();
    const none = { ...f, georeferencing: { ...f.georeferencing, crs: null } };
    expect(paperToWgs84(none, 0, 0)).toBeNull();
    expect(wgs84ToPaper(none, 59, 18)).toBeNull();
  });
});

describe("gridConvergence", () => {
  it("returns ≈ −2.82° at the Nackareservatet origin (true north west of grid north)", () => {
    const g = gridConvergence(nacka())!;
    expect(g.angleDeg).toBeCloseTo(-2.82, 1);
    expect(g.lat).toBeCloseTo(59.26, 1);
    expect(g.lng).toBeCloseTo(18.28, 1);
  });
  it("is ≈ 0 on the central meridian", () => {
    expect(gridConvergence(xmapFrame())!.angleDeg).toBeCloseTo(0, 1);
  });
});

describe("paperNorthBearingDeg / wgs84Bounds / calibrationCorners / mapFileMetadata", () => {
  const bounds = { minX: -7600, minY: -5000, maxX: 7600, maxY: 5000 };

  it("paper +Y bearing is grid rotation + correction + convergence", () => {
    expect(paperNorthBearingDeg(nacka(), bounds)!).toBeCloseTo(2.82, 1);
    expect(paperNorthBearingDeg(nacka(3, 1), bounds)!).toBeCloseTo(2.82 + 4, 1);
  });

  it("bounds enclose every calibration corner", () => {
    const b = wgs84Bounds(nacka(), bounds)!;
    const corners = calibrationCorners(nacka(), bounds)!;
    expect(corners.map((c) => [c.mapX, c.mapY])).toEqual([[-76, -50], [76, -50], [-76, 50], [76, 50]]);
    for (const c of corners) {
      expect(c.lat).toBeGreaterThanOrEqual(b.south);
      expect(c.lat).toBeLessThanOrEqual(b.north);
      expect(c.lng).toBeGreaterThanOrEqual(b.west);
      expect(c.lng).toBeLessThanOrEqual(b.east);
    }
  });

  it("mapFileMetadata folds the meridian tilt into the north offset and keeps the scale without a CRS", () => {
    const m = mapFileMetadata(nacka(), bounds, 3.3);
    expect(m.scale).toBe(15000);
    expect(m.northOffset!).toBeCloseTo(paperNorthBearingDeg(nacka(), bounds)! + 3.3, 9);
    expect(m.bounds).toEqual(wgs84Bounds(nacka(), bounds));
    expect(m.calibration).toEqual(calibrationCorners(nacka(), bounds));
    const f = nacka();
    expect(mapFileMetadata({ ...f, georeferencing: { ...f.georeferencing, crs: null } }, bounds, null)).toEqual({ scale: 15000, bounds: null, northOffset: null, calibration: null });
  });
});
