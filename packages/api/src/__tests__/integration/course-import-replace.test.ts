/**
 * Integration tests for the "replace all" course-import mode.
 *
 * The dialog defaults to a destructive import: every existing course and
 * control is soft-deleted (and any class→course assignment cleared)
 * before the new file is applied. Items present in the new file with a
 * matching name are reactivated in place so we don't leak Removed:true
 * zombie rows on repeated imports of the same course set.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestDbContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";

let ctx: TestDbContext;
let caller: ReturnType<typeof makeCaller>;

/** Minimal IOF 3.0 CourseData XML with a configurable course set. */
function buildXml(courses: { name: string; controls: number[] }[]): string {
  const allControls = new Set<number>();
  for (const c of courses) for (const code of c.controls) allControls.add(code);

  const controlElems = [
    `<Control type="Start"><Id>STA1</Id><Position lat="59.0" lng="18.0"/><MapPosition x="50" y="60"/></Control>`,
    ...[...allControls].map(
      (code) =>
        `<Control type="Control"><Id>${code}</Id><Position lat="59.001" lng="18.001"/><MapPosition x="${100 + code}" y="${200 + code}"/></Control>`,
    ),
    `<Control type="Finish"><Id>FIN1</Id><Position lat="59.004" lng="18.004"/><MapPosition x="200" y="300"/></Control>`,
  ].join("\n    ");

  const courseElems = courses
    .map((c) => {
      const ctrls = c.controls
        .map(
          (code) =>
            `<CourseControl type="Control"><Control>${code}</Control><LegLength>500</LegLength></CourseControl>`,
        )
        .join("");
      return `<Course>
      <Name>${c.name}</Name><Length>3000</Length><Climb>20</Climb>
      <CourseControl type="Start"><Control>STA1</Control><LegLength>0</LegLength></CourseControl>
      ${ctrls}
      <CourseControl type="Finish"><Control>FIN1</Control><LegLength>500</LegLength></CourseControl>
    </Course>`;
    })
    .join("\n    ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<CourseData>
  <RaceCourseData>
    <Map><Scale>4000</Scale></Map>
    ${controlElems}
    ${courseElems}
  </RaceCourseData>
</CourseData>`;
}

beforeAll(async () => {
  ctx = await createTestDb("coursereplace");
  caller = makeCaller({ dbName: ctx.dbName });

  await caller.course.importCourses({
    xmlContent: buildXml([
      { name: "Bana 1", controls: [31, 32, 33] },
      { name: "Bana 2", controls: [31, 34, 35] },
    ]),
  });

  await ctx.client.oClass.create({
    data: {
      Id: 9001,
      Name: "TestClass",
      Course: 0,
      Removed: false,
    },
  });
  const banaA = await ctx.client.oCourse.findFirst({
    where: { Removed: false, Name: "Bana 1" },
  });
  if (banaA) {
    await ctx.client.oClass.update({
      where: { Id: 9001 },
      data: { Course: banaA.Id },
    });
  }
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("course import: replaceAll", () => {
  it("legacy append mode keeps non-imported courses untouched", async () => {
    await caller.course.importCourses({
      xmlContent: buildXml([{ name: "Bana 3", controls: [40, 41] }]),
      replaceAll: false,
    });

    const courses = await ctx.client.oCourse.findMany({
      where: { Removed: false },
      select: { Name: true },
    });
    const names = courses.map((c) => c.Name).sort();
    expect(names).toEqual(["Bana 1", "Bana 2", "Bana 3"]);
  });

  it("replaceAll soft-deletes existing courses + controls and clears class assignments", async () => {
    const beforeCourseIds = new Map(
      (
        await ctx.client.oCourse.findMany({
          where: { Removed: false },
          select: { Id: true, Name: true },
        })
      ).map((c) => [c.Name, c.Id]),
    );

    await caller.course.importCourses({
      xmlContent: buildXml([
        { name: "Bana 1", controls: [31, 32, 33] },
        { name: "NyBana", controls: [50, 51] },
      ]),
      replaceAll: true,
    });

    const active = await ctx.client.oCourse.findMany({
      where: { Removed: false },
      select: { Id: true, Name: true },
    });
    const activeNames = active.map((c) => c.Name).sort();
    expect(activeNames).toEqual(["Bana 1", "NyBana"]);

    // Bana 1 must be reactivated in place — same row, not a fresh Id —
    // so any external references (class assignments saved with the same
    // import call, FK-style references) keep pointing to it.
    const reactivated = active.find((c) => c.Name === "Bana 1");
    expect(reactivated?.Id).toBe(beforeCourseIds.get("Bana 1"));

    // Bana 2, Bana 3 dropped from the new file → soft-deleted
    const removed = await ctx.client.oCourse.findMany({
      where: { Removed: true },
      select: { Name: true },
    });
    const removedNames = removed.map((c) => c.Name).sort();
    expect(removedNames).toContain("Bana 2");
    expect(removedNames).toContain("Bana 3");

    // The class previously bound to Bana 1 must have been unassigned by
    // step 0; the import only re-assigns courses listed in classMapping,
    // and we passed none.
    const cls = await ctx.client.oClass.findUnique({ where: { Id: 9001 } });
    expect(cls?.Course).toBe(0);

    // Old controls (34, 35 — not in the new file) must be soft-deleted.
    // New controls (50, 51) must be active.
    const ctrl34 = await ctx.client.oControl.findFirst({
      where: { Numbers: "34" },
    });
    expect(ctrl34?.Removed).toBe(true);
    const ctrl50 = await ctx.client.oControl.findFirst({
      where: { Numbers: "50" },
    });
    expect(ctrl50?.Removed).toBe(false);
  });

  it("replaceAll twice in a row does not pile up Removed:true zombie rows for matching names", async () => {
    // First import (replaceAll) sets the baseline.
    await caller.course.importCourses({
      xmlContent: buildXml([{ name: "OnlyBana", controls: [60, 61] }]),
      replaceAll: true,
    });
    const firstId = (
      await ctx.client.oCourse.findFirst({
        where: { Removed: false, Name: "OnlyBana" },
      })
    )?.Id;
    expect(firstId).toBeDefined();

    // Re-import the same set: matching name should reactivate the same
    // row (no new Removed row appears for "OnlyBana").
    await caller.course.importCourses({
      xmlContent: buildXml([{ name: "OnlyBana", controls: [60, 61] }]),
      replaceAll: true,
    });
    const onlyBanaRows = await ctx.client.oCourse.findMany({
      where: { Name: "OnlyBana" },
      select: { Id: true, Removed: true },
    });
    expect(onlyBanaRows).toHaveLength(1);
    expect(onlyBanaRows[0].Removed).toBe(false);
    expect(onlyBanaRows[0].Id).toBe(firstId);
  });
});
