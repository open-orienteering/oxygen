/**
 * Club symbol decisions on the API side (docs/map-symbols.md §8.5): review
 * decisions → row writes, and a job's decision snapshot reaching stage 6 in
 * the worker with the same bytes as the inline path.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mapDocument, mapImport, symbolLibrary } from "@oxygen/shared";
import { importOcadToDocument } from "../import/ocad.js";
import { DecisionInputError, planDecisionWrites, reviewDecisionSchema, symbolDecisionsSchema } from "../map-store/decisions.js";
import { runImportInWorker } from "../map-store/jobs.js";

const fixture = readFileSync(fileURLToPath(new URL("../../../../e2e/test.ocd", import.meta.url)));
const V = `ISOM2017-2@${symbolLibrary.SYMBOL_LIBRARY_VERSION}`;

describe("planDecisionWrites", async () => {
  const { bytes } = await importOcadToDocument(fixture, "test.ocd");
  const header = mapDocument.readMapDocumentHeader(bytes).header;
  const ring = header.symbols.findIndex((s) => s.code === "702.0");
  const fp = mapImport.documentSymbolFingerprints(header)[ring]!;
  const graphic = header.symbols.findIndex((s) => s.origin !== "source");

  it("accept / unmatch write under the current release, reset clears the library", () => {
    expect(fp).toMatch(/^ocad:702:[0-9a-f]{8}$/);
    expect(planDecisionWrites(header, [{ symbolIdx: ring, accept: "ISOM2017-2:703" }])).toEqual([{ op: "set", fingerprint: fp, libraryVersion: V, canonicalId: "ISOM2017-2:703" }]);
    expect(planDecisionWrites(header, [{ symbolIdx: ring, unmatch: true }])).toEqual([{ op: "set", fingerprint: fp, libraryVersion: V, canonicalId: null }]);
    expect(planDecisionWrites(header, [{ symbolIdx: ring, reset: true }])).toEqual([{ op: "reset", fingerprint: fp, libraryId: "ISOM2017-2" }]);
  });

  it("lets a later decision on the same symbol win", () => {
    expect(planDecisionWrites(header, [{ symbolIdx: ring, accept: "ISOM2017-2:703" }, { symbolIdx: ring, unmatch: true }])).toEqual([{ op: "set", fingerprint: fp, libraryVersion: V, canonicalId: null }]);
  });

  it("rejects unknown indices, non-source symbols and entries outside the document's library", () => {
    expect(() => planDecisionWrites(header, [{ symbolIdx: 9999, unmatch: true }])).toThrow(DecisionInputError);
    if (graphic >= 0) expect(() => planDecisionWrites(header, [{ symbolIdx: graphic, unmatch: true }])).toThrow(DecisionInputError);
    expect(() => planDecisionWrites(header, [{ symbolIdx: ring, accept: "ISSprOM2019-2:703" }])).toThrow(/not an entry of ISOM2017-2/);
    expect(() => planDecisionWrites(header, [{ symbolIdx: ring, accept: "ISOM2017-2:999" }])).toThrow(DecisionInputError);
  });

  it("validates the decide input shape (06 §5.1)", () => {
    expect(reviewDecisionSchema.safeParse({ symbolIdx: 1, accept: "ISOM2017-2:703" }).success).toBe(true);
    expect(reviewDecisionSchema.safeParse({ symbolIdx: 1, unmatch: true }).success).toBe(true);
    expect(reviewDecisionSchema.safeParse({ symbolIdx: 1, reset: true }).success).toBe(true);
    expect(reviewDecisionSchema.safeParse({ symbolIdx: 1, unmatch: false }).success).toBe(false);
    expect(reviewDecisionSchema.safeParse({ symbolIdx: 1, accept: "x", reset: true }).success).toBe(false);
    expect(reviewDecisionSchema.safeParse({ symbolIdx: -1, reset: true }).success).toBe(false);
  });
});

describe("decision snapshot in the worker", () => {
  it("applies the job's decisions in stage 6 with the same bytes as inline, and a different hash than without", async () => {
    const plain = await importOcadToDocument(fixture, "test.ocd");
    const header = mapDocument.readMapDocumentHeader(plain.bytes).header;
    const ring = header.symbols.findIndex((s) => s.code === "702.0");
    const fp = mapImport.documentSymbolFingerprints(header)[ring]!;
    const decisions = mapImport.decisionsFromRows([{ fingerprint: fp, libraryVersion: V, canonicalId: "ISOM2017-2:703", decidedAt: new Date() }], "ocad");
    // The snapshot survives the JSONB column's shape.
    expect(symbolDecisionsSchema.parse(JSON.parse(JSON.stringify(decisions)))).toEqual(decisions);
    const [worker, inline] = await Promise.all([
      runImportInWorker(fixture, "test.ocd", { decisions, timeoutMs: 60_000 }),
      importOcadToDocument(fixture, "test.ocd", { match: { decisions } }),
    ]);
    expect(worker.documentHash).toBe(inline.documentHash);
    expect(worker.documentHash).not.toBe(plain.documentHash);
    expect(worker.report.matching?.byMethod.explicit).toBe(1);
    const decided = mapDocument.readMapDocumentHeader(worker.bytes).header.symbols[ring];
    expect(decided.match).toMatchObject({ canonicalId: "ISOM2017-2:703", method: "explicit", state: "auto", reviewed: true });
    expect(mapDocument.isAppliedMatch(decided.match)).toBe(true);
  }, 60_000);
});
