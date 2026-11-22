/**
 * The class's course in the lists pushed to Eventor
 * (docs/course-elevation.md §8).
 *
 * The two uploads are mocked at the module level: the test reads what the
 * router hands them from a real database, and nothing leaves the process.
 */

import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";

vi.mock("../../eventor.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../eventor.js")>(
      "../../eventor.js",
    );
  return {
    ...actual,
    uploadStartList: vi.fn(async () => undefined),
    uploadResults: vi.fn(async () => undefined),
  };
});

vi.mock("../../eventorKeyStore.js", () => ({
  eventorKeyStore: {
    getKey: async () => "test-key",
    getOrganisation: async () => ({ id: 1, name: "Mock Org" }),
    _resetForTests: () => undefined,
  },
}));

import {
  uploadResults,
  uploadStartList,
  type ResultForUpload,
} from "../../eventor.js";
import { createTestEvent, disconnect } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";

beforeEach(() => {
  vi.mocked(uploadStartList).mockClear();
  vi.mocked(uploadResults).mockClear();
});

afterAll(async () => {
  await disconnect();
}, 30_000);

async function seed(slug: string) {
  const ctx = await createTestEvent(slug);
  await ctx.db.event.update({
    where: { id: ctx.eventId },
    data: { eventorEventId: 99_101n, eventorEnv: "test" },
  });
  const course = (name: string, lengthM: number, climbM: number, climbSource: string | null) =>
    ctx.db.course.create({
      data: { eventId: ctx.eventId, name, lengthM, climbM, climbSource },
    });
  const long = await course("Long", 8420, 265, "computed");
  const typed = await course("Middle", 4100, 90, "manual");
  const flat = await course("Short", 2300, 0, null);
  const empty = await course("Empty", 0, 0, null);
  const gone = await ctx.db.course.create({
    data: { eventId: ctx.eventId, name: "Gone", lengthM: 5000, climbM: 100, removed: true },
  });
  const root = await course("Fork", 6100, 150, "computed");
  const variant = await ctx.db.course.create({
    data: {
      eventId: ctx.eventId, name: "Fork AB", lengthM: 6150, climbM: 160,
      parentCourseId: root.id, variantKey: "AB",
    },
  });
  const cls = (name: string, courseId: string | null) =>
    ctx.db.class.create({ data: { eventId: ctx.eventId, name, courseId } });
  const classes = {
    H21: await cls("H21", long.id),
    D21: await cls("D21", typed.id),
    H10: await cls("H10", flat.id),
    Open: await cls("Open", empty.id),
    None: await cls("None", null),
    Gone: await cls("Gone", gone.id),
    Fork: await cls("Fork", root.id),
  };
  for (const [name, c] of Object.entries(classes)) {
    await ctx.db.runner.create({
      data: {
        eventId: ctx.eventId, name: `Runner ${name}`, classId: c.id,
        ...(name === "Fork" ? { courseId: variant.id } : {}),
      },
    });
  }
  return ctx;
}

function coursesByClass(rows: ResultForUpload[]) {
  return Object.fromEntries(rows.map((r) => [r.className, r.course]));
}

const EXPECTED = {
  H21: { name: "Long", lengthM: 8420, climbM: 265 },
  D21: { name: "Middle", lengthM: 4100, climbM: 90 },
  H10: { name: "Short", lengthM: 2300, climbM: 0 },
  Open: undefined,
  None: undefined,
  Gone: undefined,
  Fork: { name: "Fork", lengthM: 6100, climbM: 150 },
};

describe("the class's course in the lists pushed to Eventor", () => {
  it("goes with the start list: stored length and climb, whatever the climb's source", async () => {
    const ctx = await seed("evp-start-courses");
    try {
      const out = await makeCaller(ctx.event).eventor.pushStartList();
      expect(out.runnerCount).toBe(7);
      const rows = vi.mocked(uploadStartList).mock.calls.at(-1)![4];
      expect(coursesByClass(rows)).toEqual(EXPECTED);
    } finally {
      await ctx.cleanup();
    }
  });

  it("goes with the results", async () => {
    const ctx = await seed("evp-result-courses");
    try {
      await makeCaller(ctx.event).eventor.pushResults();
      const rows = vi.mocked(uploadResults).mock.calls.at(-1)![4];
      expect(coursesByClass(rows)).toEqual(EXPECTED);
    } finally {
      await ctx.cleanup();
    }
  });

  it("a dry run uploads nothing", async () => {
    const ctx = await seed("evp-dry-run");
    try {
      await makeCaller(ctx.event).eventor.pushStartList({ dryRun: true });
      await makeCaller(ctx.event).eventor.pushResults({ dryRun: true });
      expect(uploadStartList).not.toHaveBeenCalled();
      expect(uploadResults).not.toHaveBeenCalled();
    } finally {
      await ctx.cleanup();
    }
  });
});
