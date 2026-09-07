import { describe, expect, it } from "vitest";
import {
  computeTrueNorthFromGrid,
  displayNorthOffsetDeg,
  foldLineAngleDeg,
  probeMeridianLines,
  roundTenths,
  suggestCorrectionDeg,
  detectNorthCorrection,
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

describe("suggestCorrectionDeg", () => {
  it("matches the Nackareservatet physics candidate (~4.5°) with no meridian tilt", () => {
    // Declination at Nacka on 2023-03-29 ≈ 7.31°; trueNorthFromGrid ≈ −2.82°.
    expect(
      suggestCorrectionDeg({
        declinationDeg: 7.312,
        trueNorthFromGridDeg: -2.821,
        declaredGrivationDeg: 0,
      }),
    ).toBe(4.5);
  });

  it("subtracts the meridian tilt when the drawing's north lines lean in paper space", () => {
    // Nackareservatet: meridians tilt 3.3° inside the drawing, so the
    // paper needs that much less rotation for the lines to point at the
    // declination: 7.312 − 2.821 − 0 − 3.3 ≈ 1.2.
    expect(
      suggestCorrectionDeg({
        declinationDeg: 7.312,
        trueNorthFromGridDeg: -2.821,
        declaredGrivationDeg: 0,
        meridianTiltDeg: 3.3,
      }),
    ).toBe(1.2);
  });

  it("subtracts an already-declared grivation", () => {
    expect(
      suggestCorrectionDeg({
        declinationDeg: 7.3,
        trueNorthFromGridDeg: -2.8,
        declaredGrivationDeg: 4.5,
      }),
    ).toBe(0);
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

describe("detectNorthCorrection", () => {
  it("subtracts the drawn meridian tilt from the suggestion (Nacka 2023)", () => {
    const objects = Array.from({ length: 30 }, (_, i) => ({
      sym: 601001,
      coordinates: [
        [i * 2000, 0],
        [i * 2000 + 580, 10000], // ~3.3° tilt like Nacka
      ],
    }));
    const ocad: OcadNorthSource = {
      getCrs: () => nackaCrs(0),
      objects,
      header: { fileDate: new Date("2023-03-29") },
    };
    const det = detectNorthCorrection(ocad);
    expect(det.meridianGate).toBe(true);
    // declination (≈7.3) + trueNorthFromGrid (≈−2.8) − grivation (0)
    // − meridian tilt (≈3.3) ≈ 1.2 — the tilt is subtracted because the
    // drawn meridians, not paper +Y, must point at the declination.
    expect(det.suggestedCorrectionDeg).toBeCloseTo(1.2, 0);
    expect(det.shouldAutoApply).toBe(false); // |1.2| < 1.5 auto-apply floor
    expect(det.meridian!.medianTiltDeg).toBeCloseTo(3.3, 0);
  });

  it("auto-applies when meridians are near-vertical in paper and |suggested| ≥ 1.5°", () => {
    const objects = Array.from({ length: 30 }, (_, i) => ({
      sym: 601001,
      coordinates: [
        [i * 2000, 0],
        [i * 2000 + 30, 10000], // ~0.17° tilt — drawing is magnetic-up
      ],
    }));
    const ocad: OcadNorthSource = {
      getCrs: () => nackaCrs(0),
      objects,
      header: { fileDate: new Date("2023-03-29") },
    };
    const det = detectNorthCorrection(ocad);
    expect(det.meridianGate).toBe(true);
    // ≈ 7.3 − 2.8 − 0 − 0.17 ≈ 4.3
    expect(det.suggestedCorrectionDeg).toBeCloseTo(4.3, 0);
    expect(det.shouldAutoApply).toBe(true);
  });

  it("does not auto-apply without a meridian gate", () => {
    const ocad: OcadNorthSource = {
      getCrs: () => nackaCrs(0),
      objects: [],
      header: { fileDate: new Date("2023-03-29") },
    };
    const det = detectNorthCorrection(ocad);
    expect(det.meridianGate).toBe(false);
    expect(det.shouldAutoApply).toBe(false);
    expect(det.suggestedCorrectionDeg).not.toBeNull();
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
