import { describe, expect, it } from "vitest";
import {
  NO_CLUB,
  clubKey,
  mergeClubOptions,
  noRosterMatch,
  optionForClub,
  resolveClubKey,
  rosterClubOptions,
  searchCachedClubs,
} from "../club-options";

// WEB-06 / WEB-10 / WEB-11: club choices are keyed by Eventor id or name.
const roster = rosterClubOptions([
  { id: 0, name: "Friskis", extId: 0 },
  { id: 1234, name: "OK Linné", extId: 1234 },
]);

describe("club options", () => {
  it("never gives a free-text club the No club key", () => {
    expect(roster.map((o) => o.key)).toEqual(["n:friskis", "e:1234"]);
    expect(roster.every((o) => o.key !== NO_CLUB)).toBe(true);
  });

  it("No club resolves to no name and no Eventor id even when a free-text club exists", () => {
    expect(resolveClubKey(roster, NO_CLUB)).toEqual({ clubName: "", eventorClubId: null });
  });

  it("a free-text club resolves to its name without an Eventor id", () => {
    expect(resolveClubKey(roster, "n:friskis")).toEqual({ clubName: "Friskis", eventorClubId: null });
  });

  it("an Eventor club resolves to its name and id", () => {
    expect(resolveClubKey(roster, "e:1234")).toEqual({ clubName: "OK Linné", eventorClubId: 1234 });
  });

  it("an unknown Eventor key keeps the id for the server to name", () => {
    expect(resolveClubKey(roster, "e:99")).toEqual({ clubName: "", eventorClubId: 99 });
  });

  it("a club outside the roster becomes an ad-hoc option; one inside is the roster entry", () => {
    expect(optionForClub(roster, { eventorId: 1234, name: "Linné" })).toBe(roster[1]);
    expect(optionForClub(roster, { eventorId: 77, name: "IFK Göteborg" })).toEqual({
      key: "e:77",
      name: "IFK Göteborg",
      eventorId: 77,
      source: "adhoc",
    });
    expect(optionForClub(roster, { eventorId: 77, name: "" })).toBeNull();
    expect(optionForClub(roster, { name: "" })).toBeNull();
  });

  it("merges roster, ad-hoc and directory options without duplicates, roster first", () => {
    const adhoc = [{ key: "e:77", name: "IFK Göteborg", eventorId: 77, source: "adhoc" as const }];
    const dir = [
      { key: "e:1234", name: "OK Linné (dir)", eventorId: 1234, source: "directory" as const },
      { key: "e:77", name: "IFK Göteborg", eventorId: 77, source: "directory" as const },
      { key: "e:88", name: "Göteborg-Majorna OK", eventorId: 88, source: "directory" as const },
    ];
    const merged = mergeClubOptions(roster, adhoc, dir);
    expect(merged.map((o) => `${o.key}:${o.source}`)).toEqual([
      "n:friskis:roster",
      "e:1234:roster",
      "e:77:adhoc",
      "e:88:directory",
    ]);
  });

  it("searches the directory only when the roster has no match", () => {
    expect(noRosterMatch(roster, "fr")).toBe(false);
    expect(noRosterMatch(roster, "göteborg")).toBe(true);
    expect(noRosterMatch(roster, "g")).toBe(false);
  });

  it("searches the cached runner DB clubs offline", () => {
    const hits = searchCachedClubs({ 77: "IFK Göteborg", 88: "Göteborg-Majorna OK", 5: "OK Ravinen" }, "göte");
    expect(hits.map((h) => h.key).sort()).toEqual(["e:77", "e:88"]);
    expect(searchCachedClubs(undefined, "göte")).toEqual([]);
  });

  it("keys by Eventor id when there is one, else by name", () => {
    expect(clubKey({ eventorId: 5, name: "x" })).toBe("e:5");
    expect(clubKey({ eventorId: 0, name: " Friskis " })).toBe("n:friskis");
    expect(clubKey({})).toBe(NO_CLUB);
  });
});
