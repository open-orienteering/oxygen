/**
 * Package 8 (RES-08, DB-12): the `fix_backup_punch_time_base` migration turns
 * backup-memory punches (and the `manual` mirrors of pushed ones) from clock
 * time into ZeroTime-relative time. Card, radio and other manual punches are
 * not touched. Run on a scratch database built up to the migration before,
 * the way Prisma runs it (one transaction).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";

const MIGRATIONS = resolve(__dirname, "../../../prisma/migrations");
const FIX = "20261126150100_fix_backup_punch_time_base";

const testUrl = new URL(process.env.DATABASE_URL!);
testUrl.searchParams.delete("schema");
const scratchName = `${testUrl.pathname.replace(/^\//, "")}_p8backup`;
const scratchUrl = new URL(testUrl.toString());
scratchUrl.pathname = `/${scratchName}`;

let db: Client;

async function admin<T>(f: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: testUrl.toString() });
  await c.connect();
  try {
    return await f(c);
  } finally {
    await c.end();
  }
}

const H = 36_000;
const ids: Record<string, string> = {};

beforeAll(async () => {
  await admin(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
    await c.query(`CREATE DATABASE "${scratchName}"`);
  });
  db = new Client({ connectionString: scratchUrl.toString() });
  await db.connect();
  const before = readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name < FIX)
    .map((d) => d.name)
    .sort();
  await db.query("SET search_path TO oxygen");
  for (const m of before) await db.query(readFileSync(resolve(MIGRATIONS, m, "migration.sql"), "utf8"));
  // ZeroTime 08:00 so the shift is visible.
  const ev = (await db.query("INSERT INTO events (name_id, name, date, zero_time) VALUES ('p8', 'P8', '2026-11-26', $1) RETURNING id", [8 * H])).rows[0].id;
  const punch = async (name: string, source: string, time: number, isOriginal = true, control = 31) =>
    (ids[name] = (
      await db.query(
        "INSERT INTO punches (event_id, card_no, control_code, time, source, is_original) VALUES ($1, 500, $2, $3, $4, $5) RETURNING id",
        [ev, control, time, source, isOriginal],
      )
    ).rows[0].id);
  // A pushed backup punch at 10:15 (clock time, the old bug) and its mirror.
  await punch("pushed", "backup_memory", 10 * H + 9000, false);
  await punch("mirror", "manual", 10 * H + 9000);
  // An un-pushed backup punch at 11:00, and one with no time.
  await punch("unpushed", "backup_memory", 11 * H, true, 32);
  await punch("zero", "backup_memory", 0, true, 33);
  // Correct rows that must stay: a card punch, a manual punch with no backup twin.
  await punch("card", "card", 2 * H);
  await punch("manualOnly", "manual", 3 * H, true, 34);
}, 120_000);

afterAll(async () => {
  await db?.end();
  await admin((c) => c.query(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`));
}, 60_000);

const timeOf = async (name: string) => (await db.query("SELECT time FROM punches WHERE id = $1", [ids[name]])).rows[0].time as number;

describe("fix_backup_punch_time_base migration", () => {
  it("shifts backup rows and their mirrors to ZeroTime-relative, nothing else", async () => {
    const sql = readFileSync(resolve(MIGRATIONS, FIX, "migration.sql"), "utf8");
    await db.query("BEGIN");
    await db.query(sql);
    await db.query("COMMIT");
    expect(await timeOf("pushed")).toBe(2 * H + 9000);
    expect(await timeOf("mirror")).toBe(2 * H + 9000);
    expect(await timeOf("unpushed")).toBe(3 * H);
    expect(await timeOf("zero")).toBe(0);
    expect(await timeOf("card")).toBe(2 * H);
    expect(await timeOf("manualOnly")).toBe(3 * H);
  });
});
