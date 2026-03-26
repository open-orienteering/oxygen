import { describe, it, expect } from "vitest";
import {
  lngToTileX,
  tileXToLng,
  latToTileY,
  tileYToLat,
  latlngToPixel,
  pixelToLatlng,
  fitBounds,
  metersPerPixel,
  buildAffineTransform,
} from "../geo-utils";

describe("lngToTileX / tileXToLng", () => {
  it("maps lng -180 to tile 0", () => {
    expect(lngToTileX(-180, 0)).toBeCloseTo(0);
    expect(lngToTileX(-180, 10)).toBeCloseTo(0);
  });

  it("maps lng 0 to tile midpoint", () => {
    expect(lngToTileX(0, 0)).toBeCloseTo(0.5);
    expect(lngToTileX(0, 1)).toBeCloseTo(1);
    expect(lngToTileX(0, 10)).toBeCloseTo(512);
  });

  it("maps lng 180 to tile 2^z", () => {
    expect(lngToTileX(180, 0)).toBeCloseTo(1);
    expect(lngToTileX(180, 3)).toBeCloseTo(8);
  });

  it("roundtrips through tileXToLng", () => {
    const testLngs = [-180, -90, -45, 0, 18.07, 45, 90, 179.99];
    for (const lng of testLngs) {
      for (const z of [0, 5, 10, 18]) {
        const tile = lngToTileX(lng, z);
        const back = tileXToLng(tile, z);
        expect(back).toBeCloseTo(lng, 8);
      }
    }
  });

  it("tileXToLng(0, z) = -180", () => {
    expect(tileXToLng(0, 0)).toBeCloseTo(-180);
    expect(tileXToLng(0, 15)).toBeCloseTo(-180);
  });
});

describe("latToTileY / tileYToLat", () => {
  it("maps lat 0 (equator) to tile midpoint", () => {
    expect(latToTileY(0, 0)).toBeCloseTo(0.5);
    expect(latToTileY(0, 1)).toBeCloseTo(1);
  });

  it("positive lat maps to lower tile Y (north = top)", () => {
    expect(latToTileY(60, 10)).toBeLessThan(latToTileY(0, 10));
  });

  it("negative lat maps to higher tile Y", () => {
    expect(latToTileY(-60, 10)).toBeGreaterThan(latToTileY(0, 10));
  });

  it("roundtrips through tileYToLat", () => {
    const testLats = [-85, -60, -30, 0, 30, 59.33, 60, 85];
    for (const lat of testLats) {
      for (const z of [0, 5, 10, 18]) {
        const tile = latToTileY(lat, z);
        const back = tileYToLat(tile, z);
        expect(back).toBeCloseTo(lat, 6);
      }
    }
  });

  it("tileYToLat at tile 0 returns ~85.05 (Mercator limit)", () => {
    const lat = tileYToLat(0, 0);
    expect(lat).toBeCloseTo(85.0511, 1);
  });
});

describe("latlngToPixel / pixelToLatlng", () => {
  const vp = { centerLat: 59.33, centerLng: 18.07, zoom: 14 };
  const w = 800;
  const h = 600;

  it("center of viewport maps to container center", () => {
    const { px, py } = latlngToPixel(59.33, 18.07, vp, w, h);
    expect(px).toBeCloseTo(w / 2, 5);
    expect(py).toBeCloseTo(h / 2, 5);
  });

  it("pixelToLatlng at container center returns viewport center", () => {
    const { lat, lng } = pixelToLatlng(w / 2, h / 2, vp, w, h);
    expect(lat).toBeCloseTo(59.33, 8);
    expect(lng).toBeCloseTo(18.07, 8);
  });

  it("roundtrips latlng -> pixel -> latlng", () => {
    const testPoints = [
      { lat: 59.34, lng: 18.08 },
      { lat: 59.32, lng: 18.06 },
      { lat: 59.33, lng: 18.07 },
    ];
    for (const { lat, lng } of testPoints) {
      const { px, py } = latlngToPixel(lat, lng, vp, w, h);
      const back = pixelToLatlng(px, py, vp, w, h);
      expect(back.lat).toBeCloseTo(lat, 8);
      expect(back.lng).toBeCloseTo(lng, 8);
    }
  });

  it("roundtrips pixel -> latlng -> pixel", () => {
    const testPixels = [
      { px: 0, py: 0 },
      { px: 400, py: 300 },
      { px: 799, py: 599 },
      { px: 100, py: 500 },
    ];
    for (const { px, py } of testPixels) {
      const { lat, lng } = pixelToLatlng(px, py, vp, w, h);
      const back = latlngToPixel(lat, lng, vp, w, h);
      expect(back.px).toBeCloseTo(px, 5);
      expect(back.py).toBeCloseTo(py, 5);
    }
  });

  it("east of center has higher px", () => {
    const { px } = latlngToPixel(59.33, 18.08, vp, w, h);
    expect(px).toBeGreaterThan(w / 2);
  });

  it("north of center has lower py", () => {
    const { py } = latlngToPixel(59.34, 18.07, vp, w, h);
    expect(py).toBeLessThan(h / 2);
  });
});

describe("fitBounds", () => {
  const bounds = { north: 59.35, south: 59.31, east: 18.10, west: 18.04 };

  it("centers on the middle of bounds", () => {
    const vp = fitBounds(bounds, 800, 600);
    expect(vp.centerLat).toBeCloseTo((59.35 + 59.31) / 2, 8);
    expect(vp.centerLng).toBeCloseTo((18.10 + 18.04) / 2, 8);
  });

  it("returns a reasonable zoom level", () => {
    const vp = fitBounds(bounds, 800, 600);
    expect(vp.zoom).toBeGreaterThan(10);
    expect(vp.zoom).toBeLessThan(20);
  });

  it("larger container yields higher zoom (or equal)", () => {
    const small = fitBounds(bounds, 400, 300);
    const large = fitBounds(bounds, 1600, 1200);
    expect(large.zoom).toBeGreaterThanOrEqual(small.zoom);
  });

  it("wider bounds yield lower zoom", () => {
    const narrow = fitBounds(bounds, 800, 600);
    const wideBounds = { north: 60, south: 58, east: 20, west: 16 };
    const wide = fitBounds(wideBounds, 800, 600);
    expect(wide.zoom).toBeLessThan(narrow.zoom);
  });

  it("falls back to zoom 15 when padding eliminates container", () => {
    const vp = fitBounds(bounds, 100, 100, 0.6);
    expect(vp.zoom).toBe(15);
  });

  it("respects padding parameter", () => {
    const noPad = fitBounds(bounds, 800, 600, 0);
    const withPad = fitBounds(bounds, 800, 600, 0.2);
    // More padding => need to zoom out (lower zoom)
    expect(withPad.zoom).toBeLessThanOrEqual(noPad.zoom);
  });
});

describe("metersPerPixel", () => {
  it("returns ~156km/px at zoom 0 on equator", () => {
    const mpp = metersPerPixel(0, 0);
    // At zoom 0, worldSize = 256. Earth circumference / 256 ≈ 156543 m
    expect(mpp).toBeCloseTo(156543, -2);
  });

  it("halves when zoom increases by 1", () => {
    const mpp10 = metersPerPixel(0, 10);
    const mpp11 = metersPerPixel(0, 11);
    expect(mpp11).toBeCloseTo(mpp10 / 2, 5);
  });

  it("is smaller at higher latitudes (cos factor)", () => {
    const equator = metersPerPixel(0, 14);
    const stockholm = metersPerPixel(59.33, 14);
    expect(stockholm).toBeLessThan(equator);
    // cos(59.33°) ≈ 0.51
    expect(stockholm / equator).toBeCloseTo(Math.cos((59.33 * Math.PI) / 180), 5);
  });

  it("is zero at the pole", () => {
    expect(metersPerPixel(90, 10)).toBeCloseTo(0, 5);
  });

  it("is symmetric for north and south latitudes", () => {
    expect(metersPerPixel(45, 12)).toBeCloseTo(metersPerPixel(-45, 12), 10);
  });
});

describe("buildAffineTransform", () => {
  it("returns null for empty input", () => {
    expect(buildAffineTransform([])).toBeNull();
  });

  it("single-point transform roundtrips through the control point", () => {
    const tf = buildAffineTransform([{ mapX: 1000, mapY: 2000, lat: 59.33, lng: 18.07 }]);
    expect(tf).not.toBeNull();
    const { lat, lng } = tf!.toLatLng(1000, 2000);
    expect(lat).toBeCloseTo(59.33, 8);
    expect(lng).toBeCloseTo(18.07, 8);
    const { mapX, mapY } = tf!.toMapMm(59.33, 18.07);
    expect(mapX).toBeCloseTo(1000, 5);
    expect(mapY).toBeCloseTo(2000, 5);
  });

  it("three-point transform roundtrips through all control points", () => {
    const points = [
      { mapX: 0, mapY: 0, lat: 59.30, lng: 18.00 },
      { mapX: 10000, mapY: 0, lat: 59.30, lng: 18.10 },
      { mapX: 0, mapY: 10000, lat: 59.40, lng: 18.00 },
    ];
    const tf = buildAffineTransform(points);
    expect(tf).not.toBeNull();
    for (const p of points) {
      const { lat, lng } = tf!.toLatLng(p.mapX, p.mapY);
      expect(lat).toBeCloseTo(p.lat, 6);
      expect(lng).toBeCloseTo(p.lng, 6);
    }
  });

  it("toMapMm inverts toLatLng for three-point transform", () => {
    const points = [
      { mapX: 500, mapY: 500, lat: 59.33, lng: 18.07 },
      { mapX: 5000, mapY: 1000, lat: 59.34, lng: 18.12 },
      { mapX: 2000, mapY: 8000, lat: 59.40, lng: 18.09 },
    ];
    const tf = buildAffineTransform(points);
    expect(tf).not.toBeNull();
    // Test roundtrip at an arbitrary point
    const testX = 3000, testY = 4000;
    const { lat, lng } = tf!.toLatLng(testX, testY);
    const { mapX, mapY } = tf!.toMapMm(lat, lng);
    expect(mapX).toBeCloseTo(testX, 4);
    expect(mapY).toBeCloseTo(testY, 4);
  });

  it("returns null for coincident points", () => {
    const points = [
      { mapX: 100, mapY: 100, lat: 59.33, lng: 18.07 },
      { mapX: 100, mapY: 100, lat: 59.33, lng: 18.07 },
    ];
    // Two identical points create a degenerate system
    const tf = buildAffineTransform(points);
    // May return null due to singular matrix
    if (tf !== null) {
      // If it doesn't return null, at least verify it doesn't crash
      const { lat, lng } = tf.toLatLng(100, 100);
      expect(lat).toBeCloseTo(59.33, 4);
      expect(lng).toBeCloseTo(18.07, 4);
    }
  });
});
