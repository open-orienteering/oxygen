import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { PDFDocument } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultMapAppearance } from "@oxygen/shared";
import { registerCourseMapRoutes } from "../../course-maps/routes.js";
import {
  createTestEvent,
  disconnect,
  type TestEventContext,
} from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";

let ctx: TestEventContext;
let caller: ReturnType<typeof makeCaller>;
let server: FastifyInstance;
let courseId: number;
let courseSeq: number;
let startControlId: string;
let finishControlId: string;
const convertedSvgs: string[] = [];
const clubTemplateName = `Course-map-${randomUUID()}`;
const fixture = resolve(__dirname, "../../../../../e2e/test.ocd");

const settings = {
  printMarginMm: 3,
  mapFrame: { x: 8, y: 8, width: 194, height: 281 },
  description: { visible: true, x: 150, y: 12, cellSizeMm: 6 },
  appearance: defaultMapAppearance,
};

beforeAll(async () => {
  ctx = await createTestEvent("course_maps");
  caller = makeCaller(ctx.event);
  const control1 = await ctx.db.control.create({
    data: {
      eventId: ctx.eventId,
      codes: "31",
      xpos: -20,
      ypos: 0,
      description: { d: "2.004" },
    },
  });
  const control2 = await ctx.db.control.create({
    data: {
      eventId: ctx.eventId,
      codes: "32",
      xpos: 20,
      ypos: 0,
    },
  });
  const start = await ctx.db.control.create({
    data: {
      eventId: ctx.eventId,
      status: "start",
      codes: "",
      xpos: -30,
      ypos: 0,
    },
  });
  startControlId = start.id;
  const finish = await ctx.db.control.create({
    data: {
      eventId: ctx.eventId,
      status: "finish",
      codes: "",
      xpos: 30,
      ypos: 0,
    },
  });
  finishControlId = finish.id;
  const course = await ctx.db.course.create({
    data: {
      eventId: ctx.eventId,
      name: "Blue",
      lengthM: 2_300,
      climbM: 45,
      geometry: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [-30, 0] },
            properties: { id: "start", code: "S", symbolType: "start" },
          },
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [30, 0] },
            properties: { id: "finish", code: "F", symbolType: "finish" },
          },
          {
            type: "Feature",
            geometry: {
              type: "LineString",
              coordinates: [
                [-30, 0],
                [-20, 0],
              ],
            },
            properties: {
              symbolType: "leg",
              gaps: [{ from: 0.4, to: 0.6 }],
            },
          },
          {
            type: "Feature",
            geometry: {
              type: "LineString",
              coordinates: [
                [-20, 0],
                [20, 0],
              ],
            },
            properties: { symbolType: "leg" },
          },
          {
            type: "Feature",
            geometry: {
              type: "LineString",
              coordinates: [
                [20, 0],
                [30, 0],
              ],
            },
            properties: { symbolType: "leg" },
          },
        ],
      },
      courseControls: {
        create: [
          { position: 1, controlId: control1.id },
          { position: 2, controlId: control2.id },
        ],
      },
    },
  });
  courseId = course.seq;
  courseSeq = course.seq;
  await ctx.db.mapFile.create({
    data: {
      eventId: ctx.eventId,
      fileName: "test.ocd",
      fileData: readFileSync(fixture),
      scale: 7500,
    },
  });

  const fakeConverter = {
    async convert(svg: string) {
      convertedSvgs.push(svg);
      const pdf = await PDFDocument.create();
      pdf.addPage([595.28, 841.89]);
      return Buffer.from(await pdf.save());
    },
  };
  server = Fastify({ logger: false });
  registerCourseMapRoutes(server, { converter: fakeConverter });
  await server.ready();
});

afterAll(async () => {
  await server.close();
  await ctx.db.clubMapTemplate.deleteMany({
    where: { name: clubTemplateName },
  });
  await ctx.cleanup();
  await disconnect();
});

describe("map file info and metadata", () => {
  // `size` is now computed in SQL (octet_length) so the query no longer
  // ships the blob to the API just to read `.length`.
  it("reports the uploaded file's exact byte size without fetching it", async () => {
    const info = await caller.course.mapFileInfo();
    expect(info).not.toBeNull();
    expect(info!.fileName).toBe("test.ocd");
    expect(info!.size).toBe(readFileSync(fixture).byteLength);
    expect(Number.isInteger(info!.id)).toBe(true);
  });

  // The auto-profile classification reads and parses the OCAD; the
  // result is memoised per render key so repeat calls agree and are cheap.
  it("resolves the auto colour profile consistently across calls", async () => {
    const first = await caller.course.mapMetadata();
    const second = await caller.course.mapMetadata();
    expect(first).not.toBeNull();
    expect(first!.colorProfile).toBe("auto");
    expect(["isom", "issprom", "isskiom", "ismtbom"]).toContain(
      first!.resolvedProfile,
    );
    expect(second!.resolvedProfile).toBe(first!.resolvedProfile);
    expect(second!.resolvedBy).toBe(first!.resolvedBy);
    expect(second!.renderKey).toBe(first!.renderKey);
  });
});

describe("map templates and course maps", () => {
  it("creates, duplicates and applies an event template idempotently", async () => {
    const template = await caller.mapTemplate.create({
      name: "A4 1:7500",
      paper: "A4",
      orientation: "portrait",
      printScale: 7500,
      settings,
      objects: [
        {
          id: "title",
          kind: "text",
          anchor: "page",
          x: 12,
          y: 20,
          text: "{course}",
          fontSizeMm: 4,
          color: "#000000",
        },
      ],
    });
    const duplicate = await caller.mapTemplate.duplicate({
      id: template.seq,
      name: "A4 copy",
    });
    expect(duplicate.settings).toEqual(settings);

    await expect(
      caller.mapTemplate.applyToCourses({
        templateId: template.seq,
        courseIds: [courseId],
      }),
    ).resolves.toEqual({ created: 1, updated: 0 });
    await expect(
      caller.mapTemplate.applyToCourses({
        templateId: duplicate.seq,
        courseIds: [courseId],
      }),
    ).resolves.toEqual({ created: 0, updated: 1 });

    const maps = await caller.courseMap.list();
    expect(maps).toHaveLength(1);
    expect(maps[0]).toMatchObject({
      name: "Blue",
      courseId,
      templateId: duplicate.seq,
    });
    expect(maps[0].validation.valid).toBe(true);
    expect(maps[0].controls.map((control) => control.type)).toEqual([
      "start",
      "control",
      "control",
      "finish",
    ]);
    expect(maps[0].legs).toHaveLength(3);
    expect(maps[0].legs[0].gaps).toEqual([{ from: 0.4, to: 0.6 }]);
    // Print sheet = the course editor's sheet: header + start + controls +
    // finish (with the measured last-control → finish distance).
    expect(maps[0].descriptionHeader).toMatchObject({ courseName: "Blue" });
    expect(maps[0].descriptionRows.map((row) => row.kind)).toEqual([
      "start",
      "control",
      "control",
      "finish",
    ]);
    expect(maps[0].descriptionRows[1]).toMatchObject({
      sequence: 1,
      code: "31",
      description: { d: "2.004" },
    });
    expect(maps[0].descriptionRows[2]).toMatchObject({
      sequence: 2,
      code: "32",
      description: null,
    });
    expect(maps[0].descriptionRows[3]).toMatchObject({ kind: "finish", symbolKey: "14.3" });
  });

  it("supports several maps per course and a single all-controls map", async () => {
    const template = (await caller.mapTemplate.list())[0];
    const second = await caller.courseMap.create({
      name: "Blue part 2",
      courseId,
      templateId: template.seq,
      kind: "course",
      overrides: {},
      objects: [],
    });
    expect(second.sortOrder).toBe(1);
    await caller.courseMap.saveLayout({
      id: second.seq,
      windowCenter: { x: 12, y: 34 },
      printScale: 8000,
      description: { visible: false, x: 10, y: 10, cellSizeMm: 5 },
      objects: [
        {
          id: "map-label",
          kind: "text",
          anchor: "page",
          x: 10,
          y: 20,
          text: "{course}",
          fontSizeMm: 4,
          color: "#000000",
        },
      ],
      templateObjects: [
        {
          id: "event-label",
          kind: "text",
          anchor: "page",
          x: 10,
          y: 10,
          text: "{event}",
          fontSizeMm: 3,
          color: "#000000",
        },
      ],
    });
    const saved = await ctx.db.courseMap.findUniqueOrThrow({
      where: { id: second.id },
      include: { template: true },
    });
    expect(saved.windowCenter).toEqual({ x: 12, y: 34 });
    expect(saved.overrides).toMatchObject({ printScale: 8000 });
    expect(saved.objects).toHaveLength(1);
    expect(saved.template?.objects).toHaveLength(1);

    const allControlsMap = await caller.courseMap.create({
      name: "All controls",
      kind: "all_controls",
      courseId: null,
      templateId: template.seq,
      overrides: {},
      objects: [],
    });
    const listed = await caller.courseMap.list();
    const resolvedAllControls = listed.find(
      (map) => map.seq === allControlsMap.seq,
    );
    expect(resolvedAllControls?.controls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: startControlId, type: "start" }),
        expect.objectContaining({ id: finishControlId, type: "finish" }),
      ]),
    );
    expect(
      resolvedAllControls?.descriptionRows.map((row) => row.code),
    ).toEqual(["31", "32"]);
    await expect(
      caller.courseMap.create({
        kind: "all_controls",
        courseId: null,
        templateId: template.seq,
        overrides: {},
        objects: [],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("previews a template layout without a course", async () => {
    const template = (await caller.mapTemplate.list())[0];
    const preview = await caller.mapTemplate.previewLayout({
      id: template.seq,
    });
    expect(preview.controls).toEqual([]);
    expect(preview.legs).toEqual([]);
    expect(preview.document).toMatchObject({
      paper: template.paper,
      orientation: template.orientation,
      printScale: template.printScale,
      mapFrame: settings.mapFrame,
      appearance: settings.appearance,
      description: settings.description,
    });
    // Base map and print scale are both 1:7500, so the window matches the
    // frame in millimetres and is centred on the map origin.
    expect(preview.window.width).toBeCloseTo(settings.mapFrame.width);
    expect(preview.window.height).toBeCloseTo(settings.mapFrame.height);
    expect(preview.window.minX + preview.window.width / 2).toBeCloseTo(0);
    expect(preview.window.minY + preview.window.height / 2).toBeCloseTo(0);
    expect(preview.textValues).toMatchObject({
      course: "",
      classes: "",
      length: "",
      climb: "",
      controls: "0",
      map: template.name,
      scale: `1:${template.printScale}`,
      date: "2026-01-01",
    });
  });

  it("previews a template layout with a course overlay", async () => {
    const template = (await caller.mapTemplate.list())[0];
    const preview = await caller.mapTemplate.previewLayout({
      id: template.seq,
      courseId: courseSeq,
    });
    expect(preview.controls.map((control) => control.type)).toEqual([
      "start",
      "control",
      "control",
      "finish",
    ]);
    expect(preview.controls.map((control) => control.code)).toEqual([
      "S",
      "31",
      "32",
      "F",
    ]);
    expect(preview.legs).toHaveLength(3);
    expect(preview.legs[0].gaps).toEqual([{ from: 0.4, to: 0.6 }]);
    // Course spans x -30..30, y 0 — the window centres on that bounding box.
    expect(preview.window.minX + preview.window.width / 2).toBeCloseTo(0);
    expect(preview.window.minY + preview.window.height / 2).toBeCloseTo(0);
    expect(preview.textValues).toMatchObject({
      course: "Blue",
      length: "2300 m",
      climb: "45 m",
      controls: "2",
    });
    expect(preview.textValues.event).toContain("Test Event");
  });

  it("rejects previews for unknown templates and courses", async () => {
    const template = (await caller.mapTemplate.list())[0];
    await expect(
      caller.mapTemplate.previewLayout({ id: 900_001 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      caller.mapTemplate.previewLayout({
        id: template.seq,
        courseId: 900_001,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("round-trips templates through the club library", async () => {
    const template = (await caller.mapTemplate.list())[0];
    const saved = await caller.mapTemplate.saveToClub({
      templateId: template.seq,
      name: clubTemplateName,
    });
    await expect(caller.mapTemplate.listClub()).resolves.toContainEqual({
      id: saved.id,
      name: clubTemplateName,
      paper: template.paper,
      orientation: template.orientation,
      printScale: template.printScale,
    });
    const loaded = await caller.mapTemplate.loadFromClub({
      clubTemplateId: saved.id,
      name: "Loaded from club",
    });
    expect(loaded.removedMapAnchoredCount).toBe(0);
    expect(loaded.template).toMatchObject({
      paper: template.paper,
      printScale: template.printScale,
      settings: template.settings,
      objects: template.objects,
    });
  });

  it("strips map-anchored objects when loading a club template", async () => {
    const template = (await caller.mapTemplate.list())[0];
    await caller.mapTemplate.update({
      id: template.seq,
      objects: [
        {
          id: "page-label",
          kind: "text",
          anchor: "page",
          x: 20,
          y: 20,
          text: "Club",
          fontSizeMm: 4,
          color: "#000000",
        },
        {
          id: "map-mark",
          kind: "rectangle",
          anchor: "map",
          x: 10,
          y: 10,
          width: 5,
          height: 5,
          fillMode: "outOfBounds",
        },
      ],
    });
    const clubName = `E2E_ClubMapAnchored_${Date.now()}`;
    const saved = await caller.mapTemplate.saveToClub({
      templateId: template.seq,
      name: clubName,
    });
    const loaded = await caller.mapTemplate.loadFromClub({
      clubTemplateId: saved.id,
      name: `Imported anchored ${Date.now()}`,
    });
    expect(loaded.removedMapAnchoredCount).toBe(1);
    expect(loaded.template.objects).toHaveLength(1);
    expect(loaded.template.objects[0]).toMatchObject({
      id: "page-label",
      anchor: "page",
    });
  });
});

describe("course map REST rendering", () => {
  it("renders a fixed-scale map window PNG", async () => {
    const url = `/api/maps/${ctx.nameId}/window.png?cx=0.1234&cy=0&wMm=194&hMm=281&printScale=7500&dpi=72`;
    const response = await server.inject({
      method: "GET",
      url,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("image/png");
    expect(response.headers["x-cache"]).toBe("miss");
    expect(response.headers.etag).toBeTruthy();
    expect(response.rawPayload.subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );

    const cached = await server.inject({ method: "GET", url });
    expect(cached.statusCode).toBe(200);
    expect(cached.headers["x-cache"]).toBe("hit");
    expect(cached.headers.etag).toBe(response.headers.etag);
    expect(cached.rawPayload).toEqual(response.rawPayload);

    const notModified = await server.inject({
      method: "GET",
      url,
      headers: { "if-none-match": String(response.headers.etag) },
    });
    expect(notModified.statusCode).toBe(304);
    expect(notModified.headers["x-cache"]).toBe("hit");
  });

  it("allows high DPI while the raster stays within the pixel limit", async () => {
    const response = await server.inject({
      method: "GET",
      url: `/api/maps/${ctx.nameId}/window.png?cx=0&cy=0&wMm=60&hMm=60&printScale=7500&dpi=600`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("image/png");
  });

  it("rejects a window render that exceeds the pixel limit", async () => {
    const response = await server.inject({
      method: "GET",
      url: `/api/maps/${ctx.nameId}/window.png?cx=0&cy=0&wMm=194&hMm=281&printScale=7500&dpi=600`,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("4096");
  });

  it("rejects a dpi above the supported maximum", async () => {
    const response = await server.inject({
      method: "GET",
      url: `/api/maps/${ctx.nameId}/window.png?cx=0&cy=0&wMm=60&hMm=60&printScale=7500&dpi=1200`,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("dpi");
  });

  it("returns one PDF page per map for a selected course", async () => {
    const response = await server.inject({
      method: "GET",
      url: `/api/maps/${ctx.nameId}/maps.pdf?courses=${courseSeq}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/pdf");
    const pdf = await PDFDocument.load(response.rawPayload);
    expect(pdf.getPageCount()).toBe(2);
    expect(convertedSvgs).not.toHaveLength(0);
    const last = convertedSvgs.at(-1)!;
    expect(last).toContain("course-overlay-lower");
    expect(last).toContain("course-overlay-upper");
    expect(last).not.toContain("mix-blend-mode");
    // Ink (when present) sits between lower and upper purple.
    const lowerAt = last.indexOf("course-overlay-lower");
    const upperAt = last.indexOf("course-overlay-upper");
    expect(lowerAt).toBeGreaterThanOrEqual(0);
    expect(upperAt).toBeGreaterThan(lowerAt);
    const inkAt = last.indexOf('data-map-layer="map-ink"');
    if (inkAt >= 0) {
      expect(inkAt).toBeGreaterThan(lowerAt);
      expect(inkAt).toBeLessThan(upperAt);
    }
  });

  it("exports all-controls starts and finishes as symbols", async () => {
    const allControlsMap = (await caller.courseMap.list()).find(
      (map) => map.kind === "all_controls",
    );
    if (!allControlsMap) throw new Error("Expected an all-controls map");
    const response = await server.inject({
      method: "GET",
      url: `/api/maps/${ctx.nameId}/maps.pdf?maps=${allControlsMap.seq}`,
    });
    expect(response.statusCode).toBe(200);
    const svg = convertedSvgs.at(-1) ?? "";
    expect(svg).toContain(`data-control-id="${startControlId}"`);
    expect(svg).toContain(`data-control-id="${finishControlId}"`);
    expect(svg).toMatch(
      new RegExp(`<path[^>]+data-control-id="${startControlId}"`),
    );
    expect(svg).toMatch(
      new RegExp(`<circle[^>]+data-control-id="${finishControlId}"`),
    );
  });

  it("renders a rotated window as a distinct cached entry", async () => {
    const base = `/api/maps/${ctx.nameId}/window.png?cx=0&cy=0&wMm=60&hMm=60&printScale=7500&dpi=72`;
    const straight = await server.inject({ method: "GET", url: base });
    const rotated = await server.inject({
      method: "GET",
      url: `${base}&rot=-15`,
    });
    expect(straight.statusCode).toBe(200);
    expect(rotated.statusCode).toBe(200);
    expect(rotated.headers["content-type"]).toContain("image/png");
    expect(rotated.headers.etag).not.toBe(straight.headers.etag);
    expect(rotated.rawPayload.equals(straight.rawPayload)).toBe(false);

    const invalid = await server.inject({
      method: "GET",
      url: `${base}&rot=270`,
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toContain("rot");
  });
});

describe("graphics library", () => {
  const svgUpload = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20" fill="#336699"/></svg>`,
  );
  let eventGraphicId: number;
  let clubGraphicId: number;

  it("uploads, lists and serves an event graphic", async () => {
    const uploaded = await caller.graphics.upload({
      name: "Club logo",
      scope: "event",
      fileDataBase64: svgUpload.toString("base64"),
    });
    eventGraphicId = uploaded.id;
    expect(uploaded).toMatchObject({
      name: "Club logo",
      mime: "image/svg+xml",
      sizeBytes: svgUpload.byteLength,
      club: false,
    });

    const listed = await caller.graphics.list();
    expect(listed.find((row) => row.id === eventGraphicId)).toMatchObject({
      name: "Club logo",
      club: false,
    });

    const served = await server.inject({
      method: "GET",
      url: `/api/maps/${ctx.nameId}/graphics/${eventGraphicId}`,
    });
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toContain("image/svg+xml");
    expect(served.rawPayload.equals(svgUpload)).toBe(true);
  });

  it("rejects active SVG content and unknown formats", async () => {
    await expect(
      caller.graphics.upload({
        name: "Evil",
        scope: "event",
        fileDataBase64: Buffer.from(
          `<svg viewBox="0 0 1 1"><script>x()</script></svg>`,
        ).toString("base64"),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.graphics.upload({
        name: "Not an image",
        scope: "event",
        fileDataBase64: Buffer.from("plain text").toString("base64"),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("copies an event graphic to the club library", async () => {
    const copy = await caller.graphics.saveToClub({ id: eventGraphicId });
    clubGraphicId = copy.id;
    expect(copy).toMatchObject({ name: "Club logo", club: true });

    const listed = await caller.graphics.list();
    expect(listed.find((row) => row.id === clubGraphicId)).toMatchObject({
      club: true,
    });
    // Event graphics sort before club graphics.
    expect(
      listed.findIndex((row) => row.id === eventGraphicId),
    ).toBeLessThan(listed.findIndex((row) => row.id === clubGraphicId));
  });

  it("embeds placed graphics into the exported PDF page", async () => {
    const maps = await caller.courseMap.list();
    const map = maps.find((row) => row.kind === "course");
    if (!map) throw new Error("Expected a course map");
    await caller.courseMap.saveLayout({
      id: map.seq,
      windowCenter: { x: 0, y: 0 },
      printScale: 7500,
      description: { visible: false, x: 10, y: 10, cellSizeMm: 5 },
      objects: [
        {
          id: "logo",
          kind: "image",
          anchor: "page",
          graphicId: eventGraphicId,
          x: 10,
          y: 10,
          width: 30,
          height: 30,
        },
      ],
      templateObjects: [],
    });
    const response = await server.inject({
      method: "GET",
      url: `/api/maps/${ctx.nameId}/maps.pdf?maps=${map.seq}`,
    });
    expect(response.statusCode).toBe(200);
    expect(convertedSvgs.at(-1)).toContain('fill="#336699"');
  });

  it("deletes graphics and reports missing ones", async () => {
    await expect(
      caller.graphics.delete({ id: eventGraphicId }),
    ).resolves.toEqual({ ok: true });
    await expect(
      caller.graphics.delete({ id: clubGraphicId }),
    ).resolves.toEqual({ ok: true });
    await expect(
      caller.graphics.delete({ id: eventGraphicId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const served = await server.inject({
      method: "GET",
      url: `/api/maps/${ctx.nameId}/graphics/${eventGraphicId}`,
    });
    expect(served.statusCode).toBe(404);
  });
});
