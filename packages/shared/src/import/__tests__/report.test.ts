/**
 * Warning classification and the import report's per-emission detail
 * (docs/map-import.md §3.6, §5, §7).
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { importReportSchema, importWarningDetailSchema, isUnsupportedPrimitive, WARNING_CLASS } from "../report.js";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCES = ["ocad-source", "omap-source", "omap-reader", "omap-symbols", "ocad-symbols", "match-document", "crt"];

/** Every upper-case code literal passed to a warning sink or typed into a code union in the importer sources. */
function emittedCodes(): Set<string> {
  const found = new Set<string>();
  for (const name of SOURCES) {
    const text = readFileSync(resolve(here, "..", `${name}.ts`), "utf8");
    for (const m of text.matchAll(/(?:warn|add)\(\s*"([A-Z][A-Z0-9_]+)"|code: "([A-Z][A-Z0-9_]+)"|\|\s*"([A-Z][A-Z0-9_]+)"/g)) {
      found.add(m[1] ?? m[2] ?? m[3]);
    }
  }
  return found;
}

describe("WARNING_CLASS", () => {
  it("classifies every code the importers, matcher and CRT parser emit", () => {
    const missing = [...emittedCodes()].filter((c) => !(c in WARNING_CLASS));
    expect(missing).toEqual([]);
  });

  it("names no code that nothing emits", () => {
    const emitted = emittedCodes();
    expect(Object.keys(WARNING_CLASS).filter((c) => !emitted.has(c))).toEqual([]);
  });

  it("keeps the unsupported-primitive set to the six codes of the S0 gate", () => {
    const unsupported = Object.entries(WARNING_CLASS).filter(([, k]) => k === "unsupported").map(([c]) => c).sort();
    expect(unsupported).toEqual([
      "COLOUR_OPACITY_IGNORED",
      "IRREGULAR_PATTERN_REGULARISED",
      "SYMBOL_FEATURE_DROPPED",
      "SYMBOL_TYPE_UNSUPPORTED",
      "TEXT_BOX_DROPPED",
      "UNKNOWN_OBJECT_TYPE",
    ]);
  });

  it("classes the rectangle grid as a by-design drop", () => {
    expect(WARNING_CLASS.RECTANGLE_GRID_DROPPED).toBe("by-design");
  });

  it("treats a stale symbol reference as a source data error, not an unsupported primitive", () => {
    expect(WARNING_CLASS.SYMBOL_REFERENCE_INVALID).toBe("source-error");
    expect(isUnsupportedPrimitive("SYMBOL_REFERENCE_INVALID")).toBe(false);
    expect(isUnsupportedPrimitive("SYMBOL_FEATURE_DROPPED")).toBe(true);
    expect(isUnsupportedPrimitive("NOT_A_CODE")).toBe(false);
  });
});

describe("importReportSchema warningDetails", () => {
  const base = {
    importer: "ocad-10",
    source: { kind: "ocad" as const, version: "12", fileName: "a.ocd", bytes: 1, fileHash: "0".repeat(64) },
    counts: { objects: 0, coordinates: 0, symbols: 0, symbolsRendered: 0, symbolsUnrendered: 0, colours: 0, texts: 0, graphicObjects: 0, missingSymbolObjects: 0 },
    warnings: [],
    timings: {},
  };

  it("accepts a report with and without per-emission detail", () => {
    expect(importReportSchema.safeParse(base).success).toBe(true);
    const detailed = { ...base, warningDetails: [{ code: "SYMBOL_REFERENCE_INVALID", message: "301.2: border symbol 301002 is the symbol itself", symbolIdx: 4 }, { code: "TEMPLATES_DROPPED", message: "1 template(s)" }] };
    expect(importReportSchema.safeParse(detailed).success).toBe(true);
  });

  it("rejects an entry without a message or with a negative symbol index", () => {
    expect(importWarningDetailSchema.safeParse({ code: "X" }).success).toBe(false);
    expect(importWarningDetailSchema.safeParse({ code: "X", message: "m", symbolIdx: -1 }).success).toBe(false);
  });
});
