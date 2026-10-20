/**
 * Staged symbol matcher (03 §6.5) and document factor (03 §6.6) over
 * synthetic source symbol tables built from the library itself, named the
 * way Swedish OCAD template sets name them. The traps are the cases the
 * research corpus showed must *never* match automatically.
 */

import { describe, expect, it } from "vitest";
import { type AreaSymbol, type LineSymbol, type PointSymbol, type RenderSymbol, parseRenderSymbol } from "../../render/symbol.js";
import { remapRenderColours, scaleRenderSymbol } from "../../render/transform.js";
import { getLibraryEntry, getSymbolLibrary } from "../../symbol-library/index.js";
import { paletteIndex, paletteStack } from "../../symbol-library/palette.js";
import { resolveEntry } from "../../symbol-library/schema.js";
import { paletteClass } from "../colour-class.js";
import {
  baseCode, canonicalCandidates, chooseLibrary, descriptionTokens, detectDocumentFactor, MATCH_THRESHOLDS, matchContext, matchSymbol, normaliseCode,
  snapFactor, type SourceSymbolLike,
} from "../matcher.js";

const lib = getSymbolLibrary("ISOM2017-2");
const idx = paletteIndex("iof2024", lib.spec);
const stack = paletteStack("iof2024", lib.spec);
const classOf = (i: number) => paletteClass(stack[i].id.replace(/^[^:]+:/, ""), "iof2024");
const canonical = (id: string): RenderSymbol => resolveEntry(getLibraryEntry(id)!, idx);
const src = (code: string, name: string, render: RenderSymbol | null): SourceSymbolLike => ({ code, name, render });
const ctx = () => matchContext("ISOM2017-2", "iof2024", 1, classOf);

describe("codes", () => {
  it("normalises OCAD sub-numbers and finds the family", () => {
    expect(normaliseCode("101.0")).toBe("101");
    expect(normaliseCode("101.1")).toBe("101.1");
    expect(normaliseCode("501.100")).toBe("501.100");
    expect(normaliseCode("501.010")).toBe("501.10");
    expect(baseCode("520.4")).toBe("520");
    expect(baseCode("graphic")).toBe("gra");
  });

  it("chooses the library by scale unless overridden", () => {
    expect(chooseLibrary(15000)).toBe("ISOM2017-2");
    expect(chooseLibrary(10000)).toBe("ISOM2017-2");
    expect(chooseLibrary(4000)).toBe("ISSprOM2019-2");
    expect(chooseLibrary(5000)).toBe("ISSprOM2019-2");
    expect(chooseLibrary(4000, "ISOM2017-2")).toBe("ISOM2017-2");
  });

  it("builds one canonical candidate per library entry, cached", () => {
    const a = canonicalCandidates(lib, "iof2024");
    expect(a).toHaveLength(lib.entries.length);
    expect(canonicalCandidates(lib, "iof2024")).toBe(a);
  });
});

describe("matchSymbol — stages", () => {
  it("2: exact code + geometry → auto", () => {
    const r = matchSymbol(src("505.0", "Stig", canonical("ISOM2017-2:505")), ctx()).match;
    expect(r).toMatchObject({ canonicalId: "ISOM2017-2:505", method: "code+geometry", state: "auto", confidence: 1, reviewed: false });
    expect(r.libraryVersion).toMatch(/^ISOM2017-2@\d{4}\.\d+\.\d+$/);
  });

  it("3: family + geometry picks the variant the geometry says, whatever the sub-number", () => {
    const tagged = matchSymbol(src("202.1", "Brant (med taggar)", canonical("ISOM2017-2:202.b")), ctx()).match;
    expect(tagged).toMatchObject({ canonicalId: "ISOM2017-2:202.b", method: "family+geometry", state: "auto" });
    const plain = matchSymbol(src("202.3", "Brant (utan taggar)", canonical("ISOM2017-2:202")), ctx()).match;
    expect(plain).toMatchObject({ canonicalId: "ISOM2017-2:202", method: "family+geometry", state: "auto" });
    // OCAD "English" template sets number the heading itself as .1
    const contour = matchSymbol(src("101.1", "Contour", canonical("ISOM2017-2:101")), ctx()).match;
    expect(contour).toMatchObject({ canonicalId: "ISOM2017-2:101", state: "auto" });
  });

  it("3: a near miss inside the family is only suggested", () => {
    const wall = canonical("ISOM2017-2:513.1") as LineSymbol;
    const withoutDots: LineSymbol = { ...wall, glyphs: [] };
    const r = matchSymbol(src("513.100", "Stenmur (utan punkter)", withoutDots), ctx()).match;
    expect(r.state).toBe("suggested");
    expect(r.canonicalId).toBe("ISOM2017-2:513.1");
    expect(r.confidence).toBeLessThan(MATCH_THRESHOLDS.auto);
    expect(r.reasons.join(" ")).toMatch(/glyphs/);
  });

  it("trap: 527 Byggnad drawn exactly like 521 is suggested, never auto", () => {
    const r = matchSymbol(src("527.0", "Byggnad", canonical("ISOM2017-2:521")), ctx()).match;
    expect(r).toMatchObject({ canonicalId: "ISOM2017-2:521", method: "geometry", state: "suggested" });
  });

  it("trap: a club's own 503.4 path drawn like 515 is a geometry-only suggestion", () => {
    const r = matchSymbol(src("503.4", "Gång- och cykelväg", canonical("ISOM2017-2:515")), ctx()).match;
    expect(r.state).toBe("suggested");
    expect(r.method).toBe("geometry");
    expect(r.canonicalId).toBe("ISOM2017-2:515");
  });

  it("4: geometry-only ties break towards the source's hundred group, then the name", () => {
    // A black 0.2 mm dot: ISOM 603 (spot height) and the pattern element of 210 are both candidates of that shape.
    const dot: PointSymbol = { type: "point", id: "x", code: "603.1", name: "Höjdpunkt", glyph: { parts: [{ kind: "disc", colour: idx.get("black100")!, diameterUm: 200 }], rotatable: false }, orientation: "north" };
    const r = matchSymbol(src("603.1", "Höjdpunkt", dot), ctx()).match;
    expect(r.canonicalId).toBe("ISOM2017-2:603");
    expect(r.state).toBe("auto"); // family 603 exact geometry
  });

  it("5: description → suggested when the geometry is only partly compatible", () => {
    const control = canonical("ISOM2017-2:703") as PointSymbol;
    const ring6: PointSymbol = { ...control, glyph: { ...control.glyph, parts: [{ ...control.glyph.parts[0], diameterUm: 6000 }] } };
    // Old OCAD sets number the control ring 702 and draw it ø 6.0.
    const r = matchSymbol(src("702.0", "Control point", ring6), ctx()).match;
    expect(r).toMatchObject({ canonicalId: "ISOM2017-2:703", method: "description", state: "suggested" });
    expect(r.confidence).toBeLessThanOrEqual(0.5);
    expect(r.reasons[0]).toMatch(/Control point/);
  });

  it("5: description never suggests a candidate the colour class rules out", () => {
    // A brown 50 % paved footpath line: the only name match (501.1 edge) is a black line.
    const paved = parseRenderSymbol({ type: "line", id: "x", code: "501.14", name: "Belagd gångbana", main: { colour: idx.get("brown50-paved")!, widthUm: 500 } }) as LineSymbol;
    const r = matchSymbol(src("501.14", "Belagd gångbana", paved), matchContext("ISSprOM2019-2", "iof2024", 1, (i) => paletteClass(paletteStack("iof2024", "ISSprOM2019-2")[i].id.replace(/^[^:]+:/, ""), "iof2024"))).match;
    expect(r.state).toBe("unmatched");
  });

  it("variant: a point numbered into an area/line family is kept as source without a suggestion", () => {
    const sq: PointSymbol = { type: "point", id: "x", code: "521.3", name: "Byggnad (minimimått)", glyph: { parts: [{ kind: "fill", colour: idx.get("black100")!, geometry: { coords: [-250, -250, 250, -250, 250, 250, -250, 250], closed: true } }], rotatable: false }, orientation: "north" };
    const r = matchSymbol(src("521.3", "Byggnad (minimimått)", sq), ctx()).match;
    expect(r).toMatchObject({ canonicalId: null, method: "variant", state: "unmatched" });
    expect(r.reasons[0]).toMatch(/point variant of area symbol 521/);

    const dot: PointSymbol = { type: "point", id: "x", code: "210.1", name: "Stenig mark (enskild punkt)", glyph: { parts: [{ kind: "disc", colour: idx.get("black100")!, diameterUm: 200 }], rotatable: false }, orientation: "north" };
    const r2 = matchSymbol(src("210.1", "Stenig mark (enskild punkt)", dot), ctx()).match;
    expect(r2.method).toBe("variant"); // not "603 Spot height"
  });

  it("6: nothing — a symbol with no family and no name overlap", () => {
    const odd: AreaSymbol = { type: "area", id: "x", code: "999.0", name: "Klubbyta", fill: idx.get("yellow100")! };
    const r = matchSymbol(src("999.0", "Klubbyta", odd), ctx()).match;
    // Geometry alone finds 401 (yellow 100 %) but that is a strict-threshold suggestion; name adds nothing.
    expect(["suggested", "unmatched"]).toContain(r.state);
    if (r.state === "suggested") expect(r.method).toBe("geometry");
  });

  it("returns an unmatched record for symbols without a render definition", () => {
    expect(matchSymbol(src("821.0", "Text", null), ctx()).match).toMatchObject({ canonicalId: null, method: "none", state: "unmatched" });
  });

  it("lists runner-up alternatives for the review UI", () => {
    const r = matchSymbol(src("204.0", "Sten", canonical("ISOM2017-2:204")), ctx()).match;
    expect(r.canonicalId).toBe("ISOM2017-2:204");
    for (const a of r.alternatives ?? []) expect(a.canonicalId).not.toBe("ISOM2017-2:204");
  });
});

describe("matchSymbol — decisions (stage 1)", () => {
  it("applies an explicit mapping, a kept-as-source decision, and reports a dangling one", () => {
    const sym = src("527.0", "Byggnad", canonical("ISOM2017-2:521"));
    const mapped = matchSymbol(sym, matchContext("ISOM2017-2", "iof2024", 1, classOf, [{ code: "527", canonicalId: "ISOM2017-2:521" }])).match;
    expect(mapped).toMatchObject({ canonicalId: "ISOM2017-2:521", method: "explicit", state: "auto", reviewed: true, confidence: 1 });

    const kept = matchSymbol(sym, matchContext("ISOM2017-2", "iof2024", 1, classOf, [{ code: "527.0", name: "Byggnad", canonicalId: null }])).match;
    expect(kept).toMatchObject({ canonicalId: null, method: "explicit", state: "unmatched", reviewed: true });

    const dangling = matchSymbol(sym, matchContext("ISOM2017-2", "iof2024", 1, classOf, [{ code: "527", canonicalId: "ISOM2017-2:999" }]));
    expect(dangling.unknownDecision).toBe("ISOM2017-2:999");
    expect(dangling.match.state).toBe("suggested"); // fell through to geometry
    expect(dangling.match.reasons[0]).toMatch(/not in ISOM2017-2/);
  });

  it("does not apply a decision whose name or irHash differs", () => {
    const sym = src("527.0", "Byggnad", canonical("ISOM2017-2:521"));
    const r = matchSymbol(sym, matchContext("ISOM2017-2", "iof2024", 1, classOf, [{ code: "527", name: "Garage", canonicalId: null }])).match;
    expect(r.method).toBe("geometry");
  });
});

describe("document factor (03 §6.6)", () => {
  const lines = ["ISOM2017-2:101", "ISOM2017-2:102", "ISOM2017-2:103", "ISOM2017-2:505", "ISOM2017-2:516"];
  const canon = canonicalCandidates(lib, "iof2024");

  it("is 1 for a table drawn at reference size, from several line families", () => {
    const f = detectDocumentFactor(lines.map((id) => src(getLibraryEntry(id)!.code, id, canonical(id))), canon, classOf, 15000, 15000);
    expect(f).toMatchObject({ factor: 1, scaleFactor: 1, symbolScale: 1, method: "lines", rawMedian: 1 });
    expect(f.samples.length).toBe(5);
  });

  it("detects a 1.5 enlargement from line widths and snaps to the table", () => {
    const f = detectDocumentFactor(lines.map((id) => src(getLibraryEntry(id)!.code, id, scaleRenderSymbol(canonical(id), 1.5))), canon, classOf, 10000, 15000);
    expect(f).toMatchObject({ factor: 1.5, scaleFactor: 1.5, symbolScale: 1, method: "lines" });
    expect(snapFactor(1.49)).toBe(1.5);
    expect(snapFactor(1.3333)).toBe(1.333);
    expect(snapFactor(1.1)).toBe(1.1);
  });

  it("uses the family heading for sub-numbered codes and ignores unrelated widths", () => {
    const f = detectDocumentFactor(
      [src("101.1", "Contour", scaleRenderSymbol(canonical("ISOM2017-2:101"), 2)), src("505.1", "Footpath", scaleRenderSymbol(canonical("ISOM2017-2:505"), 2)), src("999.0", "x", canonical("ISOM2017-2:516"))],
      canon, classOf, 7500, 15000,
    );
    expect(f.factor).toBe(2);
    expect(f.samples.map((s) => s.code)).toEqual(["101.1", "505.1"]);
  });

  it("falls back to the exact-code fit, then the scale ratio, when no line family is usable, and honours an override", () => {
    // Points/areas at the scale's enlargement, or nothing with a spec code: the scale decides.
    const atScale = detectDocumentFactor([src("204.0", "Sten", scaleRenderSymbol(canonical("ISOM2017-2:204"), 1.5))], canon, classOf, 10000, 15000);
    expect(atScale).toMatchObject({ factor: 1.5, method: "scale", symbolScale: 1, rawMedian: null });
    expect(detectDocumentFactor([src("999.0", "x", canonical("ISOM2017-2:204"))], canon, classOf, 10000, 15000)).toMatchObject({ factor: 1.5, method: "scale" });
    // Spec-code symbols that only fit at ×1 (a 1:10000 map drawn with 1:15000 dimensions) override the scale.
    const unenlarged = detectDocumentFactor([src("204.0", "Sten", canonical("ISOM2017-2:204"))], canon, classOf, 10000, 15000);
    expect(unenlarged).toMatchObject({ factor: 1, method: "codes", scaleFactor: 1.5, symbolScale: 0.667, rawMedian: null });
    expect(detectDocumentFactor([], canon, classOf, 10000, 15000, 1)).toMatchObject({ factor: 1, method: "override", symbolScale: 0.667 });
  });

  it("matches an enlarged table at the detected factor and flags a lone outlier as a scale anomaly", () => {
    const enlarged = matchContext("ISOM2017-2", "iof2024", 1.5, classOf);
    expect(matchSymbol(src("101.0", "Höjdkurva", scaleRenderSymbol(canonical("ISOM2017-2:101"), 1.5)), enlarged).match.state).toBe("auto");
    const outlier = matchSymbol(src("104.0", "Skärning", canonical("ISOM2017-2:104")), enlarged);
    expect(outlier.match.state).not.toBe("auto");
    expect(outlier.scaleAnomaly).toEqual({ factor: 1, canonicalId: "ISOM2017-2:104" });
  });
});

describe("descriptionTokens", () => {
  it("maps Swedish map vocabulary onto the library's English words and drops stopwords", () => {
    expect([...descriptionTokens("Opasserbar brant (utan taggar)")]).toEqual(expect.arrayContaining(["cliff"]));
    expect([...descriptionTokens("Liten stig")]).toEqual(["footpath"]);
    expect(descriptionTokens("Tydligt människoframställt föremål")).toEqual(new Set(["prominent", "man", "made", "feature"]));
    expect(descriptionTokens("Kontroll")).toEqual(new Set(["control"]));
  });
});

describe("remapRenderColours", () => {
  it("is what the matcher's output is drawn through", () => {
    const sym = canonical("ISOM2017-2:502");
    const map = stack.map((_, i) => i + 10);
    const remapped = remapRenderColours(sym, map) as LineSymbol;
    expect(remapped.borders!.left!.colour).toBe((sym as LineSymbol).borders!.left!.colour + 10);
    expect(() => remapRenderColours(sym, [])).toThrow();
  });
});
