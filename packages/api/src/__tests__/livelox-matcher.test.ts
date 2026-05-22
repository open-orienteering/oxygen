/**
 * Unit tests for the Livelox 3-priority runner matcher.
 *
 * Priority order:
 *   P1 — Eventor person id (highest signal)
 *   P2 — Club-scoped name match (via Eventor club id, then club name)
 *   P3 — Cross-club name match (with middle-name strip)
 *
 * The matcher is the most failure-prone piece of the Livelox sync — a
 * regression here means runner names show up unmatched on TracksPage
 * and the operator has to fix them up manually. Tests below lock the
 * priority order, the case-insensitive name normalisation and the
 * "FirstName LastName" / "LastName FirstName" tolerance.
 */

import { describe, it, expect } from "vitest";
import { matchRunner, normName, type RunnerLookups } from "../livelox/sync.js";

function lookups(): RunnerLookups {
  return {
    byFullName: new Map(),
    byEventorPersonId: new Map(),
    runnersByEventorClubId: new Map(),
    runnersByClubName: new Map(),
  };
}

describe("livelox runner matcher", () => {
  it("normalises whitespace and case", () => {
    expect(normName("  Anna   Larsson  ")).toBe("anna larsson");
    expect(normName("ANNA-MARIA")).toBe("anna-maria");
  });

  it("returns null when no signals match", () => {
    expect(
      matchRunner("Anna", "Larsson", null, null, null, lookups()),
    ).toBeNull();
  });

  it("P1 — Eventor person id wins over everything else", () => {
    const l = lookups();
    l.byEventorPersonId.set("12345", "runner-1");
    l.byFullName.set(normName("Anna Larsson"), "runner-2");
    expect(
      matchRunner("Anna", "Larsson", "12345", null, null, l),
    ).toBe("runner-1");
  });

  it("P2 — Eventor club id scopes the name match", () => {
    const l = lookups();
    l.runnersByEventorClubId.set(50, [
      { id: "runner-3", norm: normName("Anna Larsson") },
    ]);
    l.byFullName.set(normName("Anna Larsson"), "wrong-runner");
    expect(
      matchRunner("Anna", "Larsson", null, "50", null, l),
    ).toBe("runner-3");
  });

  it("P2 — falls back to club name when Eventor org id is missing", () => {
    const l = lookups();
    l.runnersByClubName.set("ok bagheera", [
      { id: "runner-4", norm: normName("Anna Larsson") },
    ]);
    expect(
      matchRunner("Anna", "Larsson", null, null, "OK Bagheera", l),
    ).toBe("runner-4");
  });

  it("P2 — tolerates LastName FirstName order in the club roster", () => {
    const l = lookups();
    l.runnersByEventorClubId.set(50, [
      { id: "runner-5", norm: normName("Larsson Anna") },
    ]);
    expect(
      matchRunner("Anna", "Larsson", null, "50", null, l),
    ).toBe("runner-5");
  });

  it("P2 — strips middle names on retry", () => {
    const l = lookups();
    l.runnersByEventorClubId.set(50, [
      { id: "runner-6", norm: normName("Anna Larsson") },
    ]);
    expect(
      matchRunner("Anna Marie", "Larsson", null, "50", null, l),
    ).toBe("runner-6");
  });

  it("P3 — cross-club name match as last resort", () => {
    const l = lookups();
    l.byFullName.set(normName("Anna Larsson"), "runner-7");
    expect(
      matchRunner("Anna", "Larsson", null, null, null, l),
    ).toBe("runner-7");
  });

  it("P3b — cross-club middle-name strip only fires when present", () => {
    const l = lookups();
    l.byFullName.set(normName("Anna Larsson"), "runner-8");
    expect(
      matchRunner("Anna Marie", "Larsson", null, null, null, l),
    ).toBe("runner-8");
    // Without a middle name, the second pass must not be attempted (no
    // way for "Anna Larsson" to match "Anna Marie Larsson" if only the
    // latter is in the roster).
    const l2 = lookups();
    l2.byFullName.set(normName("Anna Marie Larsson"), "runner-9");
    expect(matchRunner("Anna", "Larsson", null, null, null, l2)).toBeNull();
  });

  it("returns null when a club is given but the person isn't in it", () => {
    const l = lookups();
    l.runnersByEventorClubId.set(50, [
      { id: "other-runner", norm: normName("Lars Andersson") },
    ]);
    // No fallback to cross-club lookup ‒ we deliberately scope down by
    // club when one was provided.
    expect(
      matchRunner("Anna", "Larsson", null, "50", null, l),
    ).toBeNull();
  });
});
