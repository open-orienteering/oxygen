import { describe, expect, it } from "vitest";
import {
  computeDeclination,
  computeMeridianStalenessDeg,
  computeTrueNorthFromGrid,
  detectMapNorth,
  displayNorthOffsetDeg,
  foldLineAngleDeg,
  isMeridianStale,
  meridianStalenessFromDetection,
  MERIDIAN_STALE_WARN_DEG,
  probeMeridianLines,
  roundTenths,
  type OcadNorthSource,
} from "../map-north.js";
import type { OcadCrs } from "../map-projection.js";

/** Nackareservatet CRS origin (SWEREF99 TM). */
function nackaCrs(grivationRad = 0): OcadCrs {
  const easting = 687000;
  const northing = 6574000;
  const scale = 15000;
  return {
    easting,
    northing,
    scale,
    grivation: grivationRad,
    code: 3006,
    catalog: "EPSG",
    toProjectedCoord([x, y]: number[]): number[] {
      const cosG = Math.cos(-grivationRad);
      const sinG = Math.sin(-grivationRad);
      const rx = x * cosG - y * sinG;
      const ry = x * sinG + y * cosG;
      return [rx * (scale / 100_000) + easting, ry * (scale / 100_000) + northing];
    },
  };
}

describe("foldLineAngleDeg", () => {
  it("folds opposite directions onto the same undirected angle", () => {
    expect(foldLineAngleDeg(-176.7)).toBeCloseTo(3.3, 5);
    expect(foldLineAngleDeg(176.7)).toBeCloseTo(-3.3, 5);
    expect(foldLineAngleDeg(3.3)).toBeCloseTo(3.3, 5);
  });
});

describe("computeTrueNorthFromGrid", () => {
  it("returns ≈ −2.8° at the Nackareservatet origin", () => {
    const result = computeTrueNorthFromGrid(nackaCrs());
    expect(result).not.toBeNull();
    expect(result!.angleDeg).toBeCloseTo(-2.82, 1);
    expect(result!.lat).toBeCloseTo(59.26, 1);
    expect(result!.lng).toBeCloseTo(18.28, 1);
  });
});

describe("computeDeclination", () => {
  it("returns an east-positive declination for Stockholm today", () => {
    const decl = computeDeclination(59.3, 18.1, new Date("2026-09-18"));
    expect(decl).not.toBeNull();
    // ≈ 8° E in 2026 and rising ~0.15°/yr.
    expect(decl!).toBeGreaterThan(7);
    expect(decl!).toBeLessThan(10);
  });

  it("returns null instead of throwing outside the bundled WMM range", () => {
    expect(computeDeclination(59.3, 18.1, new Date("1990-01-01"))).toBeNull();
  });
});

describe("computeMeridianStalenessDeg", () => {
  it("is the difference between today's grivation and the drawn grivation", () => {
    // Nackareservatet 2023 file measured in 2023: declination 7.312,
    // trueNorthFromGrid −2.821 → today's grivation 4.49; lines drawn at
    // ScalePar 0 + in-paper tilt 3.3 → 1.2° stale already at survey.
    expect(
      computeMeridianStalenessDeg({
        declinationDeg: 7.312,
        trueNorthFromGridDeg: -2.821,
        declaredGrivationDeg: 0,
        meridianTiltDeg: 3.3,
      }),
    ).toBe(1.2);
  });

  it("is zero when the lines were drawn for today's declination", () => {
    expect(
      computeMeridianStalenessDeg({
        declinationDeg: 7.3,
        trueNorthFromGridDeg: -2.8,
        declaredGrivationDeg: 4.5,
        meridianTiltDeg: 0,
      }),
    ).toBe(0);
  });

  it("counts a ScalePar grivation and an in-paper tilt the same way", () => {
    const viaScalePar = computeMeridianStalenessDeg({
      declinationDeg: 7.3,
      trueNorthFromGridDeg: -2.8,
      declaredGrivationDeg: 4.5,
      meridianTiltDeg: 0,
    });
    const viaTilt = computeMeridianStalenessDeg({
      declinationDeg: 7.3,
      trueNorthFromGridDeg: -2.8,
      declaredGrivationDeg: 0,
      meridianTiltDeg: 4.5,
    });
    expect(viaScalePar).toBe(viaTilt);
  });
});

describe("isMeridianStale", () => {
  it(`flags |staleness| ≥ ${MERIDIAN_STALE_WARN_DEG}°`, () => {
    expect(isMeridianStale(1.7)).toBe(true);
    expect(isMeridianStale(-1.0)).toBe(true);
    expect(isMeridianStale(0.9)).toBe(false);
    expect(isMeridianStale(null)).toBe(false);
    expect(isMeridianStale(undefined)).toBe(false);
  });
});

describe("probeMeridianLines", () => {
  it("finds a large near-parallel 601.x cluster", () => {
    const objects = Array.from({ length: 40 }, (_, i) => ({
      sym: 601001,
      coordinates: [
        [i * 1000, 0],
        [i * 1000 + 30, 10000], // ~0.17° tilt
      ],
    }));
    // Custom track symbol — should be ignored (too few / different id).
    objects.push(
      ...Array.from({ length: 5 }, (_, i) => ({
        sym: 601002,
        coordinates: [
          [0, i * 1000],
          [5000, i * 1000],
        ],
      })),
    );
    const probe = probeMeridianLines(objects);
    expect(probe).not.toBeNull();
    expect(probe!.symbolId).toBe(601001);
    expect(probe!.count).toBe(40);
    expect(probe!.stddevDeg).toBeLessThan(0.7);
  });

  it("rejects a scattered non-parallel set", () => {
    const objects = Array.from({ length: 20 }, (_, i) => ({
      sym: 601001,
      coordinates: [
        [0, 0],
        [Math.cos((i * 20 * Math.PI) / 180) * 10000, Math.sin((i * 20 * Math.PI) / 180) * 10000],
      ],
    }));
    expect(probeMeridianLines(objects)).toBeNull();
  });
});

/** Nacka-like drawing: 601 lines tilted ~3.3° inside the paper. */
function nackaMeridians(tiltDx = 580) {
  return Array.from({ length: 30 }, (_, i) => ({
    sym: 601001,
    coordinates: [
      [i * 2000, 0],
      [i * 2000 + tiltDx, 10000],
    ],
  }));
}

describe("detectMapNorth", () => {
  it("reports the drawn meridians' staleness for the given date (Nacka, 2023)", () => {
    const ocad: OcadNorthSource = {
      getCrs: () => nackaCrs(0),
      objects: nackaMeridians(),
    };
    const det = detectMapNorth(ocad, new Date("2023-03-29"));
    expect(det.meridian).not.toBeNull();
    expect(det.meridian!.medianTiltDeg).toBeCloseTo(3.3, 0);
    // declination (≈7.3) + trueNorthFromGrid (≈−2.8) − grivation (0)
    // − drawn tilt (≈3.3) ≈ 1.2
    expect(det.meridianStalenessDeg).toBeCloseTo(1.2, 0);
    expect(det.asOf).toBe(new Date("2023-03-29").toISOString());
  });

  it("grows with time: the same drawing is staler in 2026 than in 2023", () => {
    const ocad: OcadNorthSource = {
      getCrs: () => nackaCrs(0),
      objects: nackaMeridians(),
    };
    const in2023 = detectMapNorth(ocad, new Date("2023-03-29"));
    const in2026 = detectMapNorth(ocad, new Date("2026-09-18"));
    expect(in2026.meridianStalenessDeg!).toBeGreaterThan(
      in2023.meridianStalenessDeg!,
    );
    // Sweden drifts ≈ 0.1–0.2°/yr eastward → +0.3…0.8° over 3.5 years.
    expect(
      in2026.meridianStalenessDeg! - in2023.meridianStalenessDeg!,
    ).toBeGreaterThan(0.2);
    expect(
      in2026.meridianStalenessDeg! - in2023.meridianStalenessDeg!,
    ).toBeLessThan(1.0);
  });

  it("has no staleness without a meridian cluster, but still reports declination", () => {
    const ocad: OcadNorthSource = {
      getCrs: () => nackaCrs(0),
      objects: [],
    };
    const det = detectMapNorth(ocad, new Date("2026-09-18"));
    expect(det.meridian).toBeNull();
    expect(det.meridianStalenessDeg).toBeNull();
    expect(det.declinationDeg).not.toBeNull();
  });

  it("never carries a correction: the result has no auto-apply fields", () => {
    const det = detectMapNorth(
      { getCrs: () => nackaCrs(0), objects: nackaMeridians(30) },
      new Date("2026-09-18"),
    );
    expect(det).not.toHaveProperty("suggestedCorrectionDeg");
    expect(det).not.toHaveProperty("shouldAutoApply");
  });
});

describe("meridianStalenessFromDetection", () => {
  it("re-evaluates a stored detection row for a later date", () => {
    const stored = detectMapNorth(
      { getCrs: () => nackaCrs(0), objects: nackaMeridians() },
      new Date("2023-03-29"),
    );
    const later = meridianStalenessFromDetection(stored, new Date("2026-09-18"));
    expect(later).not.toBeNull();
    expect(later!).toBeGreaterThan(stored.meridianStalenessDeg!);
    // Same number the full parser path produces for that date.
    const fresh = detectMapNorth(
      { getCrs: () => nackaCrs(0), objects: nackaMeridians() },
      new Date("2026-09-18"),
    );
    expect(later).toBe(fresh.meridianStalenessDeg);
  });

  it("returns null for rows without meridians or grid", () => {
    expect(meridianStalenessFromDetection(null)).toBeNull();
    expect(
      meridianStalenessFromDetection({
        meridian: null,
        declaredGrivationDeg: 0,
        trueNorthFromGridDeg: -2.8,
        centerLat: 59.3,
        centerLng: 18.3,
      }),
    ).toBeNull();
    expect(
      meridianStalenessFromDetection({
        meridian: { symbolId: 601001, count: 30, medianTiltDeg: 3.3, stddevDeg: 0.1 },
        declaredGrivationDeg: 0,
        trueNorthFromGridDeg: null,
        centerLat: 59.3,
        centerLng: 18.3,
      }),
    ).toBeNull();
  });
});

describe("displayNorthOffsetDeg", () => {
  it("folds the meridian tilt into the paper north offset", () => {
    // Nackareservatet at correction 0: paper +Y bears 2.7° true, meridians
    // tilt 3.3° in paper → display-up must bear 6.0° for vertical lines.
    const meridian = {
      symbolId: 601001,
      count: 128,
      medianTiltDeg: 3.3,
      stddevDeg: 0.04,
    };
    expect(displayNorthOffsetDeg(2.7, meridian)).toBeCloseTo(6.0, 5);
  });

  it("passes the paper offset through when there is no meridian cluster", () => {
    expect(displayNorthOffsetDeg(2.7, null)).toBe(2.7);
    expect(displayNorthOffsetDeg(null, null)).toBeNull();
  });
});

describe("roundTenths", () => {
  it("rounds to one decimal", () => {
    expect(roundTenths(4.49)).toBe(4.5);
    expect(roundTenths(4.44)).toBe(4.4);
  });
});
