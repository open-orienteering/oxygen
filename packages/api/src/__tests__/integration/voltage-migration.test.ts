/**
 * Integration tests for the legacy voltage-encoding migration.
 *
 * Older Oxygen versions wrote SIAC battery voltage in two non-MeOS encodings:
 *   - oCard.Voltage: raw SIAC ADC byte (formula 1.9 + raw × 0.09)
 *   - oxygen_card_readouts.Voltage: hundredths of a volt
 *
 * MeOS itself writes integer millivolts (e.g. 2980 = 2.98 V), so applying the
 * raw-byte formula to a MeOS-written row produced absurd readings (~270 V) on
 * the cards page. The migration in `ensureReadoutTable` upgrades both columns
 * to millivolts on first use, then is cached as a no-op for the rest of the
 * process lifetime. It is also idempotent.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestDbContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";

let ctx: TestDbContext;
let caller: ReturnType<typeof makeCaller>;

const RAW_BYTE_CARD = 8100012; // legacy raw byte 12 → 2980 mV after migration
const MEOS_CARD = 8200013;     // already millivolts (2889) — must not change
const HUNDREDTHS_CARD = 8300011; // legacy hundredths 289 → 2890 mV after migration
const ZERO_CARD = 8500000;     // not measured

let rawByteCardId: number;
let meosCardId: number;
let zeroCardId: number;

beforeAll(async () => {
  ctx = await createTestDb("voltagemigration");
  caller = makeCaller({ dbName: ctx.dbName });

  // Seed legacy data BEFORE any read path triggers ensureReadoutTable, so the
  // first cardList call exercises the migration end-to-end.
  const rawByteCard = await ctx.client.oCard.create({
    data: {
      CardNo: RAW_BYTE_CARD,
      Punches: "31-100.0;32-200.0;",
      ReadId: 1,
      Voltage: 12, // legacy raw byte
    },
  });
  rawByteCardId = rawByteCard.Id;

  const meosCard = await ctx.client.oCard.create({
    data: {
      CardNo: MEOS_CARD,
      Punches: "31-100.0;32-200.0;",
      ReadId: 2,
      Voltage: 2889, // MeOS millivolts
    },
  });
  meosCardId = meosCard.Id;

  const zeroCard = await ctx.client.oCard.create({
    data: {
      CardNo: ZERO_CARD,
      Punches: "31-100.0;",
      ReadId: 99,
      Voltage: 0,
    },
  });
  zeroCardId = zeroCard.Id;

  // Pre-create the readout-history table so we can seed legacy hundredths into
  // it before the migration runs. The schema mirrors ensureReadoutTable() —
  // the migration is what we're testing, not the CREATE TABLE.
  await ctx.client.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS oxygen_card_readouts (
      Id         INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      CardNo     INT NOT NULL,
      CardType   VARCHAR(10) NOT NULL DEFAULT '',
      Punches    VARCHAR(3040) NOT NULL DEFAULT '',
      Voltage    INT UNSIGNED NOT NULL DEFAULT 0,
      OwnerData  TEXT NULL,
      Metadata   TEXT NULL,
      ReadAt     TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_cardno (CardNo),
      INDEX idx_readat (ReadAt)
    )
  `);
  await ctx.client.$executeRawUnsafe(
    `INSERT INTO oxygen_card_readouts (CardNo, CardType, Punches, Voltage)
     VALUES (?, 'SIAC', '31-100.0;', 289)`, // 289 hundredths = 2.89 V
    HUNDREDTHS_CARD,
  );
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("voltage migration", () => {
  it("upgrades raw-byte oCard.Voltage rows to millivolts on first cardList call", async () => {
    const list = await caller.cardReadout.cardList();
    const row = list.find((c) => c.id === rawByteCardId);
    expect(row, "card row should be returned").toBeDefined();
    expect(row?.batteryVoltage).toBeCloseTo(2.98, 5);

    // Verify the column itself was rewritten (so MeOS reads it correctly too).
    const stored = await ctx.client.oCard.findUnique({ where: { Id: rawByteCardId } });
    expect(stored?.Voltage).toBe(2980);
  });

  it("leaves MeOS-written millivolt rows alone", async () => {
    const list = await caller.cardReadout.cardList();
    const row = list.find((c) => c.id === meosCardId);
    expect(row?.batteryVoltage).toBeCloseTo(2.889, 5);

    const stored = await ctx.client.oCard.findUnique({ where: { Id: meosCardId } });
    expect(stored?.Voltage).toBe(2889);
  });

  it("upgrades legacy hundredths-of-a-volt rows in the readout history table", async () => {
    const history = await caller.cardReadout.readoutHistory({ cardNo: HUNDREDTHS_CARD });
    expect(history).toHaveLength(1);
    expect(history[0].batteryVoltage).toBeCloseTo(2.89, 5);
  });

  it("ignores the Voltage=0 'not measured' sentinel (returns null)", async () => {
    const list = await caller.cardReadout.cardList();
    const row = list.find((c) => c.id === zeroCardId);
    expect(row?.batteryVoltage).toBeNull();
  });
});
