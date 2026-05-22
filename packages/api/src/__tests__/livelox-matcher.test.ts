/**
 * Unit tests for the Livelox 3-priority runner matcher.
 *
 * Priority order:
 *   P1 — Eventor person id (highest signal)
 *   P2a — Eventor club id-scoped name match
 *   P2b — Club name-scoped name match
 *   P3 — Cross-club name match (with middle-name strip)
 *
 * The matcher is the most failure-prone piece of the Livelox sync — a
 * regression here means runner names show up unmatched on TracksPage
 * and the operator has to fix them up manually. Tests below lock the
 * priority order, the case-insensitive name normalisation and the
 * "FirstName LastName" / "LastName FirstName" tolerance.
 *
 * Runner ids are UUIDs in the new schema; we use synthetic short
 * strings here so the assertions stay readable.
 */

import { describe, it, expect } from "vitest";
import {
  matchRunner,
  normName,
  type RunnerLookups,
} from "../livelox/sync.js";

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

/** Build a `RunnerLookups` from a compact spec. */
function buildLookups(spec: {
  runners: Array<{
    id: string;
    name: string;
    clubName?: string;
    eventorClubId?: number;
    eventorPersonId?: string;
  }>;
}): RunnerLookups {
  const byFullName = new Map<string, string>();
  const byEventorPersonId = new Map<string, string>();
  const runnersByEventorClubId = new Map<
    number,
    Array<{ id: string; norm: string }>
  >();
  const runnersByClubName = new Map<
    string,
    Array<{ id: string; norm: string }>
  >();

  for (const r of spec.runners) {
    const norm = normName(r.name);
    byFullName.set(norm, r.id);
    if (r.eventorPersonId) byEventorPersonId.set(r.eventorPersonId, r.id);
    if (r.eventorClubId != null) {
      let list = runnersByEventorClubId.get(r.eventorClubId);
      if (!list) {
        list = [];
        runnersByEventorClubId.set(r.eventorClubId, list);
      }
      list.push({ id: r.id, norm });
    }
    if (r.clubName) {
      const cn = normName(r.clubName);
      let list = runnersByClubName.get(cn);
      if (!list) {
        list = [];
        runnersByClubName.set(cn, list);
      }
      list.push({ id: r.id, norm });
    }
  }

  return {
    byFullName,
    byEventorPersonId,
    runnersByEventorClubId,
    runnersByClubName,
  };
}

describe("matchRunner", () => {
  const lookups = buildLookups({
    runners: [
      {
        id: "uuid-anna",
        name: "Anna Svensson",
        clubName: "OK Linné",
        eventorClubId: 585,
        eventorPersonId: "12345",
      },
      {
        id: "uuid-erik",
        name: "Erik Larsson",
        clubName: "OK Linné",
        eventorClubId: 585,
      },
      {
        id: "uuid-alex",
        name: "Alexandra Svenhard",
        clubName: "Järla Orientering",
      },
      {
        id: "uuid-ulf",
        name: "Ulf Carlby",
        clubName: "Järla Orientering",
        eventorPersonId: "22308",
      },
    ],
  });

  describe("P1: Eventor person ID", () => {
    it("matches by personExtId", () => {
      expect(matchRunner("Anna", "Svensson", "12345", null, null, lookups)).toBe(
        "uuid-anna",
      );
    });

    it("matches by personExtId even with wrong name", () => {
      expect(matchRunner("Wrong", "Name", "12345", null, null, lookups)).toBe(
        "uuid-anna",
      );
    });

    it("skips P1 and falls through when personExtId not found", () => {
      // No fallback to cross-club lookup ‒ we deliberately scope down by
      // priority. With a known name + unknown personExtId the matcher
      // should fall through to P3 and find by name.
      expect(matchRunner("Anna", "Svensson", "99999", null, null, lookups)).toBe(
        "uuid-anna",
      );
    });
  });

  describe("P2a: Eventor club id-scoped name match", () => {
    it("matches via Eventor org ID + name", () => {
      expect(matchRunner("Erik", "Larsson", null, "585", null, lookups)).toBe(
        "uuid-erik",
      );
    });
  });

  describe("P2b: Club-name-scoped match", () => {
    it("matches via club name string", () => {
      expect(
        matchRunner("Erik", "Larsson", null, null, "OK Linné", lookups),
      ).toBe("uuid-erik");
    });

    it("strips middle names within club", () => {
      expect(
        matchRunner(
          "Alexandra Beatrice",
          "Svenhard",
          null,
          null,
          "Järla Orientering",
          lookups,
        ),
      ).toBe("uuid-alex");
    });

    it("falls through to P3 when runner not in specified club", () => {
      // Erik is in OK Linné, not Järla — P2 fails, P3 finds him cross-club.
      expect(
        matchRunner("Erik", "Larsson", null, null, "Järla Orientering", lookups),
      ).toBe("uuid-erik");
    });
  });

  describe("P3: Cross-club exact name", () => {
    it("matches First Last", () => {
      expect(matchRunner("Erik", "Larsson", null, null, null, lookups)).toBe(
        "uuid-erik",
      );
    });

    it("matches Last First", () => {
      expect(matchRunner("Larsson", "Erik", null, null, null, lookups)).toBe(
        "uuid-erik",
      );
    });

    it("returns null for unknown name", () => {
      expect(matchRunner("Nobody", "Here", null, null, null, lookups)).toBeNull();
    });
  });

  describe("P3b: Cross-club middle-name strip", () => {
    it("strips middle names cross-club", () => {
      expect(
        matchRunner("Alexandra Beatrice", "Svenhard", null, null, null, lookups),
      ).toBe("uuid-alex");
    });

    it("does not strip if firstName is single word", () => {
      expect(
        matchRunner("Alexandra", "Svenhard", null, null, null, lookups),
      ).toBe("uuid-alex");
    });
  });

  describe("priority ordering", () => {
    it("P1 takes precedence over P3", () => {
      // ExtId points to runner Ulf, but name is "Anna Svensson"
      expect(matchRunner("Anna", "Svensson", "22308", null, null, lookups)).toBe(
        "uuid-ulf",
      );
    });

    it("falls through from P2 to P3 when club match fails", () => {
      // "Anna Svensson" is not in Järla (P2 fails); P3 finds her cross-club.
      expect(
        matchRunner("Anna", "Svensson", null, null, "Järla Orientering", lookups),
      ).toBe("uuid-anna");
    });
  });
});
