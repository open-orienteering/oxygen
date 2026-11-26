import { describe, it, expect } from "vitest";
import { rocProtocol, ROC_DEFAULT_ENDPOINT, ROC_MAX_INT } from "../online-input/roc.js";
import { sanitizeMapping, applyMapping } from "../online-input/mapping.js";
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

/** The well-formed rows only; `skipped` has its own tests below. */
const parse = (body: string) => rocProtocol.parseResponse(body).punches;

describe("rocProtocol.parseResponse", () => {
  it("parses a typical ROC response", () => {
    const body =
      "1;31;1234567;2026-05-05 09:42:13\n" +
      "2;100;7654321;2026-05-05 09:43:00\n";
    const punches = parse(body);
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
    expect(parse("")).toEqual([]);
  });

  it("ignores blank lines, trailing newlines and trailing whitespace", () => {
    const body =
      "\n\n1;31;1234567;2026-05-05 09:42:13   \n" +
      "  \n\n";
    const punches = parse(body);
    expect(punches).toHaveLength(1);
    expect(punches[0].punchId).toBe(1);
  });

  it("strips a BOM at the start of the body", () => {
    const body = "\uFEFF1;31;1234567;2026-05-05 09:42:13\n";
    const punches = parse(body);
    expect(punches).toHaveLength(1);
    expect(punches[0].rawCode).toBe(31);
  });

  it("handles CRLF line endings", () => {
    const body = "1;31;1234567;2026-05-05 09:42:13\r\n2;32;7654321;2026-05-05 09:43:00\r\n";
    const punches = parse(body);
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
    const punches = parse(body);
    expect(punches.map((p) => p.punchId)).toEqual([1, 2, 4]);
  });

  it("rejects rows with non-positive id, code or card", () => {
    const body =
      "0;31;1234567;2026-05-05 09:42:13\n" +
      "1;0;1234567;2026-05-05 09:42:13\n" +
      "2;31;0;2026-05-05 09:42:13\n";
    expect(parse(body)).toEqual([]);
  });

  it("rejects rows where the time-of-day is invalid", () => {
    const body =
      "1;31;1234567;2026-05-05 25:00:00\n" + // hour > 23
      "2;31;1234567;2026-05-05 09:60:00\n" + // minute > 59
      "3;31;1234567;2026-05-05 09:00:60\n";  // second > 59
    expect(parse(body)).toEqual([]);
  });

  it("tolerates extra trailing fields by ignoring them", () => {
    const body = "1;31;1234567;2026-05-05 09:42:13;extra;trailing\n";
    const punches = parse(body);
    expect(punches).toHaveLength(1);
    expect(punches[0].punchId).toBe(1);
  });
});

describe("rocProtocol.parseResponse: range checks and skipped rows", () => {
  it("skips a row whose id, code or card does not fit int4 and keeps its neighbours", () => {
    const body =
      "1;31;1001;2026-05-05 09:42:13\n" +
      "99999999999;31;1002;2026-05-05 09:42:14\n" + // id above int4
      "2147483648;31;1003;2026-05-05 09:42:15\n" + // id = int4 max + 1
      "4;2147483648;1004;2026-05-05 09:42:16\n" + // code above int4
      "5;31;99999999999;2026-05-05 09:42:17\n" + // card above int4
      "6;32;1006;2026-05-05 09:42:18\n";
    const result = rocProtocol.parseResponse(body);
    expect(result.punches.map((p) => p.punchId)).toEqual([1, 6]);
    expect(result.skipped).toBe(4);
  });

  it("accepts the int4 maximum itself", () => {
    const result = rocProtocol.parseResponse(
      `${ROC_MAX_INT};31;${ROC_MAX_INT};2026-05-05 09:42:13\n`,
    );
    expect(result.punches).toHaveLength(1);
    expect(result.punches[0].punchId).toBe(ROC_MAX_INT);
  });

  it("rejects numeric fields with trailing junk that parseInt would accept", () => {
    const body =
      "12abc;31;1001;2026-05-05 09:42:13\n" +
      "13;31x;1001;2026-05-05 09:42:13\n" +
      "14;31;1001.5;2026-05-05 09:42:13\n" +
      "15;-31;1001;2026-05-05 09:42:13\n" +
      "16;31;1001;2026-05-05 09:42:13\n";
    const result = rocProtocol.parseResponse(body);
    expect(result.punches.map((p) => p.punchId)).toEqual([16]);
    expect(result.skipped).toBe(4);
  });

  it("tolerates whitespace around numeric fields", () => {
    const result = rocProtocol.parseResponse(" 7 ; 31 ; 1001 ;2026-05-05 09:42:13\n");
    expect(result.punches).toHaveLength(1);
    expect(result.punches[0]).toMatchObject({ punchId: 7, rawCode: 31, cardNo: 1001 });
  });

  it("counts malformed lines as skipped but not blank lines", () => {
    const body = "\n  \ngarbage\n1;31;1001;2026-05-05 09:42:13\n\n;;;;\n";
    const result = rocProtocol.parseResponse(body);
    expect(result.punches).toHaveLength(1);
    expect(result.skipped).toBe(2);
  });

  it("reports an HTML page as zero punches and some skipped lines", () => {
    const body =
      "<!DOCTYPE html>\n<html><head><title>502 Bad Gateway</title></head>\n" +
      "<body>Bad gateway</body></html>\n";
    const result = rocProtocol.parseResponse(body);
    expect(result.punches).toEqual([]);
    expect(result.skipped).toBeGreaterThan(0);
  });

  it("reports an empty or whitespace-only body as nothing skipped", () => {
    expect(rocProtocol.parseResponse("")).toEqual({ punches: [], skipped: 0 });
    expect(rocProtocol.parseResponse(" \r\n\n ")).toEqual({ punches: [], skipped: 0 });
  });
});

describe("sanitizeMapping / applyMapping", () => {
  it("keeps positive integer codes mapped to start, finish or check", () => {
    expect(sanitizeMapping({ "100": 2, "101": 1, "102": 3 })).toEqual({
      "100": 2,
      "101": 1,
      "102": 3,
    });
  });

  it("drops bad codes and bad targets", () => {
    expect(
      sanitizeMapping({ "0": 2, "-5": 1, "abc": 1, "12x": 2, "100": 4, "101": "2", "102": null }),
    ).toEqual({});
  });

  it("returns {} for non-objects", () => {
    expect(sanitizeMapping(null)).toEqual({});
    expect(sanitizeMapping(undefined)).toEqual({});
    expect(sanitizeMapping([2])).toEqual({});
    expect(sanitizeMapping("x")).toEqual({});
  });

  it("applyMapping rewrites a mapped code and passes others through", () => {
    const m = sanitizeMapping({ "100": 2 });
    expect(applyMapping(m, 100)).toBe(2);
    expect(applyMapping(m, 31)).toBe(31);
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
