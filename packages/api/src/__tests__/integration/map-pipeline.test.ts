/**
 * The per-event map pipeline switch and its instance flags
 * (docs/map-pipeline-switch.md): the column's default for rows written
 * without it, new events taking `map.pipeline.default`, the read/write
 * procedures, and `allowLegacy` refusing a switch back.
 */

import { describe, it, expect, afterAll, afterEach } from "vitest";
import { TRPCError } from "@trpc/server";
import { disconnect } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { prisma, resolveEvent, setSetting, type EventRef } from "../../db.js";
import { MAP_PIPELINE_SETTINGS, clearMapPipelineFlagsCache } from "../../map-pipeline.js";

const created: string[] = [];

function slug(tag: string): string {
  return `oxygen_test_pipeline_${tag}_${Math.random().toString(36).slice(2, 8)}`;
}

async function setFlags(def: string | null, allowLegacy: string | null): Promise<void> {
  await setSetting(MAP_PIPELINE_SETTINGS.default, def);
  await setSetting(MAP_PIPELINE_SETTINGS.allowLegacy, allowLegacy);
  clearMapPipelineFlagsCache();
}

async function createEvent(tag: string): Promise<EventRef> {
  const nameId = slug(tag);
  await makeCaller(null).event.create({ name: `Pipeline ${tag}`, nameId, date: "2026-10-22" });
  created.push(nameId);
  return (await resolveEvent(nameId))!;
}

afterEach(async () => {
  await setFlags(null, null);
});

afterAll(async () => {
  await prisma().event.deleteMany({ where: { nameId: { in: created } } });
  await disconnect();
});

describe("events.map_pipeline", () => {
  it("is legacy for a row written without it (existing events)", async () => {
    const nameId = slug("raw");
    const row = await prisma().event.create({
      data: { nameId, name: "Raw row", date: new Date("2026-10-22") },
    });
    created.push(nameId);
    expect(row.mapPipeline).toBe("legacy");
  });

  it("new events take map.pipeline.default (legacy when unset)", async () => {
    const unset = await createEvent("unset");
    expect(await makeCaller(unset).event.mapPipeline()).toEqual({ pipeline: "legacy", allowLegacy: true });

    await setFlags("vector", null);
    const vector = await createEvent("vector");
    expect(await makeCaller(vector).event.mapPipeline()).toEqual({ pipeline: "vector", allowLegacy: true });
    // An existing event keeps its value when the default changes.
    expect((await makeCaller(unset).event.mapPipeline()).pipeline).toBe("legacy");
  });

  it("setMapPipeline switches the event both ways while allowLegacy", async () => {
    const ev = await createEvent("toggle");
    const caller = makeCaller(ev);
    expect(await caller.event.setMapPipeline({ pipeline: "vector" })).toEqual({
      pipeline: "vector",
      allowLegacy: true,
    });
    const row = await prisma().event.findUnique({ where: { id: ev.id }, select: { mapPipeline: true } });
    expect(row?.mapPipeline).toBe("vector");
    expect((await caller.event.setMapPipeline({ pipeline: "legacy" })).pipeline).toBe("legacy");
  });

  it("refuses a switch to legacy once allowLegacy is false; vector stays allowed", async () => {
    const ev = await createEvent("nolegacy");
    const caller = makeCaller(ev);
    await setFlags(null, "false");
    expect(await caller.event.mapPipeline()).toEqual({ pipeline: "legacy", allowLegacy: false });
    await expect(caller.event.setMapPipeline({ pipeline: "vector" })).resolves.toMatchObject({
      pipeline: "vector",
    });
    const err = await caller.event.setMapPipeline({ pipeline: "legacy" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("PRECONDITION_FAILED");
    expect((await caller.event.mapPipeline()).pipeline).toBe("vector");
  });

  it("rejects an unknown value at the boundary", async () => {
    const ev = await createEvent("zod");
    await expect(
      makeCaller(ev).event.setMapPipeline({ pipeline: "tiles" as "legacy" }),
    ).rejects.toThrow();
  });
});
