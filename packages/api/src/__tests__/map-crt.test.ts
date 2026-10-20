/**
 * CRT export / import on the API side (docs/map-symbols.md §8.6,
 * docs/map-import.md §2.2): the file name, the import plan against the
 * `e2e/test.ocd` document, and decide's cap.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mapDocument, mapImport } from "@oxygen/shared";
import { importOcadToDocument } from "../import/ocad.js";
import { DecisionInputError, MAX_REVIEW_DECISIONS } from "../map-store/decisions.js";
import { crtFileName, MAX_CRT_BYTES, planCrtImport } from "../map-store/crt.js";

const fixture = readFileSync(fileURLToPath(new URL("../../../../e2e/test.ocd", import.meta.url)));

describe("crtFileName", () => {
  it("follows Mapper's SOURCE-TARGET.crt convention", () => {
    expect(crtFileName("Skogen 2026.ocd", "ISOM2017-2")).toBe("Skogen 2026-ISOM2017-2.crt");
    expect(crtFileName("sprint.v2.omap", "ISSprOM2019-2")).toBe("sprint.v2-ISSprOM2019-2.crt");
    expect(crtFileName("C:\\maps\\club/map.ocd", "ISOM2017-2")).toBe("map-ISOM2017-2.crt");
    expect(crtFileName("", "ISOM2017-2")).toBe("map-ISOM2017-2.crt");
  });

  it("has a 1 MiB input limit", () => {
    expect(MAX_CRT_BYTES).toBe(1024 * 1024);
  });
});

describe("planCrtImport", async () => {
  const { bytes } = await importOcadToDocument(fixture, "test.ocd");
  const header = mapDocument.readMapDocumentHeader(bytes).header;
  const ring = header.symbols.findIndex((s) => s.code === "702.0");
  const north = header.symbols.findIndex((s) => s.code === "601.0");

  it("resolves a Mapper-style table on the fixture: a decision, an unchanged variant line, a report", () => {
    const plan = planCrtImport(header, "703 702\n601.b 601.0\n999 702.0\n");
    expect(plan.decisions).toEqual([{ symbolIdx: ring, accept: "ISOM2017-2:703" }]);
    expect(plan.unchanged).toEqual([{ line: 2, symbolIdx: north }]);
    expect(plan.warnings).toEqual([{ code: "CRT_TARGET_UNKNOWN", count: 1, message: "line 3: 999" }]);
  });

  it("round-trips the fixture's full table: nothing to record", () => {
    const text = mapImport.formatCrt(header, { decisions: [], documentHash: "0".repeat(64), includeMatches: true }).text;
    const plan = planCrtImport(header, text);
    expect(plan.decisions).toEqual([]);
    expect(plan.unchanged.length).toBeGreaterThan(0);
    expect(plan.skipped).toEqual([]);
  });

  it("refuses more decisions than decide takes", () => {
    const many = { ...header, symbols: Array.from({ length: MAX_REVIEW_DECISIONS + 1 }, () => header.symbols[ring]) };
    expect(() => planCrtImport(many, "703 702.0\n")).toThrow(DecisionInputError);
    expect(planCrtImport({ ...many, symbols: many.symbols.slice(1) }, "703 702.0\n").decisions).toHaveLength(MAX_REVIEW_DECISIONS);
  });
});
