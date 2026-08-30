import { randomUUID } from "crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestEvent,
  disconnect,
  type TestEventContext,
} from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";

let ctx: TestEventContext;
let caller: ReturnType<typeof makeCaller>;
const prefix = `Preset-${randomUUID()}`;

beforeAll(async () => {
  ctx = await createTestEvent("class-presets");
  caller = makeCaller(ctx.event);
});

afterAll(async () => {
  await ctx.db.clubClassPreset.deleteMany({
    where: { name: { startsWith: prefix } },
  });
  await ctx.cleanup();
  await disconnect();
});

describe("classPreset CRUD", () => {
  it("creates, lists, updates, and deletes presets", async () => {
    const later = await caller.classPreset.create({
      name: `${prefix}-Later`,
      sex: "F",
      lowAge: 18,
      highAge: 34,
      classType: "Elite",
      noTiming: true,
      freeStart: true,
      allowQuickEntry: true,
      sortIndex: 20,
    });
    const earlier = await caller.classPreset.create({
      name: `${prefix}-Earlier`,
      sortIndex: 10,
    });

    const rows = (await caller.classPreset.list()).filter((row) =>
      row.name.startsWith(prefix),
    );
    expect(rows.map((row) => row.id)).toEqual([earlier.id, later.id]);
    expect(later).toMatchObject({
      sex: "F",
      lowAge: 18,
      highAge: 34,
      classType: "Elite",
      noTiming: true,
      freeStart: true,
      allowQuickEntry: true,
    });

    const updated = await caller.classPreset.update({
      id: later.id,
      name: `${prefix}-Renamed`,
      classType: "Open",
    });
    expect(updated).toMatchObject({
      name: `${prefix}-Renamed`,
      classType: "Open",
      sex: "F",
    });

    await caller.classPreset.delete({ id: earlier.id });
    expect(
      (await caller.classPreset.list()).some((row) => row.id === earlier.id),
    ).toBe(false);
  });

  it("returns CONFLICT for create and rename collisions", async () => {
    const nameA = `${prefix}-Conflict-A`;
    const nameB = `${prefix}-Conflict-B`;
    const a = await caller.classPreset.create({ name: nameA });
    const b = await caller.classPreset.create({ name: nameB });
    await expect(caller.classPreset.create({ name: nameA })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(
      caller.classPreset.update({ id: b.id, name: nameA }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(a.id).not.toBe(b.id);
  });

  it("restricts preset sex without narrowing legacy event-class routes", async () => {
    await expect(
      caller.classPreset.create({
        name: `${prefix}-Invalid-sex`,
        // @ts-expect-error exercising runtime validation of untrusted input
        sex: "W",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const legacy = await caller.class.create({
      name: `${prefix}-Legacy-sex`,
      sex: "W",
    });
    expect((await caller.class.getById({ id: legacy.id })).sex).toBe("W");
  });
});

describe("class.createFromPresets", () => {
  it("copies every setting, skips existing names, and journals each create", async () => {
    const existingName = `${prefix}-Existing`;
    await caller.class.create({ name: existingName });
    const skipped = await caller.classPreset.create({
      name: existingName,
      sortIndex: 2,
    });
    const copied = await caller.classPreset.create({
      name: `${prefix}-Copied`,
      sex: "M",
      lowAge: 21,
      highAge: 39,
      classType: "Championship",
      noTiming: true,
      freeStart: true,
      allowQuickEntry: true,
      sortIndex: 7,
    });
    const before = await ctx.db.journalEntry.count({
      where: { eventId: ctx.eventId, type: "class.upserted" },
    });

    const result = await caller.class.createFromPresets({
      presetIds: [copied.id, skipped.id],
    });
    expect(result).toEqual({ created: 1, skipped: [existingName] });

    const again = await caller.class.createFromPresets({
      presetIds: [copied.id, skipped.id],
    });
    expect(again).toEqual({ created: 0, skipped: [existingName, copied.name] });

    const row = await ctx.db.class.findFirstOrThrow({
      where: { eventId: ctx.eventId, name: copied.name },
    });
    expect(row).toMatchObject({
      sex: "M",
      lowAge: 21,
      highAge: 39,
      classType: "Championship",
      classFeeCents: 0,
      noTiming: true,
      freeStart: true,
      allowQuickEntry: true,
      maxTime: 0,
      sortIndex: 7,
      courseId: null,
    });
    const after = await ctx.db.journalEntry.count({
      where: { eventId: ctx.eventId, type: "class.upserted" },
    });
    expect(after - before).toBe(1);
  });

  it("rejects an unknown preset without creating classes", async () => {
    const before = await ctx.db.class.count({ where: { eventId: ctx.eventId } });
    await expect(
      caller.class.createFromPresets({ presetIds: [randomUUID()] }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      await ctx.db.class.count({ where: { eventId: ctx.eventId } }),
    ).toBe(before);
  });
});
