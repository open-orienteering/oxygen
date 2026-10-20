/**
 * CRT codec (docs/map-symbols.md §8.6; research 06 §5.1, §5.3, 03 §3.2):
 * Mapper's grammar, Oxygen's comments, resolution against a stored
 * document and the round trip.
 */

import { describe, expect, it } from "vitest";
import { encodeMapDocument, readMapDocumentHeader } from "../../map-document/codec.js";
import { SYMBOL_LIBRARY_VERSION } from "../../symbol-library/index.js";
import { formatCrt, parseCrt, resolveCrt } from "../crt.js";
import { documentSymbolFingerprints, type ClubDecisionRow, decisionsFromRows } from "../decisions.js";
import { matchDocument } from "../match-document.js";
import type { SymbolDecision } from "../matcher.js";
import type { RenderSymbol } from "../../render/symbol.js";
import { input } from "./match-fixture.js";

const V = `ISOM2017-2@${SYMBOL_LIBRARY_VERSION}`;
const HASH = "c".repeat(64);
const stored = (decisions: SymbolDecision[] = []) => readMapDocumentHeader(encodeMapDocument(matchDocument(input(), { decisions }).input)).header;
const fps = documentSymbolFingerprints(stored());
const decided = (pairs: [number, string | null][]): SymbolDecision[] =>
  decisionsFromRows(pairs.map(([i, canonicalId]): ClubDecisionRow => ({ fingerprint: fps[i]!, libraryVersion: V, canonicalId, decidedAt: new Date("2026-01-01") })), "ocad");
const codes = (r: { warnings: { code: string; count: number }[] }) => Object.fromEntries(r.warnings.map((w) => [w.code, w.count]));

describe("fixture", () => {
  it("has the matches the tests rely on", () => {
    const h = stored();
    expect(h.symbols.map((s) => [s.code, s.match?.state ?? null, s.match?.canonicalId ?? null])).toEqual([
      ["101.0", "auto", "ISOM2017-2:101"],
      ["502.0", "auto", "ISOM2017-2:502"],
      ["204.0", "auto", "ISOM2017-2:204"],
      ["527.0", "suggested", "ISOM2017-2:521"],
      ["521.3", "unmatched", null],
      ["900.0", "unmatched", null],
      ["401.0", "unmatched", null],
      ["graphic", null, null],
    ]);
  });
});

describe("parseCrt", () => {
  it("reads Mapper's own tables: target first, source the rest of the line, # comments", () => {
    // From Mapper's symbol sets/ISOM2000-ISOM 2017-2.crt.
    const f = parseCrt("#\n# (C) 2017, 2019 Kai Pastor\n\n101       101\n101.1     104\n104.9     106.0.1\n  104\t106.1  \n");
    expect(f.problems).toEqual([]);
    expect(f.statements).toEqual([
      { kind: "rule", line: 4, target: "101", source: "101" },
      { kind: "rule", line: 5, target: "101.1", source: "104" },
      { kind: "rule", line: 6, target: "104.9", source: "106.0.1" },
      { kind: "rule", line: 7, target: "104", source: "106.1" },
    ]);
  });

  it("has no trailing comments: a # after the target is part of the source", () => {
    const f = parseCrt("703 702.0 # control");
    expect(f.statements).toEqual([]);
    expect(f.problems).toEqual([{ line: 1, code: "CRT_QUERY_UNSUPPORTED", message: "702.0 # control" }]);
  });

  it("strips a BOM and accepts CRLF", () => {
    expect(parseCrt("﻿703 702.0\r\n704 705\r\n").statements.map((s) => s.line)).toEqual([1, 2]);
  });

  it("bounds the offending text in a skip message", () => {
    expect(parseCrt(`406 a = ${"x".repeat(500)}`).problems[0].message).toHaveLength(121);
  });

  it("reports object queries and lines without a source", () => {
    const f = parseCrt("406    natural = wood\n408 SYMBOL\n703\n# keep\n");
    expect(f.statements).toEqual([{ kind: "rule", line: 2, target: "408", source: "SYMBOL" }]);
    expect(f.problems).toEqual([
      { line: 1, code: "CRT_QUERY_UNSUPPORTED", message: "natural = wood" },
      { line: 3, code: "CRT_LINE_INVALID", message: "703" },
      { line: 4, code: "CRT_LINE_INVALID", message: "# keep" },
    ]);
  });

  it("reads Oxygen's header, # fp (bound to the next statement) and # keep", () => {
    const f = parseCrt([
      `# oxygen-crt library=${V} source=ocad document=${HASH}`,
      "# fp ocad:702:d5d4a092 decision 702.0 Control point",
      "# a plain comment does not unbind",
      "703       702.0",
      "# fp ocad:403:c694d305 decision 403.0 Rough open land",
      "# keep 403.0",
      "601.b     601.0",
      `# fp ${"ocad:204:0a1b2c3d"}`,
      "# fp not-a-fingerprint",
      "521 521.0",
    ].join("\n"));
    expect(f.header).toEqual({ library: V, source: "ocad", document: HASH });
    expect(f.statements).toEqual([
      { kind: "rule", line: 4, target: "703", source: "702.0", fingerprint: "ocad:702:d5d4a092" },
      { kind: "keep", line: 6, source: "403.0", fingerprint: "ocad:403:c694d305" },
      { kind: "rule", line: 7, target: "601.b", source: "601.0" },
      { kind: "rule", line: 10, target: "521", source: "521.0" },
    ]);
    expect(f.problems).toEqual([]);
  });
});

describe("formatCrt", () => {
  it("writes the header and nothing else without decisions", () => {
    const out = formatCrt(stored(), { decisions: [], documentHash: HASH });
    expect(out).toMatchObject({ rules: 0, kept: 0, auto: 0 });
    expect(out.text.split("\n")[0]).toBe(`# oxygen-crt library=${V} source=ocad document=${HASH}`);
    expect(out.text.split("\n").filter((l) => l && !l.startsWith("#"))).toEqual([]);
    expect(out.text.endsWith("\n")).toBe(true);
  });

  it("writes one rule per decided symbol in index order, # fp before it, keep as a comment", () => {
    const ds = decided([[3, "ISOM2017-2:521"], [0, "ISOM2017-2:103"], [5, null]]);
    const out = formatCrt(stored(ds), { decisions: ds, documentHash: HASH });
    expect(out).toMatchObject({ rules: 2, kept: 1, auto: 0 });
    expect(out.text.split("\n").slice(2)).toEqual([
      `# fp ${fps[0]} decision 101.0 Höjdkurva`,
      "103       101.0",
      `# fp ${fps[3]} decision 527.0 Byggnad`,
      "521       527.0",
      `# fp ${fps[5]} decision 900.0 Tunnelbana`,
      "# keep 900.0",
      "",
    ]);
  });

  it("is byte-stable and ignores decisions of the other library or of symbols not in the document", () => {
    const ds = [...decided([[3, "ISOM2017-2:521"]]), { code: "527", irHash: fps[3]!.split(":")[2], canonicalId: "ISSprOM2019-2:521.1", libraryId: "ISSprOM2019-2" }, { code: "999", irHash: "00000000", canonicalId: "ISOM2017-2:101", libraryId: "ISOM2017-2" }];
    const a = formatCrt(stored(), { decisions: ds, documentHash: HASH });
    expect(a.rules).toBe(1);
    expect(formatCrt(stored(), { decisions: [...ds].reverse(), documentHash: HASH }).text).toBe(a.text);
  });

  it("writes a decision whose entry the library has dropped (the import reports it)", () => {
    const ds: SymbolDecision[] = [{ code: "527", irHash: fps[3]!.split(":")[2], canonicalId: "ISOM2017-2:999", libraryId: "ISOM2017-2" }];
    expect(formatCrt(stored(), { decisions: ds, documentHash: HASH }).text).toContain("\n999       527.0\n");
  });

  it("includeMatches adds the automatic matches, marked auto; suggestions and variants stay out", () => {
    const ds = decided([[3, "ISOM2017-2:521"]]);
    const out = formatCrt(stored(ds), { decisions: ds, documentHash: HASH, includeMatches: true });
    expect(out).toMatchObject({ rules: 4, kept: 0, auto: 3 });
    const rules = out.text.split("\n").filter((l) => l && !l.startsWith("#"));
    expect(rules).toEqual(["101       101.0", "502       502.0", "204       204.0", "521       527.0"]);
    expect(out.text).toContain(`# fp ${fps[0]} auto 101.0 Höjdkurva\n`);
    expect(out.text).not.toContain("521.3");
  });
});

describe("resolveCrt", () => {
  it("round-trips: resolving an export gives back the decisions that went in", () => {
    const ds = decided([[3, "ISOM2017-2:521"], [0, "ISOM2017-2:103"], [5, null]]);
    const header = stored(ds);
    const r = resolveCrt(parseCrt(formatCrt(header, { decisions: ds, documentHash: HASH }).text), header);
    expect(r.decisions).toEqual([{ symbolIdx: 0, accept: "ISOM2017-2:103" }, { symbolIdx: 3, accept: "ISOM2017-2:521" }, { symbolIdx: 5, unmatch: true }]);
    expect(r).toMatchObject({ unchanged: [], skipped: [], warnings: [] });
  });

  it("does not record rules that restate the document's automatic matches (a full table round trip)", () => {
    const ds = decided([[3, "ISOM2017-2:521"]]);
    const header = stored(ds);
    const text = formatCrt(header, { decisions: ds, documentHash: HASH, includeMatches: true }).text;
    const r = resolveCrt(parseCrt(text), header);
    expect(r.decisions).toEqual([{ symbolIdx: 3, accept: "ISOM2017-2:521" }]);
    expect(r.unchanged.map((u) => u.symbolIdx)).toEqual([0, 1, 2]);
    // An edited auto line is a change.
    const edited = resolveCrt(parseCrt(text.replace("101       101.0", "103       101.0")), header);
    expect(edited.decisions).toEqual([{ symbolIdx: 0, accept: "ISOM2017-2:103" }, { symbolIdx: 3, accept: "ISOM2017-2:521" }]);
  });

  it("records a rule that restates an explicit match again (a fresh decided_at), and a keep always", () => {
    const ds = decided([[0, "ISOM2017-2:101"]]);
    const header = stored(ds);
    expect(header.symbols[0].match).toMatchObject({ method: "explicit", canonicalId: "ISOM2017-2:101" });
    expect(resolveCrt(parseCrt("101 101.0\n# keep 502.0\n"), header).decisions).toEqual([{ symbolIdx: 0, accept: "ISOM2017-2:101" }, { symbolIdx: 1, unmatch: true }]);
  });

  it("resolves a Mapper-style table by code: 101 ≡ 101.0, bare or full target ids", () => {
    const r = resolveCrt(parseCrt("103 101\nISOM2017-2:521 527.0\n# keep 900\n"), stored());
    expect(r.decisions).toEqual([{ symbolIdx: 0, accept: "ISOM2017-2:103" }, { symbolIdx: 3, accept: "ISOM2017-2:521" }, { symbolIdx: 5, unmatch: true }]);
    expect(r.warnings).toEqual([]);
  });

  it("applies a code-only rule to every symbol of that code, each under its own fingerprint", () => {
    const src = input();
    const building = src.header.symbols[3];
    const dup = { ...building, name: "Byggnad 2", render: { ...(building.render as RenderSymbol & { type: "area" }), fill: 2 } };
    src.header.symbols.splice(4, 0, dup);
    const header = readMapDocumentHeader(encodeMapDocument(matchDocument(src).input)).header;
    const fp = documentSymbolFingerprints(header);
    expect(fp[3]).not.toBe(fp[4]);
    const r = resolveCrt(parseCrt("521 527.0\n"), header);
    expect(r.decisions).toEqual([{ symbolIdx: 3, accept: "ISOM2017-2:521" }, { symbolIdx: 4, accept: "ISOM2017-2:521" }]);
    // A fingerprint narrows it to one.
    expect(resolveCrt(parseCrt(`# fp ${fp[4]}\n521 527.0\n`), header).decisions).toEqual([{ symbolIdx: 4, accept: "ISOM2017-2:521" }]);
  });

  it("applies by code when the fingerprint names no symbol here, and warns", () => {
    const r = resolveCrt(parseCrt("# fp ocad:527:00000000 decision\n521 527.0\n"), stored());
    expect(r.decisions).toEqual([{ symbolIdx: 3, accept: "ISOM2017-2:521" }]);
    expect(codes(r)).toEqual({ CRT_FINGERPRINT_MISMATCH: 1 });
    expect(r.warnings[0].message).toBe("line 2: ocad:527:00000000");
  });

  it("reports a fingerprint mismatch only on a line that then applies", () => {
    const r = resolveCrt(parseCrt("# fp ocad:888:00000000\n101 888.0\n"), stored());
    expect(codes(r)).toEqual({ CRT_SOURCE_UNKNOWN: 1 });
  });

  it("ignores a fingerprint of another code (the rule's source was edited)", () => {
    const r = resolveCrt(parseCrt(`# fp ${fps[3]}\n103 101.0\n`), stored());
    expect(r.decisions).toEqual([{ symbolIdx: 0, accept: "ISOM2017-2:103" }]);
    expect(codes(r)).toEqual({ CRT_FINGERPRINT_MISMATCH: 1 });
  });

  it("lets the later line for a symbol win", () => {
    expect(resolveCrt(parseCrt("521 527.0\n# keep 527.0\n"), stored()).decisions).toEqual([{ symbolIdx: 3, unmatch: true }]);
    // ... also over an earlier change when the later line restates the auto match.
    const r = resolveCrt(parseCrt("103 101.0\n101 101.0\n"), stored());
    expect(r.decisions).toEqual([]);
    expect(r.unchanged).toEqual([{ line: 2, symbolIdx: 0 }]);
  });

  it("reports every line it cannot apply, with counts, and applies the rest", () => {
    const text = [
      `# oxygen-crt library=ISSprOM2019-2@${SYMBOL_LIBRARY_VERSION} source=ocad document=${HASH}`,
      "521 527.0",
      "406    natural = wood",
      "703",
      "101 888.0",
      "101 777",
      "502 401.0", // no render, no fingerprint
      "999 204.0", // not an entry
      "ISSprOM2019-2:521.1 527.0", // another library's entry
      "graphic graphic",
    ].join("\n");
    const r = resolveCrt(parseCrt(text), stored());
    expect(r.decisions).toEqual([{ symbolIdx: 3, accept: "ISOM2017-2:521" }]);
    expect(codes(r)).toEqual({
      CRT_LIBRARY_MISMATCH: 1,
      CRT_QUERY_UNSUPPORTED: 1,
      CRT_LINE_INVALID: 1,
      CRT_SOURCE_UNKNOWN: 3,
      CRT_SOURCE_NOT_REVIEWABLE: 1,
      CRT_TARGET_UNKNOWN: 2,
    });
    expect(r.skipped.map((s) => [s.line, s.code])).toEqual([
      [3, "CRT_QUERY_UNSUPPORTED"],
      [4, "CRT_LINE_INVALID"],
      [5, "CRT_SOURCE_UNKNOWN"],
      [6, "CRT_SOURCE_UNKNOWN"],
      [7, "CRT_SOURCE_NOT_REVIEWABLE"],
      [8, "CRT_TARGET_UNKNOWN"],
      [9, "CRT_TARGET_UNKNOWN"],
      [10, "CRT_SOURCE_UNKNOWN"],
    ]);
    expect(r.warnings.find((w) => w.code === "CRT_SOURCE_UNKNOWN")!.message).toBe("line 5: 888.0; line 6: 777; line 10: graphic");
  });

  it("resolves against a pre-matcher document by the scale's library", () => {
    const header = readMapDocumentHeader(encodeMapDocument(input())).header;
    expect(header.library).toBeFalsy();
    expect(resolveCrt(parseCrt("521 527.0\n"), header).decisions).toEqual([{ symbolIdx: 3, accept: "ISOM2017-2:521" }]);
  });
});
