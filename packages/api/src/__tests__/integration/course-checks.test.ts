/**
 * `course.checks` and `course.setStructure`'s checks (docs/course-layer.md
 * §9.4; row D6). A `vector` event with `e2e/test.ocd` pinned: the boulder
 * (ISOM 204) at 68/42 mm and the building (ISOM 521) spanning 48–58 /
 * 39–46 mm (`scripts/generate-test-ocd.mjs`). A `legacy` event beside it
 * reads its own pinned document (slice E1); without a pin, no map checks.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { randomBytes } from "crypto";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { applyEventMap } from "../../event-map.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "../../../../../e2e/test.ocd");
const BOULDER = { x: 68, y: 42 };

let vec: TestEventContext;
let caller: ReturnType<typeof makeCaller>;
let legacy: TestEventContext;
let legacyCaller: ReturnType<typeof makeCaller>;

beforeAll(async () => {
  vec = await createTestEvent("course_checks_vector");
  caller = makeCaller(vec.event);
  await vec.db.event.update({ where: { id: vec.eventId }, data: { mapPipeline: "vector" } });
  // Per-run trailer: content-addressed rows are global (see map-documents.test.ts).
  const bytes = Buffer.concat([readFileSync(FIXTURE), Buffer.from(`checks-${randomBytes(4).toString("hex")}`)]);
  const applied = await applyEventMap(vec.db, vec.eventId, "test.ocd", bytes);
  expect(applied.documentHash).toMatch(/^[0-9a-f]{64}$/);

  legacy = await createTestEvent("course_checks_legacy");
  legacyCaller = makeCaller(legacy.event);
  await legacyCaller.course.uploadMap({ fileName: "test.ocd", fileDataBase64: readFileSync(FIXTURE).toString("base64") });
}, 60_000);

afterAll(async () => {
  await vec?.cleanup();
  await legacy?.cleanup();
  await disconnect();
});

const codesOf = (checks: Array<{ code: string }>) => checks.map((c) => c.code);

describe("course.checks", () => {
  let courseId: number;

  beforeAll(async () => {
    const d = { d: "1.001" };
    // 101 → 102 crosses the building; 103 sits 1 mm from 102.
    await caller.control.create({ codes: "101", xpos: 44, ypos: 42, description: d });
    await caller.control.create({ codes: "102", xpos: 62, ypos: 42, description: { d: "1.002" } });
    await caller.control.create({ codes: "103", xpos: 62, ypos: 43 });
    await caller.control.create({ codes: "66", xpos: 20, ypos: 80, description: { d: "1.003" } });
    await caller.control.create({ codes: "99", xpos: 40, ypos: 80, description: { d: "1.004" } });
    courseId = (await caller.course.create({ name: "Checks", controlIds: [101, 102, 103] })).id;
  });

  it("returns the distance, code, description and leg codes with public ids", async () => {
    const checks = await caller.course.checks({ courseId });
    expect(codesOf(checks)).toEqual(["CONTROL_TOO_CLOSE", "CODE_INVERTIBLE", "DESCRIPTION_MISSING", "LEG_THROUGH_UNCROSSABLE"]);
    const close = checks[0];
    expect(close.siteIds).toEqual([102, 103]);
    expect(close.params).toMatchObject({ a: "102", b: "103", limitM: 30 });
    expect(Number(close.params!.distanceM)).toBeLessThan(30);
    expect(checks[1]).toMatchObject({ siteIds: [66, 99], params: { a: 66, b: 99 } });
    expect(checks[2]).toMatchObject({ siteIds: [103] });
    const leg = checks[3];
    expect(leg.leg).toEqual({ from: 101, to: 102, index: 0 });
    expect(leg.params).toMatchObject({ from: "101", to: "102" });
    expect(String(leg.params!.symbol)).toMatch(/^521/);
    expect(leg.at.x).toBeCloseTo(48, 1);
    // No sheet windows and no placement on the server.
    expect(codesOf(checks)).not.toContain("CONTROL_OUTSIDE_SHEET");
  });

  it("an out-of-bounds area in scope is crossed by a leg", async () => {
    const oob = await caller.courseObject.create({
      kind: "oob_area",
      geometry: [{ x: 61, y: 41 }, { x: 63, y: 41 }, { x: 63, y: 44 }, { x: 61, y: 44 }].map((p) => ({ ...p, x: p.x - 8 })),
      props: {},
      scope: { courses: [courseId], classes: [] },
    });
    // The area sits on 101 → 102 at x 53–55, inside the building too.
    expect(codesOf(await caller.course.checks({ courseId }))).toContain("LEG_CROSSES_OOB");
    await caller.courseObject.delete({ id: oob.id, baseVersion: oob.version });
    expect(codesOf(await caller.course.checks({ courseId }))).not.toContain("LEG_CROSSES_OOB");
  });

  it("setStructure returns the same list and saves regardless", async () => {
    const detail = await caller.course.detail({ id: courseId });
    const res = await caller.course.setStructure({ courseId, structure: detail.structure!, baseVersion: detail.version });
    expect(res.checks).toEqual(await caller.course.checks({ courseId }));
    expect(res.version).not.toBe(detail.version);
  });

  it("a viewer reads them", async () => {
    const suffix = randomBytes(3).toString("hex");
    const viewer = await vec.db.user.create({ data: { email: `viewer@d6-checks-${suffix}.example`, displayName: "Viewer", isAdmin: false, active: true } });
    const group = await vec.db.permissionGroup.create({ data: { name: `Viewer ${suffix}`, capabilities: ["event.view", "courses.view"] } });
    await vec.db.eventPermission.create({ data: { eventId: vec.eventId, userId: viewer.id, groupId: group.id } });
    const asViewer = makeCaller(vec.event, { user: viewer, authEnabled: true, identityEmail: viewer.email });
    expect((await asViewer.course.checks({ courseId })).length).toBeGreaterThan(0);
    await vec.db.eventPermission.deleteMany({ where: { groupId: group.id } });
    await vec.db.permissionGroup.delete({ where: { id: group.id } });
  });
});

describe("DESCRIPTION_STALE (description_source, §6.3)", () => {
  it("writes the source: auto from autodetect, manual from an explicit edit even when equal, NULL when cleared", async () => {
    await caller.control.create({ codes: "121", xpos: BOULDER.x, ypos: BOULDER.y, autoDescribe: true });
    const auto = await vec.db.control.findFirstOrThrow({ where: { eventId: vec.eventId, codes: "121" } });
    expect(auto.descriptionSource).toBe("auto");
    expect((auto.description as { d?: string }).d).toBe("2.004");

    await caller.control.update({ id: 121, description: auto.description as { d: string } });
    expect((await vec.db.control.findFirstOrThrow({ where: { id: auto.id } })).descriptionSource).toBe("manual");
    await caller.control.update({ id: 121, description: null });
    expect((await vec.db.control.findFirstOrThrow({ where: { id: auto.id } })).descriptionSource).toBeNull();
    // A move that re-describes writes auto again.
    await caller.control.update({ id: 121, xpos: BOULDER.x, ypos: BOULDER.y + 0.5, autoDescribe: true });
    expect((await vec.db.control.findFirstOrThrow({ where: { id: auto.id } })).descriptionSource).toBe("auto");
  });

  it("flags an autodetected description the map no longer suggests, never a manual one", async () => {
    await caller.control.create({ codes: "131", xpos: BOULDER.x, ypos: BOULDER.y, autoDescribe: true });
    await caller.control.create({ codes: "132", xpos: BOULDER.x, ypos: BOULDER.y + 0.2, description: { d: "1.010" } });
    await caller.control.create({ codes: "133", xpos: 20, ypos: 20, description: { d: "1.011" } });
    const courseId = (await caller.course.create({ name: "Stale", controlIds: [131, 132, 133] })).id;
    expect(codesOf(await caller.course.checks({ courseId }))).not.toContain("DESCRIPTION_STALE");

    // Moved off the boulder without re-describing: the stored boulder is stale; 132's hand-written one is not.
    await caller.control.update({ id: 131, xpos: 30, ypos: 30 });
    await caller.control.update({ id: 132, xpos: 30, ypos: 60 });
    const stale = (await caller.course.checks({ courseId })).filter((c) => c.code === "DESCRIPTION_STALE");
    expect(stale.map((c) => c.siteIds)).toEqual([[131]]);
    expect(stale[0].at).toEqual({ x: 30, y: 30 });
  });
});

describe("a legacy event", () => {
  // Slice E1: the obstacles come from the pinned document whatever the
  // event's pipeline (docs/map-storage.md §4.6).
  let courseId: number;

  it("reads its pinned document's obstacles too", async () => {
    await legacyCaller.control.create({ codes: "101", xpos: 44, ypos: 42, description: { d: "1.001" } });
    await legacyCaller.control.create({ codes: "102", xpos: 62, ypos: 42, description: { d: "1.002" } });
    await legacyCaller.control.create({ codes: "103", xpos: 62, ypos: 43, description: { d: "1.003" } });
    courseId = (await legacyCaller.course.create({ name: "Legacy", controlIds: [101, 102, 103] })).id;
    const codes = codesOf(await legacyCaller.course.checks({ courseId }));
    expect(codes).toContain("CONTROL_TOO_CLOSE");
    expect(codes).toContain("LEG_THROUGH_UNCROSSABLE");
  });

  it("has no map checks without a pin: no obstacles, and no scale for the distance codes", async () => {
    const pinned = await legacy.db.mapFile.findFirstOrThrow({ where: { eventId: legacy.eventId }, select: { documentHash: true } });
    await legacy.db.mapFile.updateMany({ where: { eventId: legacy.eventId }, data: { documentHash: null } });
    try {
      expect(codesOf(await legacyCaller.course.checks({ courseId }))).toEqual([]);
    } finally {
      await legacy.db.mapFile.updateMany({ where: { eventId: legacy.eventId }, data: { documentHash: pinned.documentHash } });
    }
  });
});
