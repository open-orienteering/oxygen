/**
 * Swedish names and older-spec aliases (docs/map-symbols.md §3, §3.2, §5).
 * The spot tables are typed by hand from the sources — SOFT's Swedish
 * translations for names, the IOF's "What has changed from ISOM 2000?"
 * for aliases — not derived from the entries' tables.
 */

import { describe, expect, it } from "vitest";
import { ALIAS_LIBRARIES, type SymbolLibraryId, getLibraryEntry, getSymbolLibrary, listSymbolLibraries, symbolLibraryInputs, symbolLibrarySchema, validateLibrary } from "../index.js";
import { withNamesAndAliases } from "../authoring.js";

/** Headings the Swedish translation does not carry (§3.2). */
const SV_UNSOURCED: Record<SymbolLibraryId, string[]> = {
  "ISOM2017-2": [],
  "ISSprOM2019-2": ["105.2", "533", "715"],
};

const SV_SPOT: Record<string, string> = {
  // ISOM 2017-2 svensk översättning revision 6
  "ISOM2017-2:101": "Höjdkurva",
  "ISOM2017-2:104": "Skärning",
  "ISOM2017-2:112": "Liten grop med branta sidor",
  "ISOM2017-2:206": "Gigantisk sten eller stenpelare",
  "ISOM2017-2:311": "Brunn, fontän eller vattentank",
  "ISOM2017-2:403": "Öppen mark med normal löpbarhet",
  "ISOM2017-2:407": "Undervegetation, löphindrande, god sikt",
  "ISOM2017-2:508": "Rågång, drivningsväg eller annan smal öppning",
  "ISOM2017-2:513.2": "Stödmur/terrass",
  "ISOM2017-2:530": "Tydligt människoframställt föremål - ring",
  "ISOM2017-2:703": "Kontroller",
  "ISOM2017-2:708": "Gräns förbjuden att passera",
  "ISOM2017-2:715": "Startpunkt efter kartbyte",
  // ISSprOM 2019-2 svensk översättning revision 5
  "ISSprOM2019-2:105.1": "Liten jordvall",
  "ISSprOM2019-2:302": "Passerbar vattenyta",
  "ISSprOM2019-2:410": "Vegetation, mycket svårframkomlig",
  "ISSprOM2019-2:501.2": "Steg eller kant av belagd yta på lägre nivån",
  "ISSprOM2019-2:512.3": "Område passerbart på två nivåer",
  "ISSprOM2019-2:526": "Röse, minnessten, litet monument eller gränssten",
  "ISSprOM2019-2:531": "Övrigt tydligt människoframställt föremål - x",
  "ISSprOM2019-2:703": "Kontrollpunkt",
  "ISSprOM2019-2:708": "Gräns förbjuden att passera",
  "ISSprOM2019-2:714": "Tillfällig konstruktion eller avstängd yta",
};

/** ISOM 2000 → ISOM 2017 pairs the IOF change document states outright. */
const ALIAS_SPOT: Record<string, string> = {
  "ISOM2017-2:103": "103",
  "ISOM2017-2:104": "106",
  "ISOM2017-2:105.1": "107",
  "ISOM2017-2:106": "108",
  "ISOM2017-2:108": "110",
  "ISOM2017-2:111": "115",
  "ISOM2017-2:112": "116",
  "ISOM2017-2:115": "118",
  "ISOM2017-2:202": "203",
  "ISOM2017-2:214": "212",
  "ISOM2017-2:304": "305",
  "ISOM2017-2:311": "312",
  "ISOM2017-2:417": "419",
  "ISOM2017-2:513.1": "519",
  "ISOM2017-2:518": "524",
  "ISOM2017-2:529": "534",
  "ISOM2017-2:703": "702",
  "ISOM2017-2:711": "711",
};

/** Old symbols the IOF document says were removed, absorbed or replaced by another symbol: never an alias. */
const NOT_ALIASED_ISOM2000 = ["104", "105", "202", "302", "304", "314", "411", "501", "502", "510", "511", "512", "513", "514", "527", "531", "532", "710"];

describe("Swedish names (§3)", () => {
  it.each(Object.keys(SV_UNSOURCED) as SymbolLibraryId[])("%s: every heading has name.sv except the listed unsourced ones", (id) => {
    const missing = getSymbolLibrary(id).entries.filter((e) => e.variant === null && !e.name.sv).map((e) => e.code);
    expect(missing).toEqual(SV_UNSOURCED[id]);
  });

  it("spot table matches the SOFT headings verbatim", () => {
    for (const [entryId, sv] of Object.entries(SV_SPOT)) expect(getLibraryEntry(entryId)?.name.sv, entryId).toBe(sv);
  });

  it("a variant's name is its heading's Swedish name plus Oxygen's qualifier", () => {
    for (const lib of listSymbolLibraries()) {
      for (const e of lib.entries.filter((x) => x.variant !== null)) {
        const heading = lib.entries.find((h) => h.code === e.code && h.variant === null);
        if (!heading?.name.sv) {
          expect(e.name.sv, `${e.id}: heading has no sv`).toBeUndefined();
          continue;
        }
        expect(e.name.sv, e.id).toMatch(new RegExp(`^${heading.name.sv.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}, \\S`));
      }
    }
  });

  it("every variant of a sourced heading has a name", () => {
    for (const lib of listSymbolLibraries()) {
      const unnamed = lib.entries.filter((e) => e.variant !== null && !e.name.sv && !SV_UNSOURCED[lib.id as SymbolLibraryId].includes(e.code));
      expect(unnamed.map((e) => e.id)).toEqual([]);
    }
  });
});

describe("aliases (§3)", () => {
  it("only ISOM 2000 aliases on ISOM 2017-2 headings; ISSprOM 2019-2 has none yet", () => {
    for (const e of getSymbolLibrary("ISOM2017-2").entries) {
      for (const a of e.aliases) expect(a.library, e.id).toBe("ISOM2000");
      if (e.variant !== null) expect(e.aliases, e.id).toEqual([]);
    }
    expect(getSymbolLibrary("ISSprOM2019-2").entries.flatMap((e) => e.aliases)).toEqual([]);
  });

  it("spot table: the pairs the IOF change document states", () => {
    for (const [entryId, code] of Object.entries(ALIAS_SPOT)) {
      expect(getLibraryEntry(entryId)?.aliases, entryId).toContainEqual({ library: "ISOM2000", code });
    }
  });

  it("no alias for an old symbol the IOF document says was removed or absorbed", () => {
    const used = new Set(getSymbolLibrary("ISOM2017-2").entries.flatMap((e) => e.aliases.map((a) => a.code)));
    expect(NOT_ALIASED_ISOM2000.filter((c) => used.has(c))).toEqual([]);
  });

  it("an old code names at most one heading", () => {
    const owners = new Map<string, string[]>();
    for (const e of getSymbolLibrary("ISOM2017-2").entries) for (const a of e.aliases) owners.set(a.code, [...(owners.get(a.code) ?? []), e.id]);
    expect([...owners].filter(([, ids]) => ids.length > 1)).toEqual([]);
  });

  it("the accepted alias libraries are ISOM 2000 and ISSOM 2007", () => {
    expect(ALIAS_LIBRARIES).toEqual(["ISOM2000", "ISSOM2007"]);
  });
});

describe("validateLibrary — names and aliases (§5)", () => {
  it("reports alias and variant-name mistakes", () => {
    const base = symbolLibrarySchema.parse(symbolLibraryInputs["ISOM2017-2"]);
    const heading = base.entries.find((e) => e.id === "ISOM2017-2:302")!;
    const variant = base.entries.find((e) => e.id === "ISOM2017-2:302.b")!;
    const broken = {
      ...base,
      entries: [
        { ...heading, aliases: [{ library: "ISOM1990", code: "301" }] },
        { ...heading, id: "ISOM2017-2:303", code: "303", aliases: [{ library: "ISOM2000", code: "303" }, { library: "ISOM2000", code: "303" }] },
        { ...variant, aliases: [{ library: "ISOM2000", code: "302" }] },
        { ...variant, id: "ISOM2017-2:302.c", variant: "c", name: { en: "x", sv: "Något annat, streckad" } },
      ],
    };
    const messages = validateLibrary(broken).map((p) => p.message);
    expect(messages).toEqual(expect.arrayContaining([
      'alias library "ISOM1990" is not one of ISOM2000, ISSOM2007',
      "duplicate alias ISOM2000 303",
      "aliases are for heading entries only",
      'variant name should start with "Grund vattenyta, "',
    ]));
  });

  it("withNamesAndAliases rejects a key no entry owns and an alias on a variant", () => {
    const entries = symbolLibraryInputs["ISOM2017-2"].entries;
    expect(() => withNamesAndAliases(entries, { "999": "Inget" }, {})).toThrow(/999/);
    expect(() => withNamesAndAliases(entries, {}, { "302.b": [{ library: "ISOM2000", code: "302" }] })).toThrow(/302\.b/);
  });
});
