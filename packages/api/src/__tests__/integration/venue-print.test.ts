/**
 * Venue printing (row G18; slice G answer 4; docs/course-print.md §8.7):
 * a box that checked an event out answers `maps.pdf`, `print-job`,
 * `print.png` and the description sheets from its copy, with the cloud's
 * exact bytes.
 *
 * The print routes read the Prisma singleton, so this one node plays both
 * roles: it prints as the cloud, exports the checkout snapshot through a
 * JSON round trip (as HTTP delivers it), loses its club graphic, imports
 * the snapshot as the box (the import replaces the event) and prints
 * again. The graphics' bytes come through the same fetch and checks as a
 * checkout's; the map blobs are held already, as on a box that checked the
 * event out before. The event has a patch (G14), which the box prints from
 * the snapshot's `maps.patch`.
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultMapAppearance } from "@oxygen/shared";
import type { PrintJob } from "@oxygen/shared/print";
import { registerCourseMapRoutes } from "../../course-maps/routes.js";
import { renderCoursePagesInWorker } from "../../course-maps/print-worker-host.js";
import { buildDescriptionsPdf, parseDescriptionsQuery, selectDescriptionBlocks } from "../../course-maps/descriptions-pdf.js";
import { applyEventMap } from "../../event-map.js";
import { clearEventDocumentCaches } from "../../map-store/event-document.js";
import { writeCourseObject } from "../../course-objects.js";
import { applyPatchChange } from "../../map-store/patches.js";
import { exportEventSnapshot, importEventSnapshot, type EventSnapshot } from "../../sync/lease.js";
import { fetchSnapshotBlobs } from "../../sync/snapshotMaps.js";
import { fetchSnapshotGraphics } from "../../sync/snapshotGraphics.js";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";

const fixture = resolve(__dirname, "../../../../../e2e/test.ocd");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><rect width="20" height="10" fill="#c00"/><circle cx="10" cy="5" r="3" fill="#fff"/></svg>');
const suffix = randomBytes(4).toString("hex");

let vec: TestEventContext;
let server: FastifyInstance;
let clubId: number;

/** Everything the box prints, as the routes answer it. */
interface Prints {
  mapsPdf: Buffer;
  job: PrintJob;
  /** `print.png` of every graphic in the job, by id. */
  pngs: Map<number, Buffer>;
  descriptionsPdf: Buffer;
}

async function printAll(nameId: string): Promise<Prints> {
  clearEventDocumentCaches();
  const get = (url: string) => server.inject({ method: "GET", url });
  const pdf = await get(`/api/maps/${nameId}/maps.pdf`);
  expect(pdf.statusCode).toBe(200);
  const jobRes = await get(`/api/maps/${nameId}/print-job`);
  expect(jobRes.statusCode).toBe(200);
  const job = jobRes.json() as PrintJob;
  const pngs = new Map<number, Buffer>();
  for (const g of job.graphics) {
    const res = await get(`/api/maps/${nameId}/graphics/${g.id}/print.png${g.mime === "image/svg+xml" ? "?w=40&h=20" : ""}`);
    expect(res.statusCode).toBe(200);
    pngs.set(g.id, res.rawPayload);
  }
  // The route's own reads and writer, deterministic like maps.pdf above (the route takes no writer option).
  const db = vec.db;
  const event = await db.event.findUniqueOrThrow({ where: { nameId } });
  const request = parseDescriptionsQuery({});
  const blocks = await selectDescriptionBlocks(db, event, request);
  expect(blocks.length).toBeGreaterThan(0);
  const descriptions = await buildDescriptionsPdf({ blocks, request, mode: "cmyk", deterministic: true, info: { title: `${event.name} descriptions` } });
  return { mapsPdf: pdf.rawPayload, job, pngs, descriptionsPdf: Buffer.from(descriptions.bytes) };
}

beforeAll(async () => {
  vec = await createTestEvent("venue_print");
  const bytes = Buffer.concat([readFileSync(fixture), Buffer.from(`venue-print-${suffix}`)]);
  const applied = await applyEventMap(vec.db, vec.eventId, "test.ocd", bytes);
  clearEventDocumentCaches();
  // The event's patch (G14) prints too; on the box it is the snapshot's `maps.patch`.
  await applyPatchChange(vec.db, vec.eventId, applied.documentHash!, { put: [{ op: "hide", sourceIndex: 3 }] });

  const db = vec.db;
  const PNG = await sharp({ create: { width: 4, height: 2, channels: 4, background: "#00a000" } }).png().toBuffer();
  const graphic = async (eventId: bigint | null, name: string, mime: string, data: Buffer) =>
    Number((await db.graphic.create({ data: { eventId, name, mime, data, sizeBytes: data.length } })).id);
  const pngId = await graphic(vec.eventId, "logo.png", "image/png", PNG);
  const svgId = await graphic(vec.eventId, "logo.svg", "image/svg+xml", SVG);
  clubId = await graphic(null, `club-${suffix}.png`, "image/png", PNG);

  const mk = (codes: string, xpos: number, ypos: number, extra: Record<string, unknown> = {}) => db.control.create({ data: { eventId: vec.eventId, codes, xpos, ypos, ...extra } });
  const c31 = await mk("31", -80, 0, { description: { d: "2.004" } });
  const c32 = await mk("32", -60, 15, { description: { d: "1.010", s: "1,5" } });
  await mk("", -95, -10, { status: "start" });
  const template = await db.mapTemplate.create({
    data: {
      eventId: vec.eventId,
      name: "A4",
      printScale: 7500,
      settings: { printMarginMm: 3, mapFrame: { x: 8, y: 8, width: 194, height: 281 }, description: { visible: true, x: 150, y: 12, cellSizeMm: 6 }, appearance: defaultMapAppearance },
      objects: [
        { id: "title", anchor: "page", kind: "text", x: 12, y: 284, text: "{event} · {course}", fontSizeMm: 5, color: "#000000" },
        { id: "logo", anchor: "page", kind: "image", graphicId: pngId, x: 12, y: 260, width: 20, height: 10 },
        { id: "club", anchor: "page", kind: "image", graphicId: clubId, x: 70, y: 260, width: 8, height: 4 },
      ],
    },
  });
  const blue = await db.course.create({
    data: { eventId: vec.eventId, name: "Blå", lengthM: 2300, climbM: 45, courseControls: { create: [{ position: 1, controlId: c31.id }, { position: 2, controlId: c32.id }] } },
  });
  await db.courseMap.create({ data: { eventId: vec.eventId, name: "Blå A4", kind: "course", courseId: blue.id, templateId: template.id, windowCenter: { x: -70, y: 5 } } });
  await db.courseMap.create({ data: { eventId: vec.eventId, name: "Alla", kind: "all_controls", templateId: template.id, windowCenter: { x: -70, y: 5 }, sortOrder: 1 } });
  await db.class.create({ data: { eventId: vec.eventId, name: "H21", courseId: blue.id, sheetTemplateId: template.id } });
  // An image course object drawing the event's SVG: its graphic travels too.
  await writeCourseObject(db, vec.eventId, {
    body: { kind: "image", geometry: [{ x: -90, y: -5 }, { x: -78, y: 1 }], props: { graphicId: svgId } },
    scope: { courses: [blue.id], classes: [] },
  });

  server = Fastify({ logger: false });
  registerCourseMapRoutes(server, { renderCoursePages: (o) => renderCoursePagesInWorker({ ...o, deterministic: true }) });
  await server.ready();
}, 120_000);

afterAll(async () => {
  await server?.close();
  await vec?.db.graphic.deleteMany({ where: { id: BigInt(clubId) } });
  await vec?.db.event.deleteMany({ where: { nameId: vec.nameId } });
  await disconnect();
});

describe("printing on a venue box from its checkout copy (course-print.md §8.7)", () => {
  it("answers maps.pdf, print-job, print.png and the description sheets with the cloud's exact bytes", async () => {
    const cloud = await printAll(vec.nameId);
    expect(cloud.job.graphics.map((g) => g.id)).toContain(clubId);
    expect(cloud.job.graphics).toHaveLength(3);
    expect(Object.keys(cloud.job.document.patch?.patch.ops ?? {})).toEqual(["hide:3"]);

    // The checkout: the snapshot as HTTP delivers it, the graphics' bytes from the cloud's rows.
    const snapshot = JSON.parse(JSON.stringify(await exportEventSnapshot(vec.db, vec.event))) as EventSnapshot;
    expect(snapshot.graphics?.map((g) => g.club)).toEqual([false, false, true]);
    const cloudBytes = new Map(
      (await vec.db.graphic.findMany({ where: { id: { in: snapshot.graphics!.map((g) => BigInt(g.id)) } } })).map((g) => [g.id.toString(), Buffer.from(g.data)]),
    );
    // The box never held the club graphic.
    await vec.db.graphic.delete({ where: { id: BigInt(clubId) } });
    const blobs = await fetchSnapshotBlobs(vec.db, snapshot.maps!, async () => {
      throw new Error("the box holds the map blobs already");
    });
    const graphicBlobs = await fetchSnapshotGraphics(vec.db, snapshot.graphics!, async (id, start, length) => {
      const b = cloudBytes.get(id)!;
      return { base64: b.subarray(start, start + length).toString("base64"), sizeBytes: b.length };
    });
    expect([...graphicBlobs.bytes.keys()].sort()).toEqual([...cloudBytes.keys()].sort());
    const box = await importEventSnapshot(vec.db, snapshot, blobs, graphicBlobs);
    expect(box.id).not.toBe(vec.eventId); // the box's own event row

    const venue = await printAll(vec.nameId);
    expect(venue.job).toEqual(cloud.job);
    expect([...venue.pngs.keys()]).toEqual([...cloud.pngs.keys()]);
    for (const [id, png] of cloud.pngs) expect(venue.pngs.get(id)!.equals(png)).toBe(true);
    expect(venue.mapsPdf.equals(cloud.mapsPdf)).toBe(true);
    expect(venue.descriptionsPdf.equals(cloud.descriptionsPdf)).toBe(true);
  }, 120_000);
});
