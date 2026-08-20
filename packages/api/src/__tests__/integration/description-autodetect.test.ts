/**
 * Integration test for `control.suggestDescription`.
 *
 * Uploads the synthetic OCAD fixture and searches around the two features
 * `scripts/generate-test-ocd.mjs` places in the otherwise empty top-right
 * corner: a boulder (ISOM 204) at 68/42 mm and a building (ISOM 521)
 * spanning 48–58 / 39–46 mm. Both are outside the yellow rough-open blob,
 * so a search near either returns just that feature.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  createTestEvent,
  disconnect,
  type TestEventContext,
} from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "../../../../../e2e/test.ocd");

/** Fixture feature positions, paper mm. */
const BOULDER = { x: 68, y: 42 };

let ctx: TestEventContext;
let caller: ReturnType<typeof makeCaller>;

beforeAll(async () => {
  ctx = await createTestEvent("desc_autodetect");
  caller = makeCaller(ctx.event);
  const buf = readFileSync(FIXTURE);
  await caller.course.uploadMap({
    fileName: "test.ocd",
    fileDataBase64: buf.toString("base64"),
  });
});

afterAll(async () => {
  await ctx.cleanup();
  await disconnect();
});

describe("control.suggestDescription", () => {
  it("finds the boulder a control is sitting on", async () => {
    const { candidates } = await caller.control.suggestDescription(BOULDER);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].d).toBe("2.004");
    expect(candidates[0].isom).toBe(204);
    expect(candidates[0].distanceMm).toBeCloseTo(0, 5);
    // On the feature, so no side-of suggestion.
    expect(candidates[0].g).toBeUndefined();
  });

  it("suggests a side of the boulder when the control sits beside it", async () => {
    // 1 mm north of the boulder: paper Y points north.
    const { candidates } = await caller.control.suggestDescription({
      x: BOULDER.x,
      y: BOULDER.y + 1,
    });
    expect(candidates[0].d).toBe("2.004");
    expect(candidates[0].distanceMm).toBeCloseTo(1, 5);
    expect(candidates[0].g).toBe("11.101");

    const west = await caller.control.suggestDescription({
      x: BOULDER.x - 1.5,
      y: BOULDER.y,
    });
    expect(west.candidates[0].g).toBe("11.107");
  });

  it("finds the building and reports the boulder too at a wider radius", async () => {
    const inside = await caller.control.suggestDescription({ x: 53, y: 42 });
    expect(inside.candidates.map((c) => c.d)).toEqual(["5.011"]);
    expect(inside.candidates[0].distanceMm).toBe(0);

    // Between the two, a wider reach picks up both — building first.
    const wide = await caller.control.suggestDescription({
      x: 60,
      y: 42,
      radiusMm: 10,
    });
    expect(wide.candidates.map((c) => c.isom)[0]).toBe(521);
    expect(wide.candidates.map((c) => c.isom)).toContain(204);
  });

  it("returns nothing where the map has no mapped features", async () => {
    // Far outside the map area.
    const { candidates } = await caller.control.suggestDescription({
      x: 500,
      y: 500,
    });
    expect(candidates).toEqual([]);
  });

  it("finds the rough-open blob and a path over the control cluster", async () => {
    // The yellow area covers the whole control cluster, and the three
    // paths cross it — inside the blob there is always something to
    // suggest, which is what the editor E2E relies on.
    const { candidates } = await caller.control.suggestDescription({
      x: 0,
      y: -4,
      radiusMm: 5,
    });
    const codes = candidates.map((c) => c.d);
    expect(codes).toContain("4.001");
    expect(codes).toContain("5.002");
  });

  it("returns an empty list for an event with no map", async () => {
    const other = await createTestEvent("desc_autodetect_nomap");
    try {
      const otherCaller = makeCaller(other.event);
      const { candidates } = await otherCaller.control.suggestDescription({
        x: 0,
        y: 0,
      });
      expect(candidates).toEqual([]);
    } finally {
      await other.cleanup();
    }
  });
});
