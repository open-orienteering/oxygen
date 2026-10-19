/**
 * Club symbol decisions and review rows (docs/map-symbols.md §8.5; 06 §5.1,
 * §5.3): fingerprints computed from a stored document equal the matcher's,
 * rows → decisions across library releases, "does a document follow the
 * decisions", and the review rows on the stage 6–7 fixture.
 */

import { describe, expect, it } from "vitest";
import { attrsSectionRange, decodeMapDocument, encodeMapDocument, objectsPerSymbol, readMapDocumentHeader } from "../../map-document/codec.js";
import { parseRenderSymbol } from "../../render/symbol.js";
import { SYMBOL_LIBRARY_VERSION } from "../../symbol-library/index.js";
import { identifySourceColours } from "../colour-align.js";
import { decisionFingerprint, decisionsFromRows, documentFollowsDecisions, documentSymbolFingerprints, libraryIdOfVersion, parseDecisionFingerprint, reviewRows, type ClubDecisionRow } from "../decisions.js";
import { matchDocument } from "../match-document.js";
import { symbolIrHash } from "../matcher.js";
import { colours, input } from "./match-fixture.js";

const V = `ISOM2017-2@${SYMBOL_LIBRARY_VERSION}`;
const stored = (opts: Parameters<typeof matchDocument>[1] = {}) => readMapDocumentHeader(encodeMapDocument(matchDocument(input(), opts).input)).header;

describe("fingerprints", () => {
  it("are readable and parse back", () => {
    expect(decisionFingerprint("ocad", "527.0", "0a1b2c3d")).toBe("ocad:527:0a1b2c3d");
    expect(parseDecisionFingerprint("ocad:527:0a1b2c3d")).toEqual({ kind: "ocad", code: "527", irHash: "0a1b2c3d" });
    expect(parseDecisionFingerprint("omap:505.1:ffffffff")).toEqual({ kind: "omap", code: "505.1", irHash: "ffffffff" });
    for (const bad of ["", "ocad:527", "ocad:527:xyz", "ocad:527:0a1b2c3d:x"]) expect(parseDecisionFingerprint(bad)).toBeNull();
  });

  it("computed from a stored, aligned document equal the matcher-time hash over the source stack", () => {
    const src = input();
    const infos = identifySourceColours(colours, "ISOM2017-2", "iof2022");
    const classOf = (i: number) => infos[i]?.class ?? null;
    const expected = src.header.symbols.map((s) => ((s.origin ?? "source") === "source" && s.render ? `ocad:${s.code.replace(/\.0$/, "")}:${symbolIrHash(parseRenderSymbol(s.render), classOf)}` : null));
    const header = stored();
    expect(header.colours.length).toBeGreaterThan(colours.length); // the stack really was re-ordered / extended
    expect(documentSymbolFingerprints(header)).toEqual(expected);
    // graphic and render-less symbols have none
    expect(documentSymbolFingerprints(header)[6]).toBeNull();
    expect(documentSymbolFingerprints(header)[7]).toBeNull();
  });

  it("do not depend on the symbol name", () => {
    const a = input();
    const b = input();
    b.header.symbols[3] = { ...b.header.symbols[3], name: "Hus" };
    expect(documentSymbolFingerprints(b.header)[3]).toBe(documentSymbolFingerprints(a.header)[3]);
  });
});

describe("decisionsFromRows", () => {
  const fp = documentSymbolFingerprints(input().header)[3]!;
  const at = (s: string) => new Date(s);

  it("reads every release of a library, newest decision wins", () => {
    const rows: ClubDecisionRow[] = [
      { fingerprint: fp, libraryVersion: "ISOM2017-2@2025.01.0", canonicalId: "ISOM2017-2:521", decidedAt: at("2026-01-01") },
      { fingerprint: fp, libraryVersion: V, canonicalId: null, decidedAt: at("2026-02-01") },
    ];
    expect(decisionsFromRows(rows, "ocad")).toEqual([{ code: "527", irHash: fp.split(":")[2], canonicalId: null, libraryId: "ISOM2017-2" }]);
    expect(decisionsFromRows([rows[1], rows[0]].map((r, i) => ({ ...r, decidedAt: at(i ? "2026-03-01" : "2026-02-01") })), "ocad")[0].canonicalId).toBe("ISOM2017-2:521");
  });

  it("breaks a decided_at tie by the later release", () => {
    const rows: ClubDecisionRow[] = [
      { fingerprint: fp, libraryVersion: "ISOM2017-2@2026.10.2", canonicalId: "ISOM2017-2:521", decidedAt: at("2026-01-01") },
      { fingerprint: fp, libraryVersion: "ISOM2017-2@2026.10.1", canonicalId: null, decidedAt: at("2026-01-01") },
    ];
    expect(decisionsFromRows(rows, "ocad")[0].canonicalId).toBe("ISOM2017-2:521");
  });

  it("keeps one decision per library and drops other source kinds and unparseable rows", () => {
    const rows: ClubDecisionRow[] = [
      { fingerprint: fp, libraryVersion: V, canonicalId: "ISOM2017-2:521", decidedAt: at("2026-01-01") },
      { fingerprint: fp, libraryVersion: `ISSprOM2019-2@${SYMBOL_LIBRARY_VERSION}`, canonicalId: "ISSprOM2019-2:521.1", decidedAt: at("2026-01-02") },
      { fingerprint: fp.replace(/^ocad/, "omap"), libraryVersion: V, canonicalId: null, decidedAt: at("2026-01-03") },
      { fingerprint: "nonsense", libraryVersion: V, canonicalId: null, decidedAt: at("2026-01-03") },
      { fingerprint: fp, libraryVersion: "none", canonicalId: null, decidedAt: at("2026-01-04") },
    ];
    const ds = decisionsFromRows(rows, "ocad");
    expect(ds.map((d) => d.libraryId)).toEqual(["ISOM2017-2", "ISSprOM2019-2"]);
    expect(decisionsFromRows(rows, "omap")).toHaveLength(1);
  });

  it("libraryIdOfVersion", () => {
    expect(libraryIdOfVersion(V)).toBe("ISOM2017-2");
    expect(libraryIdOfVersion("none")).toBeNull();
  });
});

describe("matchDocument with club decisions", () => {
  const fp = documentSymbolFingerprints(input().header)[3]!;
  const row = (canonicalId: string | null, libraryVersion = V): ClubDecisionRow => ({ fingerprint: fp, libraryVersion, canonicalId, decidedAt: new Date("2026-01-01") });

  it("applies a row as the explicit stage", () => {
    const res = matchDocument(input(), { decisions: decisionsFromRows([row("ISOM2017-2:521")], "ocad") });
    expect(res.input.header.symbols[3].match).toMatchObject({ canonicalId: "ISOM2017-2:521", method: "explicit", state: "auto", reviewed: true });
    expect(res.matching.byMethod.explicit).toBe(1);
  });

  it("ignores a decision of the other library without warning", () => {
    const res = matchDocument(input(), { decisions: decisionsFromRows([row("ISSprOM2019-2:521.1", `ISSprOM2019-2@${SYMBOL_LIBRARY_VERSION}`)], "ocad") });
    expect(res.input.header.symbols[3].match).toMatchObject({ method: "geometry", state: "suggested" });
    expect(res.warnings.map((w) => w.code)).not.toContain("DECISION_UNKNOWN_ENTRY");
  });

  it("applies a decision made under an older release (03 §6.5: a re-match keeps reviewed rows)", () => {
    const res = matchDocument(input(), { decisions: decisionsFromRows([row(null, "ISOM2017-2@2020.01.0")], "ocad") });
    expect(res.input.header.symbols[3].match).toMatchObject({ canonicalId: null, method: "explicit", state: "unmatched", reviewed: true });
  });
});

describe("documentFollowsDecisions", () => {
  const fp = documentSymbolFingerprints(input().header)[3]!;
  const decided = (canonicalId: string | null) => decisionsFromRows([{ fingerprint: fp, libraryVersion: V, canonicalId, decidedAt: new Date("2026-01-01") }], "ocad");

  it("holds for the matcher's output without decisions and fails once a decision applies", () => {
    expect(documentFollowsDecisions(stored(), [])).toBe(true);
    expect(documentFollowsDecisions(stored(), decided("ISOM2017-2:521"))).toBe(false);
    expect(documentFollowsDecisions(stored(), decided(null))).toBe(false);
  });

  it("holds for a document made with the same decisions, fails when they change or are reset", () => {
    const withAccept = stored({ decisions: decided("ISOM2017-2:521") });
    expect(documentFollowsDecisions(withAccept, decided("ISOM2017-2:521"))).toBe(true);
    expect(documentFollowsDecisions(withAccept, decided(null))).toBe(false);
    expect(documentFollowsDecisions(withAccept, [])).toBe(false);
  });

  it("treats a decision naming an entry the library lacks as not applying (it falls through)", () => {
    const dangling = decided("ISOM2017-2:999");
    expect(documentFollowsDecisions(stored({ decisions: dangling }), dangling)).toBe(true);
  });

  it("follows trivially for a header without a library", () => {
    const h = stored();
    expect(documentFollowsDecisions({ ...h, library: null }, decided(null))).toBe(true);
  });
});

describe("reviewRows", () => {
  const bytes = encodeMapDocument(matchDocument(input()).input);
  const header = readMapDocumentHeader(bytes).header;
  const doc = decodeMapDocument(bytes);
  const counts = Array.from({ length: header.symbols.length }, (_, i) => doc.attrs.symbolIdx.filter((x) => x === i).length);
  const rows = reviewRows(header, counts, { edition: "iof2022" });
  const row = (code: string) => rows.find((r) => r.code === code)!;

  it("counts objects per symbol from the attrs section alone", () => {
    const headerLength = new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
    const { offset, length } = attrsSectionRange(header, headerLength);
    expect(objectsPerSymbol(bytes.subarray(offset, offset + length), header.symbols.length)).toEqual(counts);
    expect(counts.slice(0, 7)).toEqual([2, 1, 1, 1, 2, 1, 1]);
  });

  it("has one row per source symbol, in header order", () => {
    expect(rows.map((r) => r.symbolIdx)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(rows.map((r) => r.code)).toEqual(["101.0", "502.0", "204.0", "527.0", "521.3", "900.0", "401.0"]);
    expect(row("101.0")).toMatchObject({ name: "Höjdkurva", type: "line", objects: 2, colourClass: "brown", flags: [] });
  });

  it("carries the stored match and the matcher's candidates with reasons, at most three", () => {
    const r = row("527.0");
    expect(r.match).toMatchObject({ canonicalId: "ISOM2017-2:521", state: "suggested" });
    expect(r.candidates[0]).toMatchObject({ canonicalId: "ISOM2017-2:521" });
    expect(r.candidates.length).toBeGreaterThanOrEqual(1);
    expect(r.candidates.length).toBeLessThanOrEqual(3);
    for (const c of r.candidates) expect(c.reasons.length).toBeGreaterThan(0);
    expect(new Set(r.candidates.map((c) => c.canonicalId)).size).toBe(r.candidates.length);
    expect(r.fingerprint).toBe(documentSymbolFingerprints(header)[3]);
  });

  it("flags club symbols, and render-less rows have no fingerprint or candidates", () => {
    expect(row("900.0").flags).toContain("club-symbol");
    expect(row("401.0")).toMatchObject({ fingerprint: null, candidates: [], colourClass: "unclassified" });
  });

  it("flags hidden, unused and text symbols", () => {
    const h = { ...header, symbols: header.symbols.map((s, i) => (i === 2 ? { ...s, hidden: true } : i === 4 ? { ...s, kind: "text" as const } : s)) };
    const c = [...counts];
    c[1] = 0;
    const rs = reviewRows(h, c);
    expect(rs[2].flags).toContain("hidden");
    expect(rs[1].flags).toContain("unused");
    expect(rs[4].flags).toContain("text");
  });

  it("shows a reviewed row with the decision as match and still the matcher's proposal as candidates", () => {
    const fp = documentSymbolFingerprints(header)[3]!;
    const ds = decisionsFromRows([{ fingerprint: fp, libraryVersion: V, canonicalId: null, decidedAt: new Date() }], "ocad");
    const h2 = readMapDocumentHeader(encodeMapDocument(matchDocument(input(), { decisions: ds }).input)).header;
    const r = reviewRows(h2, counts).find((x) => x.code === "527.0")!;
    expect(r.match).toMatchObject({ method: "explicit", canonicalId: null, reviewed: true });
    expect(r.candidates[0].canonicalId).toBe("ISOM2017-2:521");
  });

  it("gives a pre-matcher header rows with no match and no candidates", () => {
    const h = { ...header, library: null, symbols: header.symbols.map(({ match: _m, ...s }) => s) };
    const rs = reviewRows(h, counts);
    expect(rs.every((r) => r.match === null && r.candidates.length === 0)).toBe(true);
  });
});
