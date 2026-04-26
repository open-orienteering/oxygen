/**
 * Integration tests for OCD-vs-XML course geometry priority.
 *
 * The course import pipeline keeps OCD-derived routed geometry whenever a
 * later XML import does not change the control layout, but switches to the
 * XML's straight-line geometry as soon as any control on a course is moved
 * or its sequence changes. Without this behaviour the lines on the map
 * trace through old control positions while the circles render at the new
 * ones (the bug reported on the Bagissprinten course set).
 *
 * The tests pre-seed `oxygen_course_geometry` with hand-crafted OCD
 * geometry so we can verify the behaviour without an OCD binary fixture.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestDbContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import type { GeoJSONFeatureCollection } from "../../iof-course-parser.js";

let ctx: TestDbContext;
let caller: ReturnType<typeof makeCaller>;

/** Multi-point LineString geometry — distinct from the 2-point straight
 * lines the XML straight-line builder produces, so we can tell apart
 * "OCD preserved" vs "overwritten by XML" purely from the leg shape. */
function routedLeg(
  fromCode: string,
  toCode: string,
  coords: [number, number][],
) {
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: coords },
    properties: { symbolType: "leg", from: fromCode, to: toCode, preclipped: true },
  };
}

function controlPoint(code: string, x: number, y: number, type = "control") {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [x, y] },
    properties: { symbolType: type, code, id: code },
  };
}

/** Build IOF 3.0 CourseData XML inline. Two courses, A and B, sharing a
 * pool of controls. Position of control 32 is the only knob the test
 * tweaks — A goes through 32 (so it must be flagged stale when 32 moves),
 * B skips 32 (so its OCD geometry must survive). */
function buildXml(opts: { control32X: number; control32Y: number }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<CourseData>
  <RaceCourseData>
    <Map><Scale>4000</Scale></Map>
    <Control type="Start"><Id>STA1</Id><Position lat="59.0" lng="18.0"/><MapPosition x="50" y="60"/></Control>
    <Control type="Control"><Id>31</Id><Position lat="59.001" lng="18.001"/><MapPosition x="100" y="200"/></Control>
    <Control type="Control"><Id>32</Id><Position lat="59.002" lng="18.002"/><MapPosition x="${opts.control32X}" y="${opts.control32Y}"/></Control>
    <Control type="Control"><Id>33</Id><Position lat="59.003" lng="18.003"/><MapPosition x="120" y="220"/></Control>
    <Control type="Finish"><Id>FIN1</Id><Position lat="59.004" lng="18.004"/><MapPosition x="200" y="300"/></Control>
    <Course>
      <Name>A</Name><Length>3000</Length><Climb>20</Climb>
      <CourseControl type="Start"><Control>STA1</Control><LegLength>0</LegLength></CourseControl>
      <CourseControl type="Control"><Control>31</Control><LegLength>500</LegLength></CourseControl>
      <CourseControl type="Control"><Control>32</Control><LegLength>500</LegLength></CourseControl>
      <CourseControl type="Control"><Control>33</Control><LegLength>500</LegLength></CourseControl>
      <CourseControl type="Finish"><Control>FIN1</Control><LegLength>500</LegLength></CourseControl>
    </Course>
    <Course>
      <Name>B</Name><Length>2000</Length><Climb>10</Climb>
      <CourseControl type="Start"><Control>STA1</Control><LegLength>0</LegLength></CourseControl>
      <CourseControl type="Control"><Control>31</Control><LegLength>500</LegLength></CourseControl>
      <CourseControl type="Control"><Control>33</Control><LegLength>500</LegLength></CourseControl>
      <CourseControl type="Finish"><Control>FIN1</Control><LegLength>500</LegLength></CourseControl>
    </Course>
  </RaceCourseData>
</CourseData>`;
}

async function seedOcdGeometry(
  client: TestDbContext["client"],
  courseName: string,
  geometry: GeoJSONFeatureCollection,
): Promise<void> {
  await client.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS oxygen_course_geometry (
      Id INT AUTO_INCREMENT PRIMARY KEY,
      CourseName VARCHAR(255) NOT NULL UNIQUE,
      Source VARCHAR(10) NOT NULL,
      Geometry LONGTEXT NOT NULL
    )
  `);
  await client.$executeRawUnsafe(
    "INSERT INTO oxygen_course_geometry (CourseName, Source, Geometry) VALUES (?, 'ocd', ?)",
    courseName,
    JSON.stringify(geometry),
  );
}

async function readGeometry(
  client: TestDbContext["client"],
  courseName: string,
): Promise<{ Source: string; Geometry: GeoJSONFeatureCollection } | null> {
  const rows = await client.$queryRawUnsafe<{ Source: string; Geometry: string }[]>(
    "SELECT Source, Geometry FROM oxygen_course_geometry WHERE CourseName=?",
    courseName,
  );
  if (rows.length === 0) return null;
  return { Source: rows[0].Source, Geometry: JSON.parse(rows[0].Geometry) };
}

beforeAll(async () => {
  ctx = await createTestDb("coursegeomstale");
  caller = makeCaller({ dbName: ctx.dbName });

  // Seed OCD geometry for course A. The leg lines are deliberately curvy
  // (3+ coordinates) to mimic OCAD's pre-clipped routed legs, so the test
  // can detect when straight-line XML geometry overwrites them.
  const ocdA: GeoJSONFeatureCollection = {
    type: "FeatureCollection",
    features: [
      controlPoint("STA1", 50, 60, "start"),
      controlPoint("31", 100, 200),
      controlPoint("32", 110, 210),
      controlPoint("33", 120, 220),
      controlPoint("FIN1", 200, 300, "finish"),
      routedLeg("STA1", "31", [[50, 60], [70, 130], [100, 200]]),
      routedLeg("31", "32", [[100, 200], [105, 205], [110, 210]]),
      routedLeg("32", "33", [[110, 210], [115, 215], [120, 220]]),
      routedLeg("33", "FIN1", [[120, 220], [160, 260], [200, 300]]),
    ],
  };
  await seedOcdGeometry(ctx.client, "A", ocdA);

  // Seed OCD geometry for course B. B does NOT go through control 32, so
  // moving 32 in the XML must not invalidate B's geometry.
  const ocdB: GeoJSONFeatureCollection = {
    type: "FeatureCollection",
    features: [
      controlPoint("STA1", 50, 60, "start"),
      controlPoint("31", 100, 200),
      controlPoint("33", 120, 220),
      controlPoint("FIN1", 200, 300, "finish"),
      routedLeg("STA1", "31", [[50, 60], [70, 130], [100, 200]]),
      routedLeg("31", "33", [[100, 200], [110, 210], [120, 220]]),
      routedLeg("33", "FIN1", [[120, 220], [160, 260], [200, 300]]),
    ],
  };
  await seedOcdGeometry(ctx.client, "B", ocdB);
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("course geometry: OCD-vs-XML staleness", () => {
  it("preserves OCD geometry when no controls have moved", async () => {
    // Re-import XML with control 32 at its original OCD position. Course A
    // and B should both keep their routed OCD lines.
    await caller.course.importCourses({
      xmlContent: buildXml({ control32X: 110, control32Y: 210 }),
    });

    const a = await readGeometry(ctx.client, "A");
    const b = await readGeometry(ctx.client, "B");

    expect(a?.Source).toBe("ocd");
    expect(b?.Source).toBe("ocd");

    // Routed legs with > 2 coordinates must survive.
    const aLegs = a!.Geometry.features.filter(
      (f) => f.geometry.type === "LineString",
    );
    expect(aLegs.length).toBeGreaterThan(0);
    expect(
      aLegs.every(
        (l) =>
          (l.geometry as { coordinates: [number, number][] }).coordinates
            .length >= 3,
      ),
    ).toBe(true);
  });

  it("overwrites OCD with XML straight lines when a control on the course has moved", async () => {
    // Move control 32 by 5 mm — well past the 0.5 mm tolerance.
    await caller.course.importCourses({
      xmlContent: buildXml({ control32X: 115, control32Y: 210 }),
    });

    const a = await readGeometry(ctx.client, "A");
    expect(a).not.toBeNull();
    expect(a!.Source).toBe("xml");

    // The new geometry is straight lines, so every LineString has exactly
    // 2 coordinates. The pre-seeded routed lines (3+ coords) are gone.
    const aLegs = a!.Geometry.features.filter(
      (f) => f.geometry.type === "LineString",
    );
    expect(aLegs.length).toBeGreaterThan(0);
    for (const l of aLegs) {
      const coords = (l.geometry as { coordinates: [number, number][] })
        .coordinates;
      expect(coords).toHaveLength(2);
    }

    // The point for control 32 must be at the new position.
    const c32 = a!.Geometry.features.find(
      (f) =>
        f.geometry.type === "Point" &&
        (f.properties as { code?: string }).code === "32",
    );
    expect(c32).toBeDefined();
    expect(
      (c32!.geometry as { coordinates: [number, number] }).coordinates,
    ).toEqual([115, 210]);
  });

  it("leaves the unaffected course's OCD geometry intact", async () => {
    // Course B does not include control 32, so its layout is unchanged.
    // The most recent import (with 32 moved) must NOT have downgraded B.
    const b = await readGeometry(ctx.client, "B");
    expect(b).not.toBeNull();
    expect(b!.Source).toBe("ocd");

    const bLegs = b!.Geometry.features.filter(
      (f) => f.geometry.type === "LineString",
    );
    expect(bLegs.length).toBeGreaterThan(0);
    expect(
      bLegs.every(
        (l) =>
          (l.geometry as { coordinates: [number, number][] }).coordinates
            .length >= 3,
      ),
    ).toBe(true);
  });
});
