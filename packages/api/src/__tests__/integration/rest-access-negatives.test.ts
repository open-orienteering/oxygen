/**
 * REST routes that hand out an event's data answer an anonymous caller 401
 * and a signed-in user without the capability 403 under AUTH_MODE=proxy
 * (API-36 (4), package 20): backups (event.manage), the course-data export
 * and the descriptions PDF (courses.view).
 */
import { randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerBackupRoute } from "../../backup.js";
import { registerCourseExportRoute } from "../../course-export.js";
import { registerDescriptionsPdfRoute } from "../../course-maps/descriptions-pdf.js";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";

const suffix = randomBytes(3).toString("hex");
const DOMAIN = `@rest-negatives-${suffix}.example`;

let ctx: TestEventContext;
let server: FastifyInstance;
let previousAuthMode: string | undefined;
let stranger: string;

beforeAll(async () => {
  ctx = await createTestEvent("rest_negatives");
  // A future date: a member's view of courses opens only after the race.
  await ctx.db.event.update({ where: { id: ctx.eventId }, data: { date: new Date("2099-06-01T00:00:00Z") } });
  const user = await ctx.db.user.create({ data: { email: `stranger${DOMAIN}`, displayName: "Stranger", isAdmin: false, active: true } });
  stranger = user.email;
  server = Fastify({ logger: false });
  registerBackupRoute(server);
  registerCourseExportRoute(server);
  registerDescriptionsPdfRoute(server);
  await server.ready();
  previousAuthMode = process.env.AUTH_MODE;
  process.env.AUTH_MODE = "proxy";
});

afterAll(async () => {
  if (previousAuthMode === undefined) delete process.env.AUTH_MODE;
  else process.env.AUTH_MODE = previousAuthMode;
  await server?.close();
  await ctx.db.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  await ctx.cleanup();
  await disconnect();
});

describe("event data over REST under AUTH_MODE=proxy", () => {
  const urls = () => [
    `/api/backup/event?name=${ctx.nameId}`,
    `/api/backup/competition?name=${ctx.nameId}`,
    `/api/export/course-data?name=${ctx.nameId}`,
    `/api/maps/${ctx.nameId}/descriptions.pdf`,
  ];

  it("answers an anonymous caller 401", async () => {
    for (const url of urls()) {
      expect((await server.inject({ method: "GET", url })).statusCode, url).toBe(401);
    }
  });

  it("answers a signed-in user without a grant on the event 403", async () => {
    for (const url of urls()) {
      expect((await server.inject({ method: "GET", url, headers: { "x-forwarded-email": stranger } })).statusCode, url).toBe(403);
    }
  });

  it("does not take a forwarded-node marker for a credential", async () => {
    for (const url of urls()) {
      const res = await server.inject({ method: "GET", url, headers: { "x-oxygen-forwarded": "1", "x-oxygen-sync-secret": "x", "x-oxygen-node-id": "venue" } });
      expect(res.statusCode, url).toBe(401);
    }
  });
});
