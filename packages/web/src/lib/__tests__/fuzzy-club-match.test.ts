import { describe, it, expect } from "vitest";
import { fuzzyMatchClub } from "../fuzzy-club-match.js";

const clubs = [
  { id: 1, name: "IK Uansen", shortName: "IK Uansen", runnerCount: 5 },
  { id: 2, name: "Göteborg-Majorna OK", shortName: "Göteborg-Maj", runnerCount: 12 },
  { id: 3, name: "OK Ravinen", shortName: "OK Ravinen", runnerCount: 8 },
  { id: 4, name: "Sävedalens AIK", shortName: "Sävedalen", runnerCount: 3 },
  { id: 5, name: "Frölunda OL", shortName: "Frölunda", runnerCount: 10 },
  { id: 6, name: "Kungälvs OK", shortName: "Kungälvs OK", runnerCount: 7 },
];

describe("fuzzyMatchClub", () => {
  it("matches exact club name", () => {
    const match = fuzzyMatchClub("OK Ravinen", clubs);
    expect(match?.id).toBe(3);
  });

  it("matches case-insensitive", () => {
    const match = fuzzyMatchClub("ok ravinen", clubs);
    expect(match?.id).toBe(3);
  });

  it("matches by shortName", () => {
    const match = fuzzyMatchClub("Sävedalen", clubs);
    expect(match?.id).toBe(4);
  });

  it("matches despite suffix difference (OL vs OK)", () => {
    const match = fuzzyMatchClub("Göteborg-Majorna OL", clubs);
    expect(match?.id).toBe(2);
  });

  it("matches despite suffix difference (OK vs OL)", () => {
    const match = fuzzyMatchClub("Frölunda OK", clubs);
    expect(match?.id).toBe(5);
  });

  it("matches with missing suffix", () => {
    const match = fuzzyMatchClub("Kungälvs", clubs);
    expect(match?.id).toBe(6);
  });

  it("returns null for no match", () => {
    const match = fuzzyMatchClub("Nonexistent Club", clubs);
    expect(match).toBeNull();
  });

  it("returns null for empty string", () => {
    const match = fuzzyMatchClub("", clubs);
    expect(match).toBeNull();
  });

  it("prefers higher runnerCount on equal score", () => {
    const tiedClubs = [
      { id: 10, name: "Test OK", shortName: "Test", runnerCount: 1 },
      { id: 11, name: "Test OK", shortName: "Test", runnerCount: 5 },
    ];
    const match = fuzzyMatchClub("Test OK", tiedClubs);
    expect(match?.id).toBe(11);
  });

  it("handles partial token overlap", () => {
    const match = fuzzyMatchClub("IK Uansen OK", clubs);
    expect(match?.id).toBe(1);
  });
});
