import { describe, expect, it } from "vitest";
import { groupSites, type GroupSite } from "../course-maps/setter-groups.js";

const site = (seq: number, x: number, y: number): GroupSite => ({ id: `c${seq}`, seq, x, y });
const seqs = (groups: GroupSite[][]) => groups.map((g) => g.map((s) => s.seq));

/** Two clusters of three: west around (−100, 0), east around (100, 0). */
const twoClusters = [site(1, 100, 0), site(2, -100, 0), site(3, 102, 4), site(4, -98, -3), site(5, 99, -5), site(6, -103, 2)];

describe("groupSites — setter maps (course-layout.md §8; 08 §4.6 k-means)", () => {
  it("splits two clear clusters, numbered west to east, each group in seq order", () => {
    expect(seqs(groupSites(twoClusters, 2))).toEqual([[2, 4, 6], [1, 3, 5]]);
  });

  it("is deterministic: the same input gives the same groups, in any input order", () => {
    const a = groupSites(twoClusters, 2);
    expect(groupSites(twoClusters, 2)).toEqual(a);
    expect(groupSites([...twoClusters].reverse(), 2)).toEqual(a);
    const grid = Array.from({ length: 40 }, (_, i) => site(i + 1, (i * 37) % 200, (i * 53) % 150));
    const g = groupSites(grid, 4);
    expect(groupSites([...grid].reverse(), 4)).toEqual(g);
    expect(g).toHaveLength(4);
    expect(g.flat().map((s) => s.seq).sort((x, y) => x - y)).toEqual(grid.map((s) => s.seq));
  });

  it("one group holds every site; as many groups as sites gives one each", () => {
    expect(seqs(groupSites(twoClusters, 1))).toEqual([[1, 2, 3, 4, 5, 6]]);
    const each = groupSites(twoClusters, 6);
    expect(each).toHaveLength(6);
    expect(each.every((g) => g.length === 1)).toBe(true);
    // West to east: −103, −100, −98, 99, 100, 102.
    expect(seqs(each).flat()).toEqual([6, 2, 4, 5, 1, 3]);
  });

  it("never leaves a group empty, even with coincident sites", () => {
    const same = [site(1, 0, 0), site(2, 0, 0), site(3, 0, 0), site(4, 50, 0)];
    const g = groupSites(same, 3);
    expect(g).toHaveLength(3);
    expect(g.every((x) => x.length > 0)).toBe(true);
    expect(g.flat()).toHaveLength(4);
  });

  it("clamps n to 1 … the site count; no sites, no groups", () => {
    expect(groupSites(twoClusters, 0)).toHaveLength(1);
    expect(groupSites(twoClusters, 10)).toHaveLength(6);
    expect(groupSites([], 3)).toEqual([]);
  });
});
