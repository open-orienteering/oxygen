/**
 * The J13 migration (user answer 11; docs/course-layer.md §6.4 "J13 reset"): every stored corridor `whiteOpacity`
 * below 1 becomes 1 in `courses.structure`, top-level legs and legs inside a variation's alternatives alike, so old
 * maps print as before once a translucent band draws. On a scratch database built up to the migration before it,
 * run the way Prisma runs it (one transaction); a second run changes nothing.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";
import { course } from "@oxygen/shared";

const MIGRATIONS = resolve(__dirname, "../../../prisma/migrations");
const J13 = "20261119140000_corridor_white_opacity_reset";

const testUrl = new URL(process.env.DATABASE_URL!);
testUrl.searchParams.delete("schema");
const scratchName = `${testUrl.pathname.replace(/^\//, "")}_j13corridor`;
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

async function applyJ13(): Promise<void> {
  const sql = readFileSync(resolve(MIGRATIONS, J13, "migration.sql"), "utf8");
  await db.query("BEGIN");
  try {
    await db.query(sql);
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  }
}

const S = "00000000-0000-7000-8000-000000000001", A = "00000000-0000-7000-8000-000000000002", B = "00000000-0000-7000-8000-000000000003", F = "00000000-0000-7000-8000-000000000004";
const corridor = (whiteOpacity: number) => ({ widthM: 60, edge: true, whiteMm: 3, whiteOpacity });
const structures = {
  top: { version: 1, id: "c1", orderMode: "ordered", items: [{ siteId: S }, { siteId: A, leg: { style: "line", corridor: corridor(0.5), bends: [{ x: 1, y: 2 }] } }, { siteId: F, leg: { corridor: corridor(1) } }] },
  alt: {
    version: 1, id: "c2", orderMode: "ordered",
    items: [
      { siteId: S }, { siteId: A },
      { kind: "variation", id: "v1", alternatives: [{ label: "A", items: [{ siteId: B, leg: { corridor: corridor(0) } }] }, { label: "B", items: [] }] },
      { siteId: F, leg: { corridor: corridor(0.25) } },
    ],
  },
  opaque: { version: 1, id: "c3", orderMode: "ordered", items: [{ siteId: S }, { siteId: A, leg: { corridor: corridor(1) } }] },
  plain: { version: 1, id: "c4", orderMode: "ordered", items: [{ siteId: S }, { siteId: A, leg: { style: "none" } }] },
};
const rows: Record<string, string> = {};

beforeAll(async () => {
  await admin(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
    await c.query(`CREATE DATABASE "${scratchName}"`);
  });
  db = new Client({ connectionString: scratchUrl.toString() });
  await db.connect();
  const before = readdirSync(MIGRATIONS, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name < J13).map((d) => d.name).sort();
  await db.query("SET search_path TO oxygen");
  for (const m of before) await db.query(readFileSync(resolve(MIGRATIONS, m, "migration.sql"), "utf8"));
  const live = (await db.query("INSERT INTO events (name_id, name, date) VALUES ('j13_live', 'Live', '2026-11-19') RETURNING id")).rows[0].id;
  const removed = (await db.query("INSERT INTO events (name_id, name, date, removed) VALUES ('j13_removed', 'Removed', '2026-11-19', true) RETURNING id")).rows[0].id;
  const insert = async (name: string, event: string, structure: unknown) =>
    (rows[name] = (await db.query("INSERT INTO courses (event_id, name, structure) VALUES ($1, $2, $3) RETURNING id", [event, name, structure === null ? null : JSON.stringify(structure)])).rows[0].id);
  for (const [name, s] of Object.entries(structures)) await insert(name, live, s);
  await insert("none", live, null);
  await insert("removed", removed, structures.top);
}, 120_000);

afterAll(async () => {
  await db?.end();
  await admin((c) => c.query(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`));
}, 60_000);

const structureOf = async (name: string) => (await db.query("SELECT structure FROM courses WHERE id = $1", [rows[name]])).rows[0].structure;
const updatedAt = async (name: string) => (await db.query("SELECT updated_at FROM courses WHERE id = $1", [rows[name]])).rows[0].updated_at as Date;

describe("J13 migration: corridor white opacity reset to 1", () => {
  it("resets every value below 1, top-level and inside alternatives, soft-deleted events included; nothing else changes; a second run is a no-op", async () => {
    const untouched = { opaque: await updatedAt("opaque"), plain: await updatedAt("plain") };
    await applyJ13();
    const set = (s: typeof structures.top | typeof structures.alt, opacity = 1) => JSON.parse(JSON.stringify(s).replace(/"whiteOpacity":[0-9.]+/g, `"whiteOpacity":${opacity}`));
    expect(await structureOf("top")).toEqual(set(structures.top));
    expect(await structureOf("alt")).toEqual(set(structures.alt));
    expect(await structureOf("removed")).toEqual(set(structures.top));
    expect(await structureOf("opaque")).toEqual(structures.opaque);
    expect(await structureOf("plain")).toEqual(structures.plain);
    expect(await structureOf("none")).toBeNull();
    // Rows with nothing to reset are not rewritten.
    expect(await updatedAt("opaque")).toEqual(untouched.opaque);
    expect(await updatedAt("plain")).toEqual(untouched.plain);
    // The result is still a valid structure.
    for (const name of ["top", "alt"]) expect(course.courseStructureSchema.safeParse(await structureOf(name)).success).toBe(true);
    // The function is gone; a second run changes nothing.
    expect((await db.query("SELECT 1 FROM pg_proc WHERE proname = 'j13_reset_corridor_opacity'")).rowCount).toBe(0);
    const after = await structureOf("alt");
    await applyJ13();
    expect(await structureOf("alt")).toEqual(after);
  });
});
