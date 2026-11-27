/**
 * The automatic route search apart from its thread (docs/course-elevation.md
 * §7.5): one result per job, and a job that throws fails alone.
 */

import { describe, it, expect, vi } from "vitest";
import { S, rect } from "@oxygen/shared/src/terrain/graph/__tests__/synthetic.js";
import { HILL, encodeTerrainDoc } from "./helpers/terrain-doc.js";

const calls = { n: 0 };
vi.mock("@oxygen/shared/src/route/index.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxygen/shared/src/route/index.js")>();
  return {
    ...real,
    shortestLegRoute: (...args: Parameters<typeof real.shortestLegRoute>) => {
      // The second job of a call made to throw.
      if (++calls.n === 2) throw new Error("search blew up");
      return real.shortestLegRoute(...args);
    },
  };
});

const { searchAutoRoutes } = await import("../leg-routes-auto-worker.js");

describe("searchAutoRoutes", () => {
  const bytes = encodeTerrainDoc([...HILL, { sym: S.water, coords: rect(29, 22, 31, 38) }], "auto-worker-unit");
  const job = (y: number) => ({ from: { x: 14, y }, to: { x: 46, y }, obstacles: [] });

  it("gives a result per job and fails only the job that throws", () => {
    calls.n = 0;
    const results = searchAutoRoutes({ bytes, patch: null, groundMPerMm: 15, jobs: [job(44), job(30), job(46)] });
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ ok: true, points: [] });
    expect(results[1]).toEqual({ ok: false, error: "search blew up" });
    expect(results[2]).toMatchObject({ ok: true });
  });
});
