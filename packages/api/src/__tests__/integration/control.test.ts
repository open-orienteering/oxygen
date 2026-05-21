/**
 * Integration tests for the control tRPC router — CRUD plus the
 * config-upsert + control-unit linkage flow that ControlsPage drives.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestEvent,
  disconnect,
  type TestEventContext,
} from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";

let ctx: TestEventContext;
let caller: ReturnType<typeof makeCaller>;

beforeAll(async () => {
  ctx = await createTestEvent("control");
  caller = makeCaller(ctx.event);
});

afterAll(async () => {
  await ctx.cleanup();
  await disconnect();
});

describe("control.create / update / delete", () => {
  it("creates a control and exposes it through list / detail", async () => {
    const c = await caller.control.create({ codes: "31", name: "Top of hill" });
    expect(c.id).toBe(1);
    const list = await caller.control.list();
    const item = list.find((x) => x.id === c.id);
    expect(item?.codes).toBe("31");
    expect(item?.name).toBe("Top of hill");

    const detail = await caller.control.detail({ id: c.id });
    expect(detail.codes).toBe("31");
  });

  it("updates the radioType / airPlus toggle via update()", async () => {
    const c = await caller.control.create({ codes: "32" });
    await caller.control.update({
      id: c.id,
      radioType: "internal_radio",
      airPlus: "on",
    });
    // The aggregate `detail.config` only surfaces when at least one
    // station unit is attached, so verify the underlying column writes
    // directly. Aggregate behaviour is exercised in the stationSerial
    // sub-suite below.
    const row = await ctx.db.control.findFirst({
      where: { eventId: ctx.eventId, seq: c.id },
      select: { radioType: true, airPlus: true },
    });
    expect(row?.radioType).toBe("internal_radio");
    expect(row?.airPlus).toBe("on");
  });

  it("soft-deletes a control", async () => {
    const c = await caller.control.create({ codes: "33" });
    await caller.control.delete({ id: c.id });
    const list = await caller.control.list();
    expect(list.find((x) => x.id === c.id)).toBeUndefined();
  });
});

describe("control.upsertConfig", () => {
  it("rejects calls without controlId or controlIds", async () => {
    await expect(caller.control.upsertConfig({})).rejects.toThrow(
      /controlId or controlIds/i,
    );
  });

  it("applies radioType + airPlus to a single control", async () => {
    const c = await caller.control.create({ codes: "40" });
    await caller.control.upsertConfig({
      controlId: c.id,
      radioType: "public_radio",
      airPlus: "off",
    });
    const row = await ctx.db.control.findFirst({
      where: { eventId: ctx.eventId, seq: c.id },
      select: { radioType: true, airPlus: true },
    });
    expect(row?.radioType).toBe("public_radio");
    expect(row?.airPlus).toBe("off");
  });

  it("applies the same patch to many controls via controlIds", async () => {
    const a = await caller.control.create({ codes: "41" });
    const b = await caller.control.create({ codes: "42" });
    await caller.control.upsertConfig({
      controlIds: [a.id, b.id],
      radioType: "internal_radio",
    });
    const rows = await ctx.db.control.findMany({
      where: { eventId: ctx.eventId, seq: { in: [a.id, b.id] } },
      select: { radioType: true },
    });
    expect(rows.map((r) => r.radioType)).toEqual([
      "internal_radio",
      "internal_radio",
    ]);
  });

  it("links a control to a station serial via stationSerial", async () => {
    const c = await caller.control.create({ codes: "50" });
    await caller.control.upsertConfig({ controlId: c.id, stationSerial: 12345 });
    const detail = await caller.control.detail({ id: c.id });
    expect(detail.units.length).toBe(1);
    expect(detail.units[0].stationSerial).toBe(12345);
  });

  it("clears the station serial linkage when stationSerial is null", async () => {
    const c = await caller.control.create({ codes: "51" });
    await caller.control.upsertConfig({ controlId: c.id, stationSerial: 99 });
    await caller.control.upsertConfig({
      controlId: c.id,
      stationSerial: null,
    });
    const detail = await caller.control.detail({ id: c.id });
    expect(detail.units.length).toBe(0);
  });
});

describe("control.getAirPlusConfig / setAirPlusConfig", () => {
  it("round-trips the event-level AIR+ defaults", async () => {
    const before = await caller.control.getAirPlusConfig();
    expect(typeof before.airPlusEnabled).toBe("boolean");
    expect(typeof before.awakeHours).toBe("number");

    await caller.control.setAirPlusConfig({
      airPlus: true,
      awakeHours: 10,
    });
    const after = await caller.control.getAirPlusConfig();
    expect(after.airPlusEnabled).toBe(true);
    expect(after.awakeHours).toBe(10);
  });
});

describe("control.serverTime", () => {
  it("returns wall-clock plus null ntp drift", async () => {
    const t = await caller.control.serverTime();
    expect(typeof t.now).toBe("number");
    expect(t.unixMs).toBe(t.now);
    expect(t.ntpDriftMs).toBeNull();
    expect(t.ntpSource).toBeNull();
  });
});
