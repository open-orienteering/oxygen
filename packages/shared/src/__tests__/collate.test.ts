/**
 * `compareLabels` (docs/course-print.md §8.6, G16): the pinned print order
 * does not depend on the host's locale and equals the server's previous
 * default (en-US), so pinning it moved no server bytes.
 */

import { describe, expect, it } from "vitest";
import { compareLabels } from "../course-maps/collate.js";

const NAMES = ["a", "B", "10", "9", "å", "ä", "z", "Z", "S1", "s2", "Start 1", "Mål", "é", "e", "w", "v", "31", "4", "ö", "o"];

describe("compareLabels", () => {
  it("sorts numerically, case and accents after the base letter", () => {
    expect([...NAMES].sort(compareLabels)).toEqual(["4", "9", "10", "31", "a", "å", "ä", "B", "e", "é", "Mål", "o", "ö", "S1", "s2", "Start 1", "v", "w", "z", "Z"]);
  });

  it("is the en-US numeric order the server used, not the Swedish one", () => {
    const enUs = [...NAMES].sort((a, b) => a.localeCompare(b, "en-US", { numeric: true }));
    expect([...NAMES].sort(compareLabels)).toEqual(enUs);
    const sv = [...NAMES].sort((a, b) => a.localeCompare(b, "sv", { numeric: true }));
    expect(sv).not.toEqual(enUs);
  });
});
