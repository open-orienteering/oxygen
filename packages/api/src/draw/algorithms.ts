/**
 * Draw algorithms — pure functions that take a list of runners and return
 * them in the desired start order. No DB access, no side effects.
 */

export interface DrawRunner {
  id: number;
  name: string;
  clubId: number;
  clubName: string;
  startNo: number;
  rank: number;
}

/**
 * Fisher-Yates shuffle — uniformly random permutation.
 */
export function randomDraw(runners: DrawRunner[]): DrawRunner[] {
  const arr = [...runners];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Club-separation draw (adapted SOFT method).
 *
 * Groups runners by club, then distributes clubs across groups so that
 * same-club runners are spread as far apart as possible in the final order.
 *
 * Algorithm:
 * 1. Group runners by club, sort groups by size (largest first)
 * 2. Determine target group count = max(largestClubSize, ceil(totalRunners / 20))
 *    (ensures groups are large enough to shuffle meaningfully)
 * 3. Distribute clubs to groups round-robin by descending club size
 * 4. Shuffle within each group, then shuffle the group order
 * 5. Flatten to produce the final order
 */
export function clubSeparationDraw(runners: DrawRunner[]): DrawRunner[] {
  if (runners.length <= 1) return [...runners];

  const byClub = new Map<number, DrawRunner[]>();
  for (const r of runners) {
    const list = byClub.get(r.clubId) ?? [];
    list.push(r);
    byClub.set(r.clubId, list);
  }

  const clubs = [...byClub.entries()]
    .map(([clubId, members]) => ({ clubId, members: shuffle(members) }))
    .sort((a, b) => b.members.length - a.members.length);

  const largestClub = clubs[0].members.length;
  const groupCount = Math.max(largestClub, Math.ceil(runners.length / 20));

  const groups: DrawRunner[][] = Array.from({ length: groupCount }, () => []);

  for (const club of clubs) {
    // Find the groups with fewest members to balance load
    const targetIndices = Array.from({ length: groupCount }, (_, i) => i)
      .sort((a, b) => groups[a].length - groups[b].length);

    for (let i = 0; i < club.members.length; i++) {
      const groupIdx = targetIndices[i % groupCount];
      groups[groupIdx].push(club.members[i]);
    }
  }

  // Shuffle within each group and shuffle group order
  for (const g of groups) {
    shuffleInPlace(g);
  }
  shuffleInPlace(groups);

  // Flatten, but check for same-club neighbors and swap if possible
  const result = groups.flat();
  fixClubNeighbors(result);

  return result;
}

/**
 * Seeded draw — runners with ranking/seed get later (better) start times.
 *
 * Splits runners into two pools:
 * - Seeded: runners with Rank > 0 or StartNo > 0 (sorted by rank/startNo)
 * - Unseeded: everyone else (random order)
 *
 * Unseeded runners start first, seeded runners start later.
 * Within each pool, club separation is optionally applied.
 */
export function seededDraw(
  runners: DrawRunner[],
  options: { clubSeparation?: boolean } = {},
): DrawRunner[] {
  const seeded: DrawRunner[] = [];
  const unseeded: DrawRunner[] = [];

  for (const r of runners) {
    if (r.rank > 0) {
      seeded.push(r);
    } else {
      unseeded.push(r);
    }
  }

  // Sort seeded by rank descending (highest rank = latest start = last in array)
  seeded.sort((a, b) => b.rank - a.rank);

  const orderedUnseeded = options.clubSeparation
    ? clubSeparationDraw(unseeded)
    : randomDraw(unseeded);

  const orderedSeeded = options.clubSeparation
    ? applyClubSeparationToOrder(seeded)
    : seeded;

  return [...orderedUnseeded, ...orderedSeeded];
}

/**
 * Simultaneous (mass start) — all runners start at the same time.
 * Order doesn't matter for timing, but we shuffle for start number assignment.
 */
export function simultaneousDraw(runners: DrawRunner[]): DrawRunner[] {
  return randomDraw(runners);
}

// ─── Helpers ─────────────────────────────────────────────────

function shuffle<T>(arr: T[]): T[] {
  const copy = [...arr];
  shuffleInPlace(copy);
  return copy;
}

function shuffleInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/**
 * Apply club separation to an already-ordered list (e.g., seeded runners).
 * Tries to maintain relative order while avoiding same-club neighbors.
 */
function applyClubSeparationToOrder(runners: DrawRunner[]): DrawRunner[] {
  if (runners.length <= 2) return [...runners];
  const result = [...runners];
  fixClubNeighbors(result);
  return result;
}

/**
 * Post-process pass: scan for same-club neighbors and try to swap them
 * with a nearby non-conflicting runner.
 */
function fixClubNeighbors(arr: DrawRunner[]): void {
  const maxPasses = 3;
  for (let pass = 0; pass < maxPasses; pass++) {
    let swapped = false;
    for (let i = 1; i < arr.length; i++) {
      if (arr[i].clubId === arr[i - 1].clubId) {
        // Try to find a swap partner within a window
        const windowSize = Math.min(10, arr.length);
        let bestSwap = -1;
        let bestDist = Infinity;
        for (let j = 0; j < arr.length; j++) {
          if (j === i || j === i - 1) continue;
          if (Math.abs(j - i) > windowSize) continue;
          // Check placing arr[j] at position i wouldn't create new conflicts
          const wouldConflictBefore =
            i > 0 && arr[j].clubId === arr[i - 1].clubId;
          const wouldConflictAfter =
            i < arr.length - 1 && arr[j].clubId === arr[i + 1]?.clubId;
          // Check the displaced runner at position j
          const jNeighborBefore =
            j > 0 && j - 1 !== i && arr[i].clubId === arr[j - 1]?.clubId;
          const jNeighborAfter =
            j < arr.length - 1 &&
            j + 1 !== i &&
            arr[i].clubId === arr[j + 1]?.clubId;

          if (
            !wouldConflictBefore &&
            !wouldConflictAfter &&
            !jNeighborBefore &&
            !jNeighborAfter
          ) {
            const dist = Math.abs(j - i);
            if (dist < bestDist) {
              bestDist = dist;
              bestSwap = j;
            }
          }
        }
        if (bestSwap >= 0) {
          [arr[i], arr[bestSwap]] = [arr[bestSwap], arr[i]];
          swapped = true;
        }
      }
    }
    if (!swapped) break;
  }
}
