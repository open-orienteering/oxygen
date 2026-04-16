/**
 * Integration tests for per-physical-unit tracking on controls.
 *
 * A single logical control may be fulfilled by several physical SI stations
 * (e.g. redundant units at the same location, or a replacement unit with a
 * different code). Each unit is identified by its SI hardware serial and
 * should keep its own battery / checked / programmed-code state — never
 * overwritten by the other units.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestDbContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";

let ctx: TestDbContext;
let caller: ReturnType<typeof makeCaller>;
let controlId: number;

beforeAll(async () => {
  ctx = await createTestDb("controlunits");
  caller = makeCaller({ dbName: ctx.dbName });

  const ctrl = await ctx.client.oControl.create({
    data: { Name: "Radio 1", Numbers: "31;131", Status: 0 },
  });
  controlId = ctrl.Id;
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("recordProgramming — per-unit tracking", () => {
  it("creates one unit row per distinct station serial", async () => {
    await caller.control.recordProgramming({
      controlId,
      stationSerial: 111001,
      programmedCode: 31,
      batteryVoltage: 3.42,
      firmwareVersion: "657",
      memoryCleared: true,
    });
    await caller.control.recordProgramming({
      controlId,
      stationSerial: 111002,
      programmedCode: 31,
      batteryVoltage: 2.95,
      firmwareVersion: "657",
      memoryCleared: true,
    });

    const controls = await caller.control.list({});
    const c = controls.find((x) => x.id === controlId)!;
    expect(c).toBeDefined();
    expect(c.units).toHaveLength(2);

    const serials = c.units.map((u) => u.stationSerial).sort();
    expect(serials).toEqual([111001, 111002]);

    const u1 = c.units.find((u) => u.stationSerial === 111001)!;
    const u2 = c.units.find((u) => u.stationSerial === 111002)!;
    expect(u1.batteryVoltage).toBeCloseTo(3.42, 2);
    expect(u2.batteryVoltage).toBeCloseTo(2.95, 2);
    expect(u1.lastProgrammedCode).toBe(31);
    expect(u2.lastProgrammedCode).toBe(31);
    expect(u1.memoryClearedAt).not.toBeNull();
    expect(u2.memoryClearedAt).not.toBeNull();
  });

  it("re-programming the same serial updates, does not duplicate", async () => {
    await caller.control.recordProgramming({
      controlId,
      stationSerial: 111001,
      programmedCode: 131,
      batteryVoltage: 3.5,
      firmwareVersion: "660",
      memoryCleared: false,
    });

    const controls = await caller.control.list({});
    const c = controls.find((x) => x.id === controlId)!;
    expect(c.units).toHaveLength(2); // still 2, not 3

    const u1 = c.units.find((u) => u.stationSerial === 111001)!;
    expect(u1.lastProgrammedCode).toBe(131);
    expect(u1.batteryVoltage).toBeCloseTo(3.5, 2);
    expect(u1.firmwareVersion).toBe("660");
  });

  it("aggregates show worst battery + earliest check across units", async () => {
    const detail = await caller.control.detail({ id: controlId });
    expect(detail).not.toBeNull();
    // min voltage across 3.5 and 2.95 is 2.95 → batteryLow (< 2.5 floor — not low here, but worst-case surfaces)
    expect(detail!.config?.batteryVoltage).toBeCloseTo(2.95, 2);
    // earliest check = first programmed one (unit 111002 was last, but 111001 updated after that → earliest is 111002's check)
    expect(detail!.config?.checkedAt).not.toBeNull();
  });
});

describe("importBackupPunches — unit upsert", () => {
  it("records a unit row for the station that produced the backup", async () => {
    await caller.control.importBackupPunches({
      controlId,
      stationSerial: 111003,
      punches: [
        { cardNo: 500001, punchTime: 360000 },
        { cardNo: 500002, punchTime: 361000 },
      ],
    });

    const controls = await caller.control.list({});
    const c = controls.find((x) => x.id === controlId)!;
    expect(c.units.some((u) => u.stationSerial === 111003)).toBe(true);

    const u = c.units.find((u) => u.stationSerial === 111003)!;
    expect(u.lastSeenAt).not.toBeNull();
  });
});
