import { describe, it, expect } from "vitest";
import {
  mapControlType,
  mapResultStatus,
  decodeSplitTimes,
} from "../livelox/transform.js";

describe("mapControlType", () => {
  it("maps 0 to start", () => {
    expect(mapControlType(0)).toBe("start");
  });

  it("maps 2 to finish", () => {
    expect(mapControlType(2)).toBe("finish");
  });

  it("maps 1 to control", () => {
    expect(mapControlType(1)).toBe("control");
  });

  it("maps unknown values to control", () => {
    expect(mapControlType(99)).toBe("control");
    expect(mapControlType(-1)).toBe("control");
  });
});

describe("mapResultStatus", () => {
  it("maps 0 to ok", () => expect(mapResultStatus(0)).toBe("ok"));
  it("maps 1 to mp", () => expect(mapResultStatus(1)).toBe("mp"));
  it("maps 2 to dnf", () => expect(mapResultStatus(2)).toBe("dnf"));
  it("maps 3 to dns", () => expect(mapResultStatus(3)).toBe("dns"));
  it("maps 4 to dq", () => expect(mapResultStatus(4)).toBe("dq"));
  it("maps unknown values to unknown", () => {
    expect(mapResultStatus(5)).toBe("unknown");
    expect(mapResultStatus(99)).toBe("unknown");
  });
});

describe("decodeSplitTimes", () => {
  const courseControls = [
    { code: "31", numericCode: 31 },
    { code: "32", numericCode: 32 },
    { code: "33", numericCode: 33 },
    { code: "100", numericCode: 100 }, // finish
  ];

  it("returns empty for null/undefined input", () => {
    const result = decodeSplitTimes(null as unknown as number[], courseControls);
    expect(result.splits).toEqual([]);
    expect(result.baseTimeMs).toBe(0);
  });

  it("returns empty for too-short input", () => {
    const result = decodeSplitTimes([1000], courseControls);
    expect(result.splits).toEqual([]);
    expect(result.baseTimeMs).toBe(0);
  });

  it("extracts baseTimeMs from first element", () => {
    const result = decodeSplitTimes([5000000, 0], courseControls);
    expect(result.baseTimeMs).toBe(5000000);
    expect(result.splits).toEqual([]);
  });

  it("decodes leg times as cumulative splits", () => {
    // [baseTime, startCode, leg1ms, ctrl1code, leg2ms, ctrl2code, leg3ms, finishCode]
    const result = decodeSplitTimes(
      [1000000, 0, 120000, 31, 90000, 32, 150000, 100],
      courseControls,
    );

    expect(result.baseTimeMs).toBe(1000000);
    expect(result.splits).toHaveLength(3);

    // First split: 120s cumulative
    expect(result.splits[0]).toEqual({ controlCode: "31", timeMs: 120000 });
    // Second split: 120s + 90s = 210s cumulative
    expect(result.splits[1]).toEqual({ controlCode: "32", timeMs: 210000 });
    // Third split (finish): 210s + 150s = 360s cumulative
    expect(result.splits[2]).toEqual({ controlCode: "100", timeMs: 360000 });
  });

  it("handles unknown control codes by stringifying", () => {
    const result = decodeSplitTimes(
      [1000000, 0, 60000, 999],
      courseControls,
    );
    expect(result.splits[0].controlCode).toBe("999");
  });

  it("handles odd-length data (last leg without control code)", () => {
    const result = decodeSplitTimes(
      [1000000, 0, 60000],
      courseControls,
    );
    expect(result.splits).toHaveLength(1);
    expect(result.splits[0].controlCode).toBe("?");
    expect(result.splits[0].timeMs).toBe(60000);
  });
});
