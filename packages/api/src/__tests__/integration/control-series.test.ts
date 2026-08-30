import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "crypto";
import {
  createTestEvent,
  type TestEventContext,
} from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";

const suffix = randomBytes(4).toString("hex");
let ctx: TestEventContext;
const seriesIds: string[] = [];

beforeAll(async () => {
  ctx = await createTestEvent("ctrl_series");
});

afterAll(async () => {
  if (seriesIds.length > 0) {
    await ctx.db.clubControlSeries.deleteMany({
      where: { id: { in: seriesIds } },
    });
  }
  await ctx.cleanup();
});

describe("club control series", () => {
  it("creates, lists, updates, and deletes a series", async () => {
    const caller = makeCaller();
    const created = await caller.controlSeries.createSeries({
      name: `Own ${suffix}`,
      notes: "home units",
    });
    seriesIds.push(created.id);
    expect(created.priority).toBeGreaterThan(0);

    const list = await caller.controlSeries.list();
    const row = list.find((s) => s.id === created.id);
    expect(row?.name).toBe(`Own ${suffix}`);
    expect(row?.counts).toEqual({ total: 0, active: 0, srr: 0 });
    expect(row?.controls).toEqual([]);

    await caller.controlSeries.updateSeries({
      id: created.id,
      name: `Renamed ${suffix}`,
      ownerName: "Neighbor",
      borrowed: true,
    });
    const updated = (await caller.controlSeries.list()).find((s) => s.id === created.id);
    expect(updated?.name).toBe(`Renamed ${suffix}`);
    expect(updated?.ownerName).toBe("Neighbor");
    expect(updated?.borrowed).toBe(true);

    await caller.controlSeries.deleteSeries({ id: created.id });
    seriesIds.splice(seriesIds.indexOf(created.id), 1);
    const gone = (await caller.controlSeries.list()).find((s) => s.id === created.id);
    expect(gone).toBeUndefined();
  });

  it("swaps priorities with moveSeries", async () => {
    const caller = makeCaller();
    const a = await caller.controlSeries.createSeries({ name: `A ${suffix}` });
    const b = await caller.controlSeries.createSeries({ name: `B ${suffix}` });
    seriesIds.push(a.id, b.id);
    expect(b.priority).toBeGreaterThan(a.priority);

    await caller.controlSeries.moveSeries({ id: b.id, direction: "up" });
    const list = await caller.controlSeries.list();
    const ia = list.findIndex((s) => s.id === a.id);
    const ib = list.findIndex((s) => s.id === b.id);
    expect(ib).toBeLessThan(ia);

    await caller.controlSeries.moveSeries({ id: b.id, direction: "down" });
    const list2 = await caller.controlSeries.list();
    expect(list2.findIndex((s) => s.id === a.id)).toBeLessThan(
      list2.findIndex((s) => s.id === b.id),
    );
  });

  it("bulk-inserts a range, skips duplicates, and rejects oversized spans", async () => {
    const caller = makeCaller();
    const s = await caller.controlSeries.createSeries({ name: `Range ${suffix}` });
    seriesIds.push(s.id);

    const first = await caller.controlSeries.addControls({
      seriesId: s.id,
      from: 31,
      to: 33,
    });
    expect(first).toEqual({ added: 3, skipped: 0 });

    const again = await caller.controlSeries.addControls({
      seriesId: s.id,
      from: 32,
      to: 34,
      type: "srr",
    });
    expect(again).toEqual({ added: 1, skipped: 2 });

    const listed = (await caller.controlSeries.list()).find((r) => r.id === s.id);
    expect(listed?.counts).toEqual({ total: 4, active: 4, srr: 1 });
    expect(listed?.controls.map((c) => c.code)).toEqual([31, 32, 33, 34]);
    expect(listed?.controls.find((c) => c.code === 34)?.type).toBe("srr");

    await expect(
      caller.controlSeries.addControls({
        seriesId: s.id,
        from: 1,
        to: 501,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("returns active-only allocation ordered by priority then code", async () => {
    const caller = makeCaller();
    const own = await caller.controlSeries.createSeries({ name: `AllocOwn ${suffix}` });
    const lent = await caller.controlSeries.createSeries({
      name: `AllocLent ${suffix}`,
      borrowed: true,
      ownerName: "Other",
    });
    seriesIds.push(own.id, lent.id);
    await caller.controlSeries.addControls({ seriesId: own.id, from: 31, to: 33 });
    await caller.controlSeries.addControls({ seriesId: lent.id, from: 40, to: 41 });
    const listed = (await caller.controlSeries.list()).find((r) => r.id === own.id);
    const c33 = listed?.controls.find((c) => c.code === 33);
    expect(c33).toBeDefined();
    await caller.controlSeries.updateControl({ id: c33!.id, type: "srr" });
    const c32 = listed?.controls.find((c) => c.code === 32);
    await caller.controlSeries.updateControl({ id: c32!.id, active: false });

    const alloc = await caller.controlSeries.allocation();
    const ours = alloc.filter(
      (e) => e.seriesId === own.id || e.seriesId === lent.id,
    );
    expect(ours.map((e) => e.code)).toEqual([31, 33, 40, 41]);
    expect(ours.find((e) => e.code === 33)?.type).toBe("srr");
    expect(ours.find((e) => e.code === 40)?.borrowed).toBe(true);
    expect(ours.find((e) => e.code === 31)?.borrowed).toBe(false);
  });

  it("cascade-deletes series controls", async () => {
    const caller = makeCaller();
    const s = await caller.controlSeries.createSeries({ name: `Cascade ${suffix}` });
    await caller.controlSeries.addControls({ seriesId: s.id, from: 50, to: 51 });
    const before = await ctx.db.clubSeriesControl.count({ where: { seriesId: s.id } });
    expect(before).toBe(2);
    await caller.controlSeries.deleteSeries({ id: s.id });
    const after = await ctx.db.clubSeriesControl.count({ where: { seriesId: s.id } });
    expect(after).toBe(0);
  });
});
