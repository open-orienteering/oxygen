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
    // The public id is the primary punch code (was previously the per-event seq).
    expect(c.id).toBe(31);
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
      where: { eventId: ctx.eventId, codes: "32" },
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
      where: { eventId: ctx.eventId, codes: "40" },
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
      where: { eventId: ctx.eventId, codes: { in: ["41", "42"] } },
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

describe("control.recordProgramming", () => {
  it("persists battery + memory-cleared state on the control_units row", async () => {
    const c = await caller.control.create({ codes: "60" });
    const stationSerial = 600_001;
    await caller.control.recordProgramming({
      stationSerial,
      controlId: c.id,
      programmedCode: 60,
      firmwareVersion: "5.93",
      modelId: 105,
      modelName: "BS11-BL",
      batteryVoltage: 3210,
      batteryLow: false,
      memoryCleared: true,
    });

    const unit = await ctx.db.controlUnit.findUnique({
      where: {
        eventId_stationSerial: { eventId: ctx.eventId, stationSerial },
      },
    });
    expect(unit).not.toBeNull();
    expect(unit!.lastProgrammedCode).toBe(60);
    expect(unit!.firmwareVersion).toBe("5.93");
    expect(unit!.modelId).toBe(105);
    expect(unit!.modelName).toBe("BS11-BL");
    expect(unit!.batteryVoltageMv).toBe(3210);
    expect(unit!.batteryLow).toBe(false);
    expect(unit!.memoryClearedAt).not.toBeNull();
    expect(unit!.checkedAt).not.toBeNull();
    expect(unit!.lastSeenAt).not.toBeNull();
  });

  it("a second program call updates voltage in place without resetting memoryClearedAt", async () => {
    const c = await caller.control.create({ codes: "61" });
    const stationSerial = 600_002;
    await caller.control.recordProgramming({
      stationSerial,
      controlId: c.id,
      programmedCode: 61,
      memoryCleared: true,
    });
    const initial = await ctx.db.controlUnit.findUnique({
      where: {
        eventId_stationSerial: { eventId: ctx.eventId, stationSerial },
      },
    });
    const initialClearedAt = initial!.memoryClearedAt;
    expect(initialClearedAt).not.toBeNull();

    // Second call — no memoryCleared flag this time; voltage updates,
    // the cleared-at stamp stays put.
    await caller.control.recordProgramming({
      stationSerial,
      programmedCode: 61,
      batteryVoltage: 2870,
      batteryLow: true,
    });

    const after = await ctx.db.controlUnit.findUnique({
      where: {
        eventId_stationSerial: { eventId: ctx.eventId, stationSerial },
      },
    });
    expect(after!.batteryVoltageMv).toBe(2870);
    expect(after!.batteryLow).toBe(true);
    expect(after!.memoryClearedAt?.getTime()).toBe(initialClearedAt!.getTime());
  });

  it("accepts the explicit batteryVoltageMv field name", async () => {
    const c = await caller.control.create({ codes: "62" });
    const stationSerial = 600_003;
    await caller.control.recordProgramming({
      stationSerial,
      controlId: c.id,
      programmedCode: 62,
      batteryVoltageMv: 3140,
    });
    const unit = await ctx.db.controlUnit.findUnique({
      where: {
        eventId_stationSerial: { eventId: ctx.eventId, stationSerial },
      },
    });
    expect(unit!.batteryVoltageMv).toBe(3140);
  });

  it("rejects a voltage sent in volts instead of millivolts", async () => {
    const c = await caller.control.create({ codes: "63" });
    // The station reports 3.21 V. Passing that through unconverted used to
    // fail validation silently and lose the whole programming record.
    await expect(
      caller.control.recordProgramming({
        stationSerial: 600_004,
        controlId: c.id,
        programmedCode: 63,
        batteryVoltage: 3.21,
      }),
    ).rejects.toThrow();
    // A rounded volts value is an integer, so only the plausibility range
    // catches it.
    await expect(
      caller.control.recordProgramming({
        stationSerial: 600_005,
        controlId: c.id,
        programmedCode: 63,
        batteryVoltage: 3,
      }),
    ).rejects.toThrow();
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
  it("returns wall-clock plus optional NTP drift", async () => {
    const t = await caller.control.serverTime();
    expect(typeof t.now).toBe("number");
    expect(t.unixMs).toBe(t.now);
    // ntp fields are null when the Cloudflare probe is unreachable
    // (offline test env, firewall), or both populated when it succeeds.
    if (t.ntpDriftMs !== null) {
      expect(typeof t.ntpDriftMs).toBe("number");
      expect(typeof t.ntpSource).toBe("string");
    } else {
      expect(t.ntpSource).toBeNull();
    }
  });
});
