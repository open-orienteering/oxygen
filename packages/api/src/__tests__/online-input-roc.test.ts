import { describe, it, expect } from "vitest";
import { rocProtocol, ROC_DEFAULT_ENDPOINT } from "../online-input/roc.js";
import { formatHMS, parseHMS } from "../online-input/protocol.js";

describe("rocProtocol.buildRequest", () => {
  const baseCfg = {
    protocol: "roc" as const,
    endpointUrl: ROC_DEFAULT_ENDPOINT,
    unitId: "12345",
  };
  const baseEvent = { date: "2026-05-05", zeroTimeDs: 324000 };

  it("produces the canonical ROC URL", () => {
    const { url } = rocProtocol.buildRequest(baseCfg, 0, baseEvent);
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("http://roc.olresultat.se/getpunches.asp");
    expect(parsed.searchParams.get("unitId")).toBe("12345");
    expect(parsed.searchParams.get("lastId")).toBe("0");
    expect(parsed.searchParams.get("date")).toBe("2026-05-05");
    expect(parsed.searchParams.get("time")).toBe("09:00:00");
  });

  it("threads lastId through unchanged", () => {
    const { url } = rocProtocol.buildRequest(baseCfg, 4711, baseEvent);
    expect(new URL(url).searchParams.get("lastId")).toBe("4711");
  });

  it("URL-encodes a unitId with special characters", () => {
    const { url } = rocProtocol.buildRequest({ ...baseCfg, unitId: "AA:BB:CC" }, 0, baseEvent);
    expect(new URL(url).searchParams.get("unitId")).toBe("AA:BB:CC");
  });

  it("respects a custom endpoint URL (e.g. OResults)", () => {
    const { url } = rocProtocol.buildRequest(
      { ...baseCfg, endpointUrl: "https://api.oresults.eu/roc" },
      0,
      baseEvent,
    );
    expect(new URL(url).origin).toBe("https://api.oresults.eu");
  });

  it("does not emit any auth headers", () => {
    const { headers } = rocProtocol.buildRequest(baseCfg, 0, baseEvent);
    expect(headers).toBeUndefined();
  });
});

describe("rocProtocol.parseResponse", () => {
  it("parses a typical ROC response", () => {
    const body =
      "1;31;1234567;2026-05-05 09:42:13\n" +
      "2;100;7654321;2026-05-05 09:43:00\n";
    const punches = rocProtocol.parseResponse(body);
    expect(punches).toEqual([
      {
        punchId: 1,
        rawCode: 31,
        cardNo: 1234567,
        absoluteTimeDs: (9 * 3600 + 42 * 60 + 13) * 10,
      },
      {
        punchId: 2,
        rawCode: 100,
        cardNo: 7654321,
        absoluteTimeDs: (9 * 3600 + 43 * 60 + 0) * 10,
      },
    ]);
  });

  it("returns [] on an empty body", () => {
    expect(rocProtocol.parseResponse("")).toEqual([]);
  });

  it("ignores blank lines, trailing newlines and trailing whitespace", () => {
    const body =
      "\n\n1;31;1234567;2026-05-05 09:42:13   \n" +
      "  \n\n";
    const punches = rocProtocol.parseResponse(body);
    expect(punches).toHaveLength(1);
    expect(punches[0].punchId).toBe(1);
  });

  it("strips a BOM at the start of the body", () => {
    const body = "\uFEFF1;31;1234567;2026-05-05 09:42:13\n";
    const punches = rocProtocol.parseResponse(body);
    expect(punches).toHaveLength(1);
    expect(punches[0].rawCode).toBe(31);
  });

  it("handles CRLF line endings", () => {
    const body = "1;31;1234567;2026-05-05 09:42:13\r\n2;32;7654321;2026-05-05 09:43:00\r\n";
    const punches = rocProtocol.parseResponse(body);
    expect(punches).toHaveLength(2);
  });

  it("skips malformed rows but keeps valid ones", () => {
    const body =
      "1;31;1234567;2026-05-05 09:42:13\n" +
      "garbage\n" +
      "2;100;7654321;2026-05-05 09:43:00\n" +
      ";;;;\n" +
      "3;55;2222222;not-a-timestamp\n" +
      "4;55;3333333;2026-05-05 09:44:00\n";
    const punches = rocProtocol.parseResponse(body);
    expect(punches.map((p) => p.punchId)).toEqual([1, 2, 4]);
  });

  it("rejects rows with non-positive id, code or card", () => {
    const body =
      "0;31;1234567;2026-05-05 09:42:13\n" +
      "1;0;1234567;2026-05-05 09:42:13\n" +
      "2;31;0;2026-05-05 09:42:13\n";
    expect(rocProtocol.parseResponse(body)).toEqual([]);
  });

  it("rejects rows where the time-of-day is invalid", () => {
    const body =
      "1;31;1234567;2026-05-05 25:00:00\n" + // hour > 23
      "2;31;1234567;2026-05-05 09:60:00\n" + // minute > 59
      "3;31;1234567;2026-05-05 09:00:60\n";  // second > 59
    expect(rocProtocol.parseResponse(body)).toEqual([]);
  });

  it("tolerates extra trailing fields by ignoring them", () => {
    const body = "1;31;1234567;2026-05-05 09:42:13;extra;trailing\n";
    const punches = rocProtocol.parseResponse(body);
    expect(punches).toHaveLength(1);
    expect(punches[0].punchId).toBe(1);
  });
});

describe("formatHMS / parseHMS", () => {
  it("round-trips deciseconds → HH:MM:SS → deciseconds", () => {
    for (const ds of [0, 1, 36000, 324000, 540000, 863999]) {
      // round to whole seconds (HH:MM:SS has no decisecond resolution)
      const wholeSecondDs = ds - (ds % 10);
      expect(parseHMS(formatHMS(wholeSecondDs))).toBe(wholeSecondDs);
    }
  });

  it("formatHMS pads with leading zeros", () => {
    expect(formatHMS(0)).toBe("00:00:00");
    expect(formatHMS(36000 * 9)).toBe("09:00:00");
    expect(formatHMS(36000 * 9 + 60 * 10)).toBe("09:01:00");
  });

  it("parseHMS handles a date prefix", () => {
    expect(parseHMS("2026-05-05 09:42:13")).toBe((9 * 3600 + 42 * 60 + 13) * 10);
  });

  it("parseHMS returns NaN on malformed input", () => {
    expect(Number.isNaN(parseHMS(""))).toBe(true);
    expect(Number.isNaN(parseHMS("9:00"))).toBe(true);
    expect(Number.isNaN(parseHMS("abc"))).toBe(true);
  });
});
