import { describe, it, expect } from "vitest";
import { getProjectedToLatLng, latLngToTM } from "../livelox/crs.js";

describe("getProjectedToLatLng", () => {
  it("returns null for an unsupported EPSG code", () => {
    expect(getProjectedToLatLng(9999)).toBeNull();
    // WGS84 itself is not a projected CRS we convert from.
    expect(getProjectedToLatLng(4326)).toBeNull();
  });

  describe("EPSG:3006 (SWEREF 99 TM, Sweden)", () => {
    it("converts a known easting/northing to the right place in Sweden", () => {
      const toLatLng = getProjectedToLatLng(3006);
      expect(toLatLng).not.toBeNull();
      // Stockholm-ish reference point.
      const { lat, lng } = toLatLng!(674032, 6580822);
      expect(lat).toBeCloseTo(59.331, 2);
      expect(lng).toBeCloseTo(18.064, 2);
    });
  });

  describe("EPSG:3067 (ETRS-TM35FIN, Finland)", () => {
    // Regression test for the Kotka-Jukola replay bug: Finnish events publish
    // their Livelox route data in EPSG:3067. Before 3067 was supported,
    // getProjectedToLatLng(3067) returned null, the transform fell back to
    // treating easting/northing as raw lat/lng micro-degrees, and every
    // waypoint decoded to (lat 67.16, lng 4.95) — off in the Norwegian Sea.
    // That blew up the follow-camera bounding box and pushed the map canvas
    // ~231 000 px off-screen, so no map was displayed.
    it("converts the bug's route coordinate to Kotka, not the Norwegian Sea", () => {
      const toLatLng = getProjectedToLatLng(3067);
      expect(toLatLng).not.toBeNull();
      // The decoded route value (easting×10=4 946 255, northing×10=67 160 745)
      // implies these meters in EPSG:3067.
      const { lat, lng } = toLatLng!(494625.5, 6716074.5);
      expect(lat).toBeCloseTo(60.5806, 3);
      expect(lng).toBeCloseTo(26.9019, 3);
    });

    it("round-trips lat/lng → TM35FIN → lat/lng", () => {
      const toLatLng = getProjectedToLatLng(3067);
      const lat0 = 60.58056;
      const lng0 = 26.90192;
      const tm = latLngToTM(lat0, lng0, 3067);
      expect(tm).not.toBeNull();
      const back = toLatLng!(tm!.easting, tm!.northing);
      expect(back.lat).toBeCloseTo(lat0, 6);
      expect(back.lng).toBeCloseTo(lng0, 6);
    });
  });

  it("latLngToTM returns null for an unsupported EPSG code", () => {
    expect(latLngToTM(60, 27, 9999)).toBeNull();
  });
});
