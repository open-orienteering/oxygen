/**
 * Symbol materialisation and the Map mode palette (docs/map-symbols.md §11).
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OVERLAY_STACK_IDS, paletteIndexOfStack } from "../../import/colour-align.js";
import { input } from "../../import/__tests__/match-fixture.js";
import { matchDocument } from "../../import/match-document.js";
import { readOmap } from "../../import/omap-reader.js";
import { omapToDocumentInput } from "../../import/omap-source.js";
import type { LineSymbol } from "../../render/symbol.js";
import { renderColourRefs } from "../../render/transform.js";
import { getLibraryEntry, libraryFactor, listSymbolLibraries } from "../../symbol-library/index.js";
import { colourRefs } from "../../symbol-library/schema.js";
import { decodeMapDocument, encodeMapDocument, type MapDocument, type MapDocumentInput } from "../codec.js";
import { type DocumentColour, type MapDocumentHeader, OBJECT_TYPE } from "../header.js";
import { compareSymbolCodes, mapPalette, materialiseFactor, materialiseSymbol, type PaletteGroup, type PaletteItem } from "../materialise.js";
import { applyPatch, mapPatchSchema, mergePatch, patchSymbolSchema, type MapPatch, type PatchOp, type PatchSymbol } from "../patch.js";
import { canonicalEntryRender, canonicalRender, documentRenderInput } from "../render-bridge.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../../..");

const decode = (i: MapDocumentInput): MapDocument => decodeMapDocument(encodeMapDocument(i));
const omapDoc = (path: string, name: string): MapDocument => {
  const { input: raw } = omapToDocumentInput(readOmap(readFileSync(resolve(ROOT, path), "utf8")), { fileName: name, fileHash: "ab".repeat(32), fileBytes: 1 });
  return decode(matchDocument(raw).input);
};

/**
 * Since G21 every aligned stack carries the overlay rows (`OVERLAY_STACK_IDS`). `withSki(i, keep)` keeps
 * only the `keep` ones: the other overlay ids are taken off the rows alignment inserted (no
 * `sourceNumber`), which is what a document stored before G21 looks like to the palette index.
 */
const withSki = (i: MapDocumentInput, keep: readonly string[] = OVERLAY_STACK_IDS): MapDocumentInput => ({
  ...i,
  header: {
    ...i.header,
    colours: (i.header.colours as DocumentColour[]).map((c) =>
      c.sourceNumber === undefined && c.paletteIds ? { ...c, paletteIds: c.paletteIds.filter((id) => !(OVERLAY_STACK_IDS as readonly string[]).includes(id) || keep.includes(id)) } : c,
    ),
  },
});

/** The small fixture as stored before G21: no ski rows. */
const small = decode(withSki(matchDocument(input()).input, []));
const enlarged = decode(matchDocument(input({ factor: 1.5 })).input);
const sprint = decode(matchDocument(input(), { library: "ISSprOM2019-2" }).input);
const smallSki = decode(withSki(matchDocument(input()).input));
const xmap = omapDoc("e2e/test.xmap", "test.xmap");
const puit = omapDoc("docs/screenshots/fixtures/puit-de-laven.omap", "puit-de-laven.omap");

const FIXTURES: [string, MapDocument][] = [
  ["small", small],
  ["small ×1.5", enlarged],
  ["sprint", sprint],
  ["small, G21 stack", smallSki],
  ["test.xmap", xmap],
  ["puit-de-laven", puit],
];
const ALL_ENTRIES = listSymbolLibraries().flatMap((l) => l.entries);

const ok = (doc: Pick<MapDocument, "header">, id: string): { key: string; symbol: PatchSymbol; factor: number } => {
  const r = materialiseSymbol(doc, id);
  if (!r.ok) throw new Error(`${id}: ${JSON.stringify(r)}`);
  return r;
};

describe("materialiseSymbol", () => {
  it.each(FIXTURES)("every entry of every library materialises on %s or reports exactly the missing colours", (_name, doc) => {
    const index = paletteIndexOfStack(doc.header.colours);
    let materialised = 0;
    for (const entry of ALL_ENTRIES) {
      const r = materialiseSymbol(doc, entry.id);
      const expectedMissing = [...colourRefs(entry.render)].filter((id) => !index.has(id)).sort();
      if (expectedMissing.length > 0) {
        expect(r, entry.id).toEqual({ ok: false, reason: "missing-colours", missing: expectedMissing });
        continue;
      }
      if (!r.ok) throw new Error(`${entry.id}: ${JSON.stringify(r)}`);
      materialised++;
      expect(r.key).toBe(entry.id);
      expect(r.symbol).toEqual(patchSymbolSchema.parse(r.symbol));
      expect(r.symbol).not.toHaveProperty("match");
      expect(r.symbol).not.toHaveProperty("sourceIndex");
      expect(r.symbol).toMatchObject({ code: entry.code, name: entry.name.en, kind: r.symbol.render.type, origin: "source", hidden: false });
      expect(r.symbol.render.id).toBe(entry.id);
      for (const c of renderColourRefs(r.symbol.render)) expect(c, entry.id).toBeLessThan(doc.header.colours.length);
    }
    expect(materialised).toBeGreaterThan(0);
  });

  it("named cases: a black boulder everywhere, blue water missing on the small stack, a real map nearly complete", () => {
    for (const [, doc] of FIXTURES) expect(materialiseSymbol(doc, "ISOM2017-2:204").ok).toBe(true);
    const water = materialiseSymbol(small, "ISOM2017-2:301");
    expect(water.ok).toBe(false);
    expect(!water.ok && water.reason === "missing-colours" && water.missing).toContain("blue100-area");
    const isom = ALL_ENTRIES.filter((e) => e.id.startsWith("ISOM2017-2:"));
    expect(isom.filter((e) => materialiseSymbol(puit, e.id).ok).length).toBeGreaterThan(isom.length - 5);
  });

  it("an unknown id is a result, never a throw", () => {
    for (const id of ["ISOM2017-2:999", "ISOM2017-2", "nope", "", "ISSkiOM2019:", "constructor:101", "ISOM2017-2:302.z"]) {
      expect(materialiseSymbol(small, id)).toEqual({ ok: false, reason: "unknown-entry" });
    }
  });

  it("an own-library entry draws exactly as a document symbol auto-matched to it (canonicalRender)", () => {
    for (const doc of [small, enlarged]) {
      for (const s of doc.header.symbols) {
        if (s.match?.state !== "auto" || !s.match.canonicalId) continue;
        const r = ok(doc, s.match.canonicalId);
        expect(r.factor).toBe(doc.header.documentFactor);
        const c = canonicalRender(doc, s)!;
        expect(r.symbol.render).toEqual(s.render?.type === "text" ? r.symbol.render : c);
      }
    }
    expect(small.header.symbols.some((s) => s.match?.state === "auto")).toBe(true);
  });

  it("same input, same bytes; the parse round trip is the identity", () => {
    for (const entry of ALL_ENTRIES) {
      const a = materialiseSymbol(puit, entry.id);
      const b = materialiseSymbol(puit, entry.id);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      if (a.ok) expect(JSON.stringify(patchSymbolSchema.parse(JSON.parse(JSON.stringify(a.symbol))))).toBe(JSON.stringify(a.symbol));
    }
    // A decoded copy of the same document (another device) gives the same bytes.
    const again = omapDoc("docs/screenshots/fixtures/puit-de-laven.omap", "renamed.omap");
    expect(JSON.stringify(materialiseSymbol(again, "ISOM2017-2:506"))).toBe(JSON.stringify(materialiseSymbol(puit, "ISOM2017-2:506")));
  });

  it("never changes the colour stack", () => {
    const before = JSON.stringify(small.header.colours);
    for (const entry of ALL_ENTRIES) materialiseSymbol(small, entry.id);
    expect(JSON.stringify(small.header.colours)).toBe(before);
  });

  describe("an ISSkiOM entry", () => {
    it("is not materialisable on a stack without green-skio and names the missing rows", () => {
      expect(materialiseSymbol(small, "ISSkiOM2019:801.1")).toEqual({ ok: false, reason: "missing-colours", missing: ["green-skio", "white-skio"] });
      // Imported today (G21), every stack has the ski rows: the same entries materialise on a real map.
      expect(materialiseSymbol(xmap, "ISSkiOM2019:801.1").ok).toBe(true);
      expect(materialiseSymbol(xmap, "ISSkiOM2019:808").ok).toBe(true);
    });

    it("materialises on a stack with the ski rows; a compulsory state needs orange-skio too", () => {
      const r = ok(smallSki, "ISSkiOM2019:801.1");
      expect(r.symbol.kind).toBe("line");
      const greenOnly = decode(withSki(matchDocument(input()).input, ["green-skio", "white-skio"]));
      // Colour indices follow the stack; the drawing is the same.
      expect((ok(greenOnly, "ISSkiOM2019:801.1").symbol.render as LineSymbol).main).toMatchObject({ widthUm: (r.symbol.render as LineSymbol).main!.widthUm });
      expect(materialiseSymbol(greenOnly, "ISSkiOM2019:801.2")).toEqual({ ok: false, reason: "missing-colours", missing: ["orange-skio"] });
      expect(ok(smallSki, "ISSkiOM2019:801.2").symbol.render.type).toBe("line");
    });
  });

  describe("the factor (map-symbols §11.1, §12.2)", () => {
    /** A real ISOM stack (blue rows for 301.x / 310.1, the ski rows since G21). */
    const skiStack = puit.header.colours;
    const header = (h: Partial<MapDocumentHeader>): Pick<MapDocument, "header"> => ({ header: { ...puit.header, colours: skiStack, ...h } });
    const width = (doc: Pick<MapDocument, "header">, id: string) => (ok(doc, id).symbol.render as LineSymbol).main!.widthUm;
    const index = paletteIndexOfStack(skiStack);

    it("an ISOM map at 1:10 000 drawn at its enlargement (symbolScale 1): tracks ×1, other ski symbols ×1.5", () => {
      const doc = header({ mapScale: 10000, documentFactor: 1.5 });
      expect(ok(doc, "ISSkiOM2019:801.1").factor).toBe(1);
      expect(width(doc, "ISSkiOM2019:801.1")).toBe(850);
      const entry = getLibraryEntry("ISSkiOM2019:301.2")!;
      expect(ok(doc, entry.id).factor).toBe(1.5);
      expect(ok(doc, entry.id).symbol.render).toEqual(canonicalEntryRender(entry, index, 1.5));
      expect(ok(doc, "ISOM2017-2:505").factor).toBe(1.5);
    });

    it("an ISOM map at 1:10 000 left at 1:15 000 dimensions (symbolScale ⅔) scales the overlay by ⅔ as well", () => {
      const doc = header({ mapScale: 10000, documentFactor: 1 });
      expect(ok(doc, "ISSkiOM2019:801.1").factor).toBeCloseTo(2 / 3, 12);
      expect(ok(doc, "ISSkiOM2019:801.1").symbol.render).toEqual(canonicalEntryRender(getLibraryEntry("ISSkiOM2019:801.1")!, index, 1 / 1.5));
      expect(width(doc, "ISSkiOM2019:801.1")).toBeCloseTo((850 * 2) / 3, 0);
      expect(ok(doc, "ISSkiOM2019:310.1").factor).toBeCloseTo(1, 12);
      expect(ok(doc, "ISOM2017-2:505").factor).toBe(1);
    });

    it("1:7 500 and 1:5 000 take the track column's own rows", () => {
      expect(ok(header({ mapScale: 7500, documentFactor: 2 }), "ISSkiOM2019:803.1").factor).toBeCloseTo(1.33, 12);
      expect(ok(header({ mapScale: 7500, documentFactor: 2 }), "ISSkiOM2019:301.1").factor).toBeCloseTo(1.5, 12);
      expect(ok(header({ mapScale: 5000, documentFactor: 3 }), "ISSkiOM2019:813.2").factor).toBeCloseTo(1.5, 12);
    });

    it("an entry of the other base library: its own library factor × symbolScale", () => {
      const doc = header({ mapScale: 10000, documentFactor: 1.2 });
      const symbolScale = 1.2 / libraryFactor("ISOM2017-2", 10000);
      expect(ok(doc, "ISSprOM2019-2:529").factor).toBeCloseTo((4000 / 10000) * symbolScale, 12);
      expect(materialiseFactor(doc.header, getLibraryEntry("ISSprOM2019-2:529")!)).toBe(libraryFactor("ISSprOM2019-2", 10000, "529") * symbolScale);
      // And the reverse on the sprint document.
      expect(ok(sprint, "ISOM2017-2:204").factor).toBeCloseTo((15000 / sprint.header.mapScale) * (sprint.header.documentFactor / libraryFactor("ISSprOM2019-2", sprint.header.mapScale)), 12);
    });

    it("a document never matched (library null) takes every library's own factor", () => {
      const doc = header({ library: null, mapScale: 10000, documentFactor: 1 });
      expect(ok(doc, "ISOM2017-2:505").factor).toBe(1.5);
      expect(ok(doc, "ISSkiOM2019:801.1").factor).toBe(1);
      expect(ok(doc, "ISSkiOM2019:301.1").factor).toBe(1.5);
    });
  });

  it("put in a patch and referenced by an add op, it applies and is drawn from its own render", () => {
    const doc = smallSki;
    const r = ok(doc, "ISSkiOM2019:803.2");
    const empty = mapPatchSchema.parse({ documentHash: "cd".repeat(32) });
    const add: PatchOp = { op: "add", id: "00000000-0000-4000-8000-000000000001", type: OBJECT_TYPE.line, symbol: { patch: r.key }, coords: [[0, 0], [5000, 0]] };
    const patch = mergePatch(empty, { put: [add], putSymbols: { [r.key]: r.symbol } });
    const { document, issues } = applyPatch(doc, patch);
    expect(issues).toEqual([]);
    const ri = documentRenderInput(document);
    const k = ri.docIdx.indexOf(doc.header.objects.count);
    expect(k).toBeGreaterThanOrEqual(0);
    expect(ri.symbols[ri.objects[k].symbolIdx]).toEqual(r.symbol.render);
  });
});

// ---- the palette ------------------------------------------------------------

/** The small fixture plus a hidden symbol, a text symbol, an unused one, a 7xx of the mapper's own. */
function paletteInput(ski = false): MapDocumentInput {
  const base = matchDocument(input()).input;
  const black = base.header.colours.findIndex((c) => (c as DocumentColour).paletteIds?.includes("black100"));
  const extra = [
    { code: "999.0", name: "Hidden helper", kind: "line" as const, hidden: true, render: { type: "line" as const, id: "s:999", code: "999", name: "h", main: { colour: black, widthUm: 100 } } },
    { code: "821.0", name: "Ortnamn", kind: "text" as const, render: { type: "text" as const, id: "s:821", code: "821", name: "t", fontFamily: "liberation-sans" as const, fontSizeUm: 4000, colour: black } },
    { code: "529.0", name: "Oanvänd väg", kind: "line" as const, render: { type: "line" as const, id: "s:529", code: "529", name: "u", main: { colour: black, widthUm: 200 } } },
    { code: "703.0", name: "Egen kontroll", kind: "point" as const, render: { type: "point" as const, id: "s:703", code: "703", name: "c", glyph: { rotatable: false, parts: [{ kind: "disc" as const, colour: black, diameterUm: 300 }] } } },
  ];
  const i = { ...base, header: { ...base.header, symbols: [...base.header.symbols, ...extra] } };
  return withSki(i, ski ? OVERLAY_STACK_IDS : []);
}

const flat = (groups: PaletteGroup[]): (PaletteItem & { group: string; heading: string })[] =>
  groups.flatMap((g) => g.headings.flatMap((h) => h.entries.map((e) => ({ ...e, group: g.id, heading: h.code }))));

describe("mapPalette", () => {
  const doc = decode(paletteInput());
  const docSki = decode(paletteInput(true));
  const groups = mapPalette(doc);
  const items = flat(groups);
  const symbolIdx = (code: string) => doc.header.symbols.findIndex((s) => s.code === code);

  it("groups: the document's library, then the ski overlay when the stack has green-skio, then other", () => {
    expect(groups.map((g) => [g.id, g.library])).toEqual([["library", "ISOM2017-2"], ["other", null]]);
    expect(mapPalette(docSki).map((g) => [g.id, g.library])).toEqual([["library", "ISOM2017-2"], ["ISSkiOM2019", "ISSkiOM2019"], ["other", null]]);
    // Imported today (G21), a real map has the ski rows and so the group.
    expect(mapPalette(xmap).some((g) => g.id === "ISSkiOM2019")).toBe(true);
  });

  it("headings in code order, each non-empty, with the library heading's names and a search text", () => {
    for (const g of [...groups, ...mapPalette(docSki), ...mapPalette(puit)]) {
      const codes = g.headings.map((h) => h.code);
      const numeric = codes.filter((c) => Number.isFinite(Number(c))).map(Number);
      expect(numeric).toEqual([...numeric].sort((a, b) => a - b));
      for (const h of g.headings) expect(h.entries.length).toBeGreaterThan(0);
    }
    const h302 = groups[0].headings.find((h) => h.code === "302")!;
    expect(h302.name.en).toBe(getLibraryEntry("ISOM2017-2:302")!.name.en);
    expect(h302.name.sv).toBe(getLibraryEntry("ISOM2017-2:302")!.name.sv);
    expect(h302.search).toContain("302");
    expect(h302.search).toContain(getLibraryEntry("ISOM2017-2:302.b")!.name.en.toLowerCase());
  });

  it("a heading's variants sit under it, heading entry first", () => {
    const h = groups[0].headings.find((x) => x.code === "302")!;
    const ids = h.entries.map((e) => e.canonicalId);
    expect(ids[0]).toBe("ISOM2017-2:302");
    expect(ids).toEqual(expect.arrayContaining(["ISOM2017-2:302.b", "ISOM2017-2:302.c"]));
  });

  it("document items: applied matches by their entry's heading, the rest by the source code's base, unused included", () => {
    const contour = items.find((e) => e.source === "document" && e.code === "101.0")!;
    expect(contour).toMatchObject({ group: "library", heading: "101", ref: { doc: symbolIdx("101.0") }, canonicalId: "ISOM2017-2:101", objects: 2, enabled: true, kind: "line" });
    // 527.0's match is only suggested: drawn from source, under its own heading.
    expect(items.find((e) => e.code === "527.0")).toMatchObject({ group: "library", heading: "527", canonicalId: null });
    expect(items.find((e) => e.code === "521.3")).toMatchObject({ group: "library", heading: "521", canonicalId: null, objects: 2 });
    expect(items.find((e) => e.code === "900.0")).toMatchObject({ group: "other", heading: "900", canonicalId: null });
    expect(items.find((e) => e.code === "529.0")).toMatchObject({ group: "library", heading: "529", objects: 0, enabled: true });
    // The mapper's own 7xx stays.
    expect(items.find((e) => e.code === "703.0")).toMatchObject({ source: "document", heading: "703" });
  });

  it("leaves out hidden, graphic, text and proxy-drawn document symbols", () => {
    const codes = items.filter((e) => e.source === "document").map((e) => e.code);
    for (const code of ["999.0", "821.0", "401.0", "graphic"]) expect(codes).not.toContain(code);
  });

  it("library items: point, line and area entries the document lacks, no 7xx course symbols, no text", () => {
    const lib = items.filter((e) => e.source === "library");
    expect(lib.length).toBeGreaterThan(100);
    for (const e of lib) {
      expect(e.ref).toEqual({ patch: e.canonicalId });
      expect(e.code).not.toMatch(/^7/);
      expect(e.canonicalId!.startsWith("ISOM2017-2:")).toBe(true);
      expect(["point", "line", "area"]).toContain(e.kind);
    }
    expect(lib.map((e) => e.canonicalId)).not.toContain("ISOM2017-2:603.b");
    // An entry an applied match already covers is not repeated.
    expect(lib.map((e) => e.canonicalId)).not.toContain("ISOM2017-2:101");
    expect(groups[0].headings.find((h) => h.code === "101")!.entries[0].source).toBe("document");
    // The other base library is not offered.
    expect(items.some((e) => e.canonicalId?.startsWith("ISSprOM2019-2:"))).toBe(false);
  });

  it("a library item the stack cannot draw is disabled with its missing colours", () => {
    const water = items.find((e) => e.canonicalId === "ISOM2017-2:301")!;
    expect(water.enabled).toBe(false);
    expect(water.missing).toEqual(materialiseSymbol(doc, "ISOM2017-2:301").ok ? [] : (materialiseSymbol(doc, "ISOM2017-2:301") as { missing: string[] }).missing);
    const boulder = items.find((e) => e.code === "204.0")!;
    expect(boulder).toMatchObject({ source: "document", enabled: true });
    for (const e of items) expect(e.enabled).toBe(e.missing === undefined);
  });

  it("the ski overlay group lists every ISSkiOM entry, compulsory states disabled without orange-skio", () => {
    const ski = mapPalette(docSki).find((g) => g.id === "ISSkiOM2019")!;
    const ids = flat([ski]).map((e) => e.canonicalId);
    expect(ids.sort()).toEqual(listSymbolLibraries().find((l) => l.id === "ISSkiOM2019")!.entries.map((e) => e.id).sort());
    // The small stack has no blue and no green 100 %: the water / marsh variants and 808 are disabled, every track line is drawable.
    for (const e of flat([ski])) expect(e.enabled, e.canonicalId!).toBe(materialiseSymbol(docSki, e.canonicalId!).ok);
    for (const e of flat([ski])) if (/^8(0[1-47]|13)/.test(e.code)) expect(e.enabled, e.canonicalId!).toBe(true);
    const noOrange = mapPalette(decode(withSki(paletteInput(true), ["green-skio", "white-skio"]))).find((g) => g.id === "ISSkiOM2019")!;
    expect(flat([noOrange]).find((e) => e.canonicalId === "ISSkiOM2019:801.2")).toMatchObject({ enabled: false, missing: ["orange-skio"] });
    expect(flat([noOrange]).find((e) => e.canonicalId === "ISSkiOM2019:801.1")).toMatchObject({ enabled: true });
  });

  describe("with a patch", () => {
    const r = ok(docSki, "ISSkiOM2019:802.1");
    const r206 = ok(docSki, "ISOM2017-2:206");
    const foreign = { ...ok(docSki, "ISOM2017-2:204").symbol, code: "850", name: "Klubbsymbol" };
    const patch: MapPatch = mapPatchSchema.parse({ documentHash: "cd".repeat(32), symbols: { [r206.key]: r206.symbol, [r.key]: r.symbol, "club:850": foreign } });
    const withPatch = flat(mapPalette(docSki, patch));

    it("lists every patch symbol as { patch: key }, referenced or not, instead of its library entry", () => {
      expect(withPatch.filter((e) => e.canonicalId === "ISOM2017-2:206").map((e) => e.source)).toEqual(["patch"]);
      expect(withPatch.find((e) => e.canonicalId === "ISOM2017-2:206")).toMatchObject({ ref: { patch: "ISOM2017-2:206" }, group: "library", heading: "206", enabled: true });
      expect(withPatch.find((e) => e.canonicalId === "ISSkiOM2019:802.1")).toMatchObject({ source: "patch", group: "ISSkiOM2019" });
      expect(withPatch.find((e) => e.ref && "patch" in e.ref && e.ref.patch === "club:850")).toMatchObject({ group: "other", heading: "850", canonicalId: null });
    });

    it("keeps the overlay group for a ski patch symbol even when the stack lacks green-skio", () => {
      const plain = flat(mapPalette(doc, mapPatchSchema.parse({ documentHash: "cd".repeat(32), symbols: { [r.key]: r.symbol } })));
      expect(plain.filter((e) => e.group === "ISSkiOM2019").map((e) => e.source)).toEqual(["patch"]);
    });

    it("every enabled item's ref passes applyPatch's symbol and kind checks for an add of its kind", () => {
      const all = flat(mapPalette(docSki, patch)).filter((e) => e.enabled);
      const putSymbols: Record<string, PatchSymbol> = {};
      const put: PatchOp[] = [];
      const type = { point: OBJECT_TYPE.point, line: OBJECT_TYPE.line, area: OBJECT_TYPE.area } as const;
      const coords = { point: [[0, 0]], line: [[0, 0], [100, 0]], area: [[0, 0], [100, 0], [100, 100]] } as const;
      all.forEach((e, k) => {
        if (e.source === "library") putSymbols[e.canonicalId!] = ok(docSki, e.canonicalId!).symbol;
        const id = `00000000-0000-4000-8000-${String(k).padStart(12, "0")}`;
        put.push({ op: "add", id, type: type[e.kind], symbol: e.ref, coords: coords[e.kind].map((c) => [...c] as [number, number]) });
      });
      const { issues } = applyPatch(docSki, mergePatch(patch, { put, putSymbols }));
      expect(issues).toEqual([]);
      expect(put.length).toBe(all.length);
    });
  });

  it("orders a heading's items: applied matches, then more objects, then index; patch items by key; library items last", () => {
    // Three source symbols under heading 529: an applied match with no objects, an unmatched one with two, an unmatched one with one.
    const base = paletteInput();
    const black = base.header.colours.findIndex((c) => (c as DocumentColour).paletteIds?.includes("black100"));
    const line = (code: string) => ({ code, name: code, kind: "line" as const, render: { type: "line" as const, id: `s:${code}`, code, name: code, main: { colour: black, widthUm: 150 } } });
    const matched = { ...line("529.5"), match: { canonicalId: "ISOM2017-2:529", method: "explicit" as const, state: "auto" as const, confidence: 1, reasons: [], reviewed: false, libraryVersion: "x" } };
    const symbols = [...base.header.symbols, line("529.1"), line("529.2"), matched];
    const n = base.header.symbols.length;
    const objects = [...base.objects, ...[n, n, n + 1].map((symbolIdx, k) => ({ symbolIdx, type: OBJECT_TYPE.line, sourceIndex: 100 + k, coords: [0, 0, 10, 10], flags: [0, 0] }))];
    const d = decode({ ...base, header: { ...base.header, symbols: symbols.filter((s) => s.code !== "529.0") }, objects: objects.map((o) => ({ ...o, symbolIdx: o.symbolIdx > symbols.findIndex((s) => s.code === "529.0") ? o.symbolIdx - 1 : o.symbolIdx })) });
    const idx = (code: string) => d.header.symbols.findIndex((s) => s.code === code);
    const sym = ok(d, "ISOM2017-2:206").symbol;
    const p = mapPatchSchema.parse({ documentHash: "cd".repeat(32), symbols: { "club:529.9": { ...sym, kind: "line", code: "529.9", render: ok(d, "ISOM2017-2:505").symbol.render }, "club:529.8": { ...sym, kind: "line", code: "529.8", render: ok(d, "ISOM2017-2:505").symbol.render } } });
    const h529 = mapPalette(d, p).find((g) => g.id === "library")!.headings.find((h) => h.code === "529")!;
    expect(h529.entries.filter((e) => e.source === "document").map((e) => e.ref)).toEqual([{ doc: idx("529.5") }, { doc: idx("529.1") }, { doc: idx("529.2") }]);
    // Patch symbols whose key is no library entry go to "other" by their code's base; here they share heading 529 there, in key order.
    const other529 = mapPalette(d, p).find((g) => g.id === "other")!.headings.find((h) => h.code === "529")!;
    expect(other529.entries.map((e) => e.ref)).toEqual([{ patch: "club:529.8" }, { patch: "club:529.9" }]);
    // A library-keyed patch item sits after document items and before library items.
    const target = mapPalette(puit).find((g) => g.id === "library")!.headings.find((h) => h.entries.filter((e) => e.source === "library" && e.enabled).length >= 2)!;
    const key = target.entries.filter((e) => e.source === "library").at(-1)!.canonicalId!;
    const p2 = mapPatchSchema.parse({ documentHash: "cd".repeat(32), symbols: { [key]: ok(puit, key).symbol } });
    const sources = mapPalette(puit, p2).find((g) => g.id === "library")!.headings.find((h) => h.code === target.code)!.entries.map((e) => e.source);
    expect(sources.filter((x) => x === "patch")).toHaveLength(1);
    if (sources.includes("document")) expect(sources.indexOf("patch")).toBeGreaterThan(sources.lastIndexOf("document"));
    expect(sources.indexOf("patch")).toBeLessThan(sources.indexOf("library"));
  });

  it("compareSymbolCodes: numeric by value, numeric before non-numeric, else by string", () => {
    expect(["graphic", "529", "101.1", "frame", "101", "99.5"].sort(compareSymbolCodes)).toEqual(["99.5", "101", "101.1", "529", "frame", "graphic"]);
  });

  it("refuses an effective document (its appended patch symbols are no { doc } refs)", () => {
    const r = ok(doc, "ISOM2017-2:204");
    const p = mergePatch(mapPatchSchema.parse({ documentHash: "cd".repeat(32) }), {
      putSymbols: { [r.key]: r.symbol },
      put: [{ op: "add", id: "00000000-0000-4000-8000-000000000009", type: OBJECT_TYPE.point, symbol: { patch: r.key }, coords: [[0, 0]] }],
    });
    expect(() => mapPalette(applyPatch(doc, p).document)).toThrow(/pinned document/);
  });

  it("is deterministic and does not change the document's stack", () => {
    const before = JSON.stringify(docSki.header.colours);
    expect(JSON.stringify(mapPalette(docSki))).toBe(JSON.stringify(mapPalette(docSki)));
    expect(JSON.stringify(docSki.header.colours)).toBe(before);
  });

  it("a sprint document's palette is ISSprOM's", () => {
    const g = mapPalette(sprint);
    expect(g[0]).toMatchObject({ id: "library", library: "ISSprOM2019-2" });
    expect(flat(g).filter((e) => e.source === "library" && e.group === "library").every((e) => e.canonicalId!.startsWith("ISSprOM2019-2:"))).toBe(true);
    expect(flat(g).filter((e) => e.source === "library").every((e) => /^(ISSprOM2019-2|ISSkiOM2019):/.test(e.canonicalId!))).toBe(true);
  });
});
