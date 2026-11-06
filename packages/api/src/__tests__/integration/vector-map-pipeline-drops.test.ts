/**
 * The E5 drops migration (v0.6.1; docs/migrations/2026-vector-map-pipeline.md):
 * its guard and what it drops.
 *
 * `global-setup` has already applied every migration to the shared test
 * database, so the guard is exercised on a scratch database built up to
 * the migration before E5 (each earlier `migration.sql`, in order), seeded
 * with v0.6.0-shaped rows, then given the E5 file the way Prisma runs it:
 * one transaction, all or nothing.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";

const MIGRATIONS = resolve(__dirname, "../../../prisma/migrations");
const E5 = "20261107120000_vector_map_pipeline_drops";

const testUrl = new URL(process.env.DATABASE_URL!);
testUrl.searchParams.delete("schema");
const scratchName = `${testUrl.pathname.replace(/^\//, "")}_e5drops`;
const scratchUrl = new URL(testUrl.toString());
scratchUrl.pathname = `/${scratchName}`;

let db: Client;
let liveEvent: string;
let removedEvent: string;

async function admin<T>(f: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: testUrl.toString() });
  await c.connect();
  try {
    return await f(c);
  } finally {
    await c.end();
  }
}

/** Run the E5 migration as Prisma does: the whole file in one transaction. */
async function applyE5(): Promise<void> {
  const sql = readFileSync(resolve(MIGRATIONS, E5, "migration.sql"), "utf8");
  await db.query("BEGIN");
  try {
    await db.query(sql);
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  }
}

const tableExists = async (t: string) =>
  (await db.query("SELECT to_regclass($1) AS r", [`oxygen.${t}`])).rows[0].r !== null;
const columns = async (t: string) =>
  (await db.query<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'oxygen' AND table_name = $1",
    [t],
  )).rows.map((r) => r.column_name);

beforeAll(async () => {
  await admin(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
    await c.query(`CREATE DATABASE "${scratchName}"`);
  });
  db = new Client({ connectionString: scratchUrl.toString() });
  await db.connect();
  const before = readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name < E5)
    .map((d) => d.name)
    .sort();
  // As Prisma runs them: the URL's `?schema=oxygen` is the search path.
  await db.query("SET search_path TO oxygen");
  for (const m of before) await db.query(readFileSync(resolve(MIGRATIONS, m, "migration.sql"), "utf8"));

  liveEvent = (await db.query("INSERT INTO events (name_id, name, date) VALUES ('e5_live', 'Live', '2026-11-07') RETURNING id")).rows[0].id;
  removedEvent = (await db.query("INSERT INTO events (name_id, name, date, removed) VALUES ('e5_removed', 'Removed', '2026-11-07', true) RETURNING id")).rows[0].id;
  // A live event's map with its source (the state the backfill leaves).
  await db.query("INSERT INTO map_sources (file_hash, kind, bytes, size_bytes, file_name) VALUES ($1, 'ocad', '\\x01', 1, 'live.ocd')", ["a".repeat(64)]);
  await db.query("INSERT INTO map_files (event_id, file_name, file_data, source_hash) VALUES ($1, 'live.ocd', '\\x01', $2)", [liveEvent, "a".repeat(64)]);
  // A soft-deleted event's map that never got a source (production at E0).
  await db.query("INSERT INTO map_files (event_id, file_name, file_data) VALUES ($1, 'tombstone.ocd', '\\x02')", [removedEvent]);
  // A live event's map without a source: the guard must stop the drop.
  await db.query("INSERT INTO map_files (event_id, file_name, file_data) VALUES ($1, 'unsourced.ocd', '\\x03')", [liveEvent]);
  // A legacy club map not linked to a series.
  await db.query("INSERT INTO club_map_files (name, file_name, file_data, size_bytes) VALUES ('Unlinked', 'club.ocd', '\\x04', 1)");
  await db.query("INSERT INTO courses (event_id, name, geometry, geometry_source, length_source) VALUES ($1, 'A', '{}', 'editor', 'derived')", [liveEvent]);
}, 120_000);

afterAll(async () => {
  await db?.end();
  await admin((c) => c.query(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`));
}, 60_000);

describe("E5 drops migration", () => {
  it("fails on a live event's map without source_hash and changes nothing", async () => {
    await expect(applyE5()).rejects.toThrow(/E5 guard: 1 map_files row\(s\) of live events have no source_hash/);
    expect(await tableExists("map_tiles")).toBe(true);
    expect(await tableExists("club_map_files")).toBe(true);
    expect(await columns("map_files")).toContain("file_data");
  });

  it("fails on a club map without its series", async () => {
    await db.query("DELETE FROM map_files WHERE file_name = 'unsourced.ocd'");
    await expect(applyE5()).rejects.toThrow(/E5 guard: 1 club_map_files row\(s\) have no club_map_id/);
    expect(await tableExists("club_map_files")).toBe(true);
  });

  it("passes when only a soft-deleted event's map lacks a source, and drops what E5 names", async () => {
    const series = (await db.query("INSERT INTO club_maps (name) VALUES ('Unlinked') RETURNING id")).rows[0].id;
    await db.query("UPDATE club_map_files SET club_map_id = $1", [series]);
    await applyE5();

    for (const t of ["map_tiles", "rendered_maps", "club_map_files"]) expect(await tableExists(t)).toBe(false);
    const mapFiles = await columns("map_files");
    for (const c of ["file_data", "render_key", "file_hash", "color_profile", "color_overrides", "north_lines_below"]) expect(mapFiles).not.toContain(c);
    expect(mapFiles).toEqual(expect.arrayContaining(["source_hash", "document_hash", "north_detection", "rotation_correction", "from_club_library"]));
    const events = await columns("events");
    expect(events).not.toContain("map_pipeline");
    expect(events).not.toContain("overprint_cuts_version");
    expect(events).toContain("auto_overprint_cuts");
    expect((await db.query("SELECT to_regtype('oxygen.map_pipeline') AS t")).rows[0].t).toBeNull();
    const courses = await columns("courses");
    expect(courses).not.toContain("geometry");
    expect(courses).not.toContain("geometry_source");
    expect(courses).toContain("length_source");

    // The tombstone keeps its row and name, without bytes; the live map keeps its pin.
    const rows = (await db.query("SELECT event_id, file_name, source_hash FROM map_files ORDER BY file_name")).rows;
    expect(rows).toEqual([
      { event_id: liveEvent, file_name: "live.ocd", source_hash: "a".repeat(64) },
      { event_id: removedEvent, file_name: "tombstone.ocd", source_hash: null },
    ]);
    expect((await db.query("SELECT length_source FROM courses")).rows).toEqual([{ length_source: "derived" }]);
    expect((await db.query("SELECT count(*)::int AS n FROM club_maps")).rows[0].n).toBe(1);
  });
});
