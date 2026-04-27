import { describe, it, expect } from "vitest";
import {
  voltsFromMeos,
  meosFromVolts,
  legacyRawByteToMillivolts,
  legacyHundredthsToMillivolts,
} from "../voltage.js";

describe("voltsFromMeos", () => {
  it("converts integer millivolts to volts", () => {
    expect(voltsFromMeos(2980)).toBeCloseTo(2.98, 5);
    expect(voltsFromMeos(2889)).toBeCloseTo(2.889, 5);
    expect(voltsFromMeos(3300)).toBeCloseTo(3.3, 5);
  });

  it("accepts BigInt (Prisma raw-SQL int columns)", () => {
    expect(voltsFromMeos(2980n)).toBeCloseTo(2.98, 5);
  });

  it("returns null for zero / negative / nullish (not measured)", () => {
    expect(voltsFromMeos(0)).toBeNull();
    expect(voltsFromMeos(-1)).toBeNull();
    expect(voltsFromMeos(null)).toBeNull();
    expect(voltsFromMeos(undefined)).toBeNull();
  });
});

describe("meosFromVolts", () => {
  it("encodes volts as integer millivolts", () => {
    expect(meosFromVolts(2.98)).toBe(2980);
    expect(meosFromVolts(2.889)).toBe(2889);
    expect(meosFromVolts(3.3)).toBe(3300);
  });

  it("round-trips through voltsFromMeos", () => {
    for (const v of [2.0, 2.5, 2.89, 2.98, 3.07, 3.3]) {
      const back = voltsFromMeos(meosFromVolts(v));
      expect(back).toBeCloseTo(v, 2);
    }
  });

  it("returns null for nothing-to-store cases", () => {
    expect(meosFromVolts(0)).toBeNull();
    expect(meosFromVolts(-0.1)).toBeNull();
    expect(meosFromVolts(null)).toBeNull();
    expect(meosFromVolts(undefined)).toBeNull();
    expect(meosFromVolts(NaN)).toBeNull();
  });
});

describe("legacyRawByteToMillivolts", () => {
  it("converts the SIAC raw-byte values seen in real databases", () => {
    // From a production Vinterserien database: raw 11/12/13 ↔ 2889/2980 mV.
    expect(legacyRawByteToMillivolts(11)).toBe(2890);
    expect(legacyRawByteToMillivolts(12)).toBe(2980);
    expect(legacyRawByteToMillivolts(13)).toBe(3070);
  });

  it("leaves already-millivolt values alone (idempotent)", () => {
    expect(legacyRawByteToMillivolts(2980)).toBe(2980);
    expect(legacyRawByteToMillivolts(256)).toBe(256);
    expect(legacyRawByteToMillivolts(0)).toBe(0);
    expect(legacyRawByteToMillivolts(-1)).toBe(-1);
  });
});

describe("legacyHundredthsToMillivolts", () => {
  it("scales hundredths of a volt up to millivolts", () => {
    expect(legacyHundredthsToMillivolts(298)).toBe(2980);
    expect(legacyHundredthsToMillivolts(289)).toBe(2890);
    expect(legacyHundredthsToMillivolts(330)).toBe(3300);
  });

  it("leaves already-millivolt values alone (idempotent)", () => {
    expect(legacyHundredthsToMillivolts(2980)).toBe(2980);
    expect(legacyHundredthsToMillivolts(1000)).toBe(1000);
    expect(legacyHundredthsToMillivolts(0)).toBe(0);
  });
});
