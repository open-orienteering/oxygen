/**
 * Fuzzy club name matching for SI card owner data → club database.
 *
 * Handles common variations in Swedish orienteering club names:
 * - Suffix differences: OK vs OL vs IF vs IK vs SK etc.
 * - Partial matches: "IK Uven" vs "IK Uansen"
 * - Abbreviations and word order
 */

interface ClubCandidate {
  id: number;
  name: string;
  shortName: string;
  runnerCount: number;
}

const CLUB_SUFFIXES = new Set([
  "ok", "ol", "if", "ik", "sk", "fk", "sok", "sol",
  "ais", "bk", "kob", "of", "gf", "rf", "af",
]);

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-zåäöüé0-9\s]/g, "");
}

function tokenize(s: string): string[] {
  return normalize(s).split(/\s+/).filter(Boolean);
}

/** Remove common club type suffixes from token list */
function stripSuffixes(tokens: string[]): string[] {
  return tokens.filter((t) => !CLUB_SUFFIXES.has(t));
}

function scoreMatch(query: string, club: ClubCandidate): number {
  const qNorm = normalize(query);
  const cNorm = normalize(club.name);
  const sNorm = normalize(club.shortName);

  // Exact match
  if (qNorm === cNorm) return 100;
  if (qNorm === sNorm) return 95;

  // Normalized (suffix-stripped) exact match
  const qTokens = tokenize(query);
  const cTokens = tokenize(club.name);
  const qCore = stripSuffixes(qTokens).join(" ");
  const cCore = stripSuffixes(cTokens).join(" ");
  if (qCore && cCore && qCore === cCore) return 90;

  // Token overlap scoring
  const qSet = stripSuffixes(qTokens);
  const cSet = stripSuffixes(cTokens);
  if (qSet.length === 0 || cSet.length === 0) return 0;

  let matchCount = 0;
  for (const qt of qSet) {
    if (cSet.some((ct) => ct === qt || ct.startsWith(qt) || qt.startsWith(ct))) {
      matchCount++;
    }
  }

  const overlapRatio = matchCount / Math.max(qSet.length, cSet.length);
  if (overlapRatio === 0) return 0;

  // Require at least one non-trivial token match
  return Math.round(50 + overlapRatio * 35);

}

/**
 * Find the best matching club for an SI card owner's club string.
 * Returns the matched club or null if no good match found.
 */
export function fuzzyMatchClub(
  ownerClub: string,
  clubs: ClubCandidate[],
  threshold = 60,
): ClubCandidate | null {
  if (!ownerClub.trim()) return null;

  let bestScore = 0;
  let bestClub: ClubCandidate | null = null;

  for (const club of clubs) {
    const score = scoreMatch(ownerClub, club);
    if (score > bestScore || (score === bestScore && bestClub && club.runnerCount > bestClub.runnerCount)) {
      bestScore = score;
      bestClub = club;
    }
  }

  return bestScore >= threshold ? bestClub : null;
}
