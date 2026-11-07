/**
 * The Demo Competition fixture (docs/demo.md): loaded the way
 * `scripts/load-showcase.sh` loads it — the `map_sources` row from the
 * committed demo `.omap`, then `showcase.sql`, then the re-match — it pins
 * the CC0 demo map (docs/map-storage.md §6.9, `unpinned`), answers
 * `course.mapMetadata`, places every control on the map, and every course
 * reads its controls with the lengths the fixture stores. A second load
 * changes nothing.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { Client } from "pg";
import { disconnect } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { prisma, type EventRef } from "../../db.js";
import { runRematch } from "../../map-store/rematch.js";
import { loadCourseSequences, rebuildCourseLengths } from "../../course-geometry.js";

const FIXTURES = resolve(__dirname, "../../../../../docs/screenshots/fixtures");
const SQL = readFileSync(resolve(FIXTURES, "showcase.sql"), "utf8");
const MAP = readFileSync(resolve(FIXTURES, "puit-de-laven-demo.omap"));
const MAP_HASH = createHash("sha256").update(MAP).digest("hex");
const DEMO_EVENT_ID = 9876543n;

const db = prisma();
let clubsBefore: Set<string>;

const url = new URL(process.env.DATABASE_URL!);
url.searchParams.delete("schema");

/** The loader's three steps: source row, SQL, re-match. */
async function loadShowcase() {
  await db.mapSource.createMany({
    data: [{ fileHash: MAP_HASH, kind: "omap", bytes: MAP, sizeBytes: MAP.byteLength, fileName: "puit-de-laven-demo.omap" }],
    skipDuplicates: true,
  });
  const c = new Client({ connectionString: url.toString() });
  await c.connect();
  try {
    await c.query(SQL);
  } finally {
    await c.end();
  }
  return runRematch(db, { eventId: DEMO_EVENT_ID });
}

async function demoEvent(): Promise<EventRef> {
  const e = await db.event.findUniqueOrThrow({ where: { id: DEMO_EVENT_ID }, select: { id: true, nameId: true, zeroTime: true, date: true, kioskKey: true } });
  return e;
}

beforeAll(async () => {
  clubsBefore = new Set((await db.clubDirectory.findMany({ select: { eventorId: true } })).map((c) => c.eventorId));
}, 30_000);

afterAll(async () => {
  await db.$executeRawUnsafe(`DELETE FROM oxygen.course_controls WHERE course_id IN (SELECT id FROM oxygen.courses WHERE event_id = ${DEMO_EVENT_ID})`);
  await db.event.deleteMany({ where: { id: DEMO_EVENT_ID } });
  const clubs = (await db.clubDirectory.findMany({ select: { eventorId: true } })).map((c) => c.eventorId).filter((id) => !clubsBefore.has(id));
  await db.clubDirectory.deleteMany({ where: { eventorId: { in: clubs } } });
  await db.mapImportJob.deleteMany({ where: { sourceHash: MAP_HASH } });
  await db.mapDocument.deleteMany({ where: { sourceHash: MAP_HASH } });
  await db.mapSource.deleteMany({ where: { fileHash: MAP_HASH } });
  await disconnect();
}, 30_000);

describe("showcase fixture", () => {
  it("names the committed demo map and no document", () => {
    expect(SQL).toMatch(new RegExp(`'${MAP_HASH}', NULL\\);$`, "m"));
    expect(SQL).not.toMatch(/^INSERT INTO map_(sources|documents) /m);
  });

  it("loads, and the re-match pins the demo map with the pin's quick-access columns", async () => {
    const run = await loadShowcase();
    expect(run).toMatchObject({ total: 1, done: 1, failed: 0 });
    const pin = await db.mapFile.findFirstOrThrow({ where: { eventId: DEMO_EVENT_ID } });
    expect(pin.sourceHash).toBe(MAP_HASH);
    expect(pin.documentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(pin.scale).toBe(10000);
    expect(pin.calibration).toHaveLength(4);
    expect(pin.northOffset).not.toBeNull();
  }, 120_000);

  it("answers course.mapMetadata for demo_competition", async () => {
    const event = await demoEvent();
    expect(event.nameId).toBe("demo_competition");
    const meta = await makeCaller(event).course.mapMetadata();
    expect(meta).toMatchObject({ scale: 10000, documentHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(meta!.bounds!.south).toBeGreaterThan(43.5);
    expect(meta!.bounds!.north).toBeLessThan(43.7);
  });

  it("places every live positioned control inside the map, its lat/lng derived by the pin", async () => {
    const pin = await db.mapFile.findFirstOrThrow({ where: { eventId: DEMO_EVENT_ID } });
    const bounds = pin.bounds as { north: number; south: number; east: number; west: number };
    const controls = await db.control.findMany({ where: { eventId: DEMO_EVENT_ID, removed: false, OR: [{ xpos: { not: 0 } }, { ypos: { not: 0 } }] } });
    expect(controls.length).toBeGreaterThan(20);
    for (const c of controls) {
      expect(c.lat!).toBeGreaterThan(bounds.south);
      expect(c.lat!).toBeLessThan(bounds.north);
      expect(c.lng!).toBeGreaterThan(bounds.west);
      expect(c.lng!).toBeLessThan(bounds.east);
    }
  });

  it("reads each course's controls (no stale structure) with the lengths the fixture stores", async () => {
    const courses = await db.course.findMany({ where: { eventId: DEMO_EVENT_ID }, orderBy: { name: "asc" } });
    expect(courses.map((c) => c.name)).toEqual(["A", "B", "C", "D", "E"]);
    const sequences = await loadCourseSequences(db, DEMO_EVENT_ID, courses.map((c) => c.id));
    for (const c of courses) {
      expect(c.structure).toBeNull();
      const middle = await db.courseControl.count({ where: { courseId: c.id } });
      const seq = sequences.get(c.id)!.seq;
      expect(seq.map((s) => s.type)).toEqual(["Start", ...Array(middle).fill("Control"), "Finish"]);
    }
    // The API derives the same lengths from the loaded positions as the fixture's apply step did.
    await rebuildCourseLengths(db, DEMO_EVENT_ID, courses.map((c) => c.id));
    const rebuilt = await db.course.findMany({ where: { eventId: DEMO_EVENT_ID }, orderBy: { name: "asc" } });
    expect(rebuilt.map((c) => [c.name, c.lengthM, c.legs, c.lengthSource])).toEqual(courses.map((c) => [c.name, c.lengthM, c.legs, "derived"]));
  });

  it("loads a second time to the same state", async () => {
    const before = await db.mapFile.findFirstOrThrow({ where: { eventId: DEMO_EVENT_ID } });
    const run = await loadShowcase();
    expect(run).toMatchObject({ done: 1, failed: 0 });
    const after = await db.mapFile.findFirstOrThrow({ where: { eventId: DEMO_EVENT_ID } });
    expect(after.documentHash).toBe(before.documentHash);
    expect(await db.runner.count({ where: { eventId: DEMO_EVENT_ID } })).toBe(169);
    expect(await db.mapSource.count({ where: { fileHash: MAP_HASH } })).toBe(1);
  }, 120_000);
});
