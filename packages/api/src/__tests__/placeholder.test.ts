/**
 * Placeholder so the test runner has at least one file. The original
 * 14-file unit suite was removed during the post-MeOS migration — every
 * test referenced either the MeOS schema or one of the stubbed
 * pipelines. The suite is being rewritten against the new schema in a
 * follow-up; see docs/migrations/2026-drop-meos.md §"Status".
 */
import { describe, it, expect } from "vitest";

describe("api unit tests", () => {
  it("placeholder — suite is being rewritten against the new schema", () => {
    expect(1 + 1).toBe(2);
  });
});
