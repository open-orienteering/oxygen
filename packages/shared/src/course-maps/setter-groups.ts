/**
 * Setter-map groups (docs/course-layout.md §8; research 08 §4.6 "Setter
 * maps": "controls grouped geographically into N groups (k-means on paper
 * coordinates)"). Deterministic by construction — no random seed:
 *
 * 1. The sites in `seq` order (the input order never matters).
 * 2. Seeds by farthest-first traversal from the lowest-seq site: each next
 *    seed is the site farthest from every seed so far (ties: lower seq).
 * 3. Lloyd iterations (at most `SETTER_KMEANS_MAX_ITERATIONS`): each site to
 *    its nearest centroid — on a tie it stays where it is, else the lower
 *    group —, an emptied group takes the site farthest from its own
 *    centroid among the groups of two or more (ties: lower seq), centroids
 *    the means; until no site moves.
 * 4. Groups numbered west → east by centroid x (then north first, then the
 *    lowest seq), so *Setter 1* is the westernmost and the numbers stay
 *    put when nothing moved; each group's sites in `seq` order.
 *
 * `n` is clamped to 1 … the site count, so no group is ever empty.
 */

export interface GroupSite {
  id: string;
  seq: number;
  /** Paper mm on the map (`controls.xpos` / `ypos`), y up. */
  x: number;
  y: number;
}

export const SETTER_KMEANS_MAX_ITERATIONS = 100;

export function groupSites<T extends GroupSite>(input: readonly T[], n: number): T[][] {
  if (input.length === 0) return [];
  const sites = [...input].sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const k = Math.max(1, Math.min(Math.floor(n) || 1, sites.length));
  const d2 = (a: { x: number; y: number }, b: { x: number; y: number }) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

  // 2. Farthest-first seeds.
  const chosen = new Array<boolean>(sites.length).fill(false);
  chosen[0] = true;
  const seeds = [sites[0]];
  const nearest = sites.map((s) => d2(s, sites[0]));
  while (seeds.length < k) {
    let best = -1;
    for (let i = 0; i < sites.length; i++) if (!chosen[i] && (best < 0 || nearest[i] > nearest[best])) best = i;
    chosen[best] = true;
    seeds.push(sites[best]);
    for (let i = 0; i < sites.length; i++) nearest[i] = Math.min(nearest[i], d2(sites[i], sites[best]));
  }

  // 3. Lloyd.
  let centroids = seeds.map((s) => ({ x: s.x, y: s.y }));
  const assign = new Array<number>(sites.length).fill(-1);
  for (let iter = 0; iter < SETTER_KMEANS_MAX_ITERATIONS; iter++) {
    let changed = false;
    for (let i = 0; i < sites.length; i++) {
      let best = assign[i] >= 0 ? assign[i] : 0;
      let bestD = d2(sites[i], centroids[best]);
      for (let c = 0; c < k; c++) {
        const d = d2(sites[i], centroids[c]);
        if (d < bestD) { best = c; bestD = d; }
      }
      if (best !== assign[i]) { assign[i] = best; changed = true; }
    }
    const count = new Array<number>(k).fill(0);
    for (const c of assign) count[c] += 1;
    for (let c = 0; c < k; c++) {
      if (count[c] > 0) continue;
      let pick = -1, pickD = -1;
      for (let i = 0; i < sites.length; i++) {
        if (count[assign[i]] < 2) continue;
        const d = d2(sites[i], centroids[assign[i]]);
        if (d > pickD) { pick = i; pickD = d; }
      }
      count[assign[pick]] -= 1;
      assign[pick] = c;
      count[c] = 1;
      changed = true;
    }
    centroids = centroids.map((_, c) => {
      let x = 0, y = 0, m = 0;
      for (let i = 0; i < sites.length; i++) if (assign[i] === c) { x += sites[i].x; y += sites[i].y; m += 1; }
      return { x: x / m, y: y / m };
    });
    if (!changed) break;
  }

  // 4. Numbered west → east.
  const groups = centroids.map((centre, c) => ({ centre, sites: sites.filter((_, i) => assign[i] === c) }));
  groups.sort((a, b) => a.centre.x - b.centre.x || b.centre.y - a.centre.y || a.sites[0].seq - b.sites[0].seq);
  return groups.map((g) => g.sites);
}
