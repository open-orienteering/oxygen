import { describe, it, expect } from "vitest";
import { normName, matchRunner, type RunnerLookups } from "../routers/livelox.js";

describe("normName", () => {
  it("lowercases and trims", () => {
    expect(normName("  Anna Svensson  ")).toBe("anna svensson");
  });

  it("collapses multiple spaces", () => {
    expect(normName("Anna  Maria   Berg")).toBe("anna maria berg");
  });

  it("handles empty string", () => {
    expect(normName("")).toBe("");
  });
});

/** Helper to build a RunnerLookups from a simple spec. */
function buildLookups(spec: {
  runners: Array<{ id: number; name: string; club?: number; extId?: string }>;
  clubs: Array<{ id: number; name: string; extId?: string }>;
}): RunnerLookups {
  const byFullName = new Map<string, number>();
  const byExtId = new Map<string, number>();
  const runnersByClub = new Map<number, Array<{ id: number; norm: string }>>();
  const clubByExtId = new Map<string, number>();
  const clubByName = new Map<string, number>();

  for (const r of spec.runners) {
    byFullName.set(normName(r.name), r.id);
    if (r.extId) byExtId.set(r.extId, r.id);
    if (r.club) {
      let list = runnersByClub.get(r.club);
      if (!list) { list = []; runnersByClub.set(r.club, list); }
      list.push({ id: r.id, norm: normName(r.name) });
    }
  }
  for (const c of spec.clubs) {
    clubByName.set(normName(c.name), c.id);
    if (c.extId) clubByExtId.set(c.extId, c.id);
  }

  return { byFullName, byExtId, clubByExtId, clubByName, runnersByClub };
}

describe("matchRunner", () => {
  const lookups = buildLookups({
    runners: [
      { id: 1, name: "Anna Svensson", club: 10, extId: "12345" },
      { id: 2, name: "Erik Larsson", club: 10 },
      { id: 3, name: "Alexandra Svenhard", club: 20 },
      { id: 4, name: "Ulf Carlby", club: 20, extId: "22308" },
    ],
    clubs: [
      { id: 10, name: "OK Linné", extId: "585" },
      { id: 20, name: "Järla Orientering" },
    ],
  });

  describe("P1: Eventor person ID", () => {
    it("matches by personExtId", () => {
      expect(matchRunner("Anna", "Svensson", "12345", null, null, lookups)).toBe(1);
    });

    it("matches by personExtId even with wrong name", () => {
      expect(matchRunner("Wrong", "Name", "12345", null, null, lookups)).toBe(1);
    });

    it("skips P1 if personExtId not found", () => {
      expect(matchRunner("Anna", "Svensson", "99999", null, null, lookups)).toBe(1); // falls to P3
    });
  });

  describe("P2: Club-scoped name match", () => {
    it("matches via Eventor org ID + name", () => {
      expect(matchRunner("Erik", "Larsson", null, "585", null, lookups)).toBe(2);
    });

    it("matches via club name string", () => {
      expect(matchRunner("Erik", "Larsson", null, null, "OK Linné", lookups)).toBe(2);
    });

    it("strips middle names within club", () => {
      // "Alexandra Beatrice" → first word "Alexandra" + last name "Svenhard"
      expect(
        matchRunner("Alexandra Beatrice", "Svenhard", null, null, "Järla Orientering", lookups),
      ).toBe(3);
    });

    it("falls through to P3 when runner not in specified club", () => {
      // Erik is in OK Linné (id=10), not Järla — P2 fails, P3 finds him cross-club
      expect(matchRunner("Erik", "Larsson", null, null, "Järla Orientering", lookups)).toBe(2);
    });
  });

  describe("P3: Cross-club exact name", () => {
    it("matches First Last", () => {
      expect(matchRunner("Erik", "Larsson", null, null, null, lookups)).toBe(2);
    });

    it("matches Last First", () => {
      expect(matchRunner("Larsson", "Erik", null, null, null, lookups)).toBe(2);
    });

    it("returns null for unknown name", () => {
      expect(matchRunner("Nobody", "Here", null, null, null, lookups)).toBeNull();
    });
  });

  describe("P3b: Cross-club middle-name strip", () => {
    it("strips middle names cross-club", () => {
      expect(
        matchRunner("Alexandra Beatrice", "Svenhard", null, null, null, lookups),
      ).toBe(3);
    });

    it("does not strip if firstName is single word", () => {
      // "Alexandra" is already single word, no stripping → matches exactly
      expect(matchRunner("Alexandra", "Svenhard", null, null, null, lookups)).toBe(3);
    });
  });

  describe("priority ordering", () => {
    it("P1 takes precedence over P3", () => {
      // ExtId points to runner 4 (Ulf Carlby), but name is "Anna Svensson" (runner 1)
      expect(matchRunner("Anna", "Svensson", "22308", null, null, lookups)).toBe(4);
    });

    it("falls through from P2 to P3 when club match fails", () => {
      // "Anna Svensson" is not in Järla (club P2 fails), but P3 finds her cross-club
      expect(matchRunner("Anna", "Svensson", null, null, "Järla Orientering", lookups)).toBe(1);
    });
  });
});
