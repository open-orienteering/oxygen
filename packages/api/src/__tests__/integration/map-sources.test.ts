/**
 * `GET /api/map-sources/:hash` (docs/map-storage.md §4.4): the download
 * rules of course.downloadMap / clubMap.download keyed by hash, never the
 * kiosk key, `private, no-store`, and a chunked body streamed in slices —
 * including one above Cloud Run's 32 MiB non-streamed ceiling.
 *
 * Sources are synthetic random bytes: the route never parses them.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, randomBytes } from "crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { SYSTEM_GROUP_IDS } from "@oxygen/shared";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";
import { grantSystemGroup } from "../../permissions.js";
import { MAP_SOURCE_CACHE_CONTROL, registerMapSourceRoutes, streamBlob } from "../../map-store/source-routes.js";
import type { AuthUser } from "../../auth.js";

const suffix = randomBytes(4).toString("hex");
const EMAIL_DOMAIN = `@map-src-${suffix}.example`;
const MiB = 1024 * 1024;
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

let ctx: TestEventContext;
let other: TestEventContext;
let server: FastifyInstance;
let admin: AuthUser;
let manager: AuthUser;
let setter: AuthUser;
let uploader: AuthUser;
let stranger: AuthUser;
let previousAuthMode: string | undefined;
const sources = new Map<string, Buffer>();

async function source(bytes: Buffer, fileName: string): Promise<string> {
  const fileHash = sha256(bytes);
  sources.set(fileHash, bytes);
  await ctx.db.mapSource.create({ data: { fileHash, kind: "ocad", bytes, sizeBytes: bytes.byteLength, fileName } });
  return fileHash;
}

async function mkUser(name: string, isAdmin = false): Promise<AuthUser> {
  return ctx.db.user.create({ data: { email: `${name}${EMAIL_DOMAIN}`, displayName: name, isAdmin, active: true } });
}

const as = (u: AuthUser | null, extra: Record<string, string> = {}) => ({ ...(u ? { "x-forwarded-email": u.email } : {}), ...extra });
const get = (hash: string, headers: Record<string, string> = {}) => server.inject({ method: "GET", url: `/api/map-sources/${hash}`, headers });

let eventSrc: string;
let clubCopySrc: string;
let clubSrc: string;

beforeAll(async () => {
  ctx = await createTestEvent("map_sources");
  other = await createTestEvent("map_sources_other");
  admin = await mkUser("admin", true);
  manager = await mkUser("manager");
  setter = await mkUser("setter");
  uploader = await mkUser("uploader");
  stranger = await mkUser("stranger");
  await grantSystemGroup(ctx.db, { eventId: ctx.eventId, userId: manager.id, groupId: SYSTEM_GROUP_IDS.eventAdmin, grantedBy: admin.id });
  await grantSystemGroup(ctx.db, { eventId: other.eventId, userId: manager.id, groupId: SYSTEM_GROUP_IDS.eventAdmin, grantedBy: admin.id });
  await grantSystemGroup(ctx.db, { eventId: ctx.eventId, userId: setter.id, groupId: SYSTEM_GROUP_IDS.courseSetter, grantedBy: admin.id });
  // Future dates: completed events widen courses.view to every signed-in user.
  for (const ev of [ctx, other]) await ctx.db.event.update({ where: { id: ev.eventId }, data: { kioskKey: `kiosk-${ev.nameId}`, date: new Date("2099-06-01T00:00:00Z") } });

  eventSrc = await source(randomBytes(3 * MiB + 17), "first-name.ocd");
  await ctx.db.mapFile.create({ data: { eventId: ctx.eventId, fileName: "Event map å.ocd", fileData: randomBytes(4), sourceHash: eventSrc } });

  clubCopySrc = await source(randomBytes(2048), "club-copy.ocd");
  await ctx.db.mapFile.create({ data: { eventId: other.eventId, fileName: "adopted.ocd", fileData: randomBytes(4), sourceHash: clubCopySrc, fromClubLibrary: true } });

  clubSrc = await source(randomBytes(4096), "club.ocd");
  const doc = randomBytes(32);
  const docHash = sha256(doc);
  await ctx.db.mapDocument.create({
    data: { hash: docHash, bytes: doc, sizeBytes: doc.byteLength, formatVersion: 1, importerVersion: "test", libraryVersion: "none", sourceHash: clubSrc, header: {}, report: {} },
  });
  const clubMap = await ctx.db.clubMap.create({ data: { name: `Sources ${suffix}` } });
  await ctx.db.clubMapVersion.create({ data: { clubMapId: clubMap.id, seq: 1, sourceHash: clubSrc, documentHash: docHash, uploadedBy: uploader.id } });

  server = Fastify({ logger: false });
  registerMapSourceRoutes(server);
  await server.ready();
  previousAuthMode = process.env.AUTH_MODE;
  process.env.AUTH_MODE = "proxy";
}, 60_000);

afterAll(async () => {
  if (previousAuthMode === undefined) delete process.env.AUTH_MODE;
  else process.env.AUTH_MODE = previousAuthMode;
  await server?.close();
  await ctx.cleanup();
  await other.cleanup();
  await ctx.db.clubMap.deleteMany({ where: { name: { endsWith: suffix } } });
  await ctx.db.mapDocument.deleteMany({ where: { sourceHash: { in: [...sources.keys()] } } });
  await ctx.db.mapSource.deleteMany({ where: { fileHash: { in: [...sources.keys()] } } });
  await ctx.db.user.deleteMany({ where: { email: { endsWith: EMAIL_DOMAIN } } });
  await disconnect();
}, 60_000);

describe("GET /api/map-sources/:hash", () => {
  it("400 on a malformed hash; upper-case is folded", async () => {
    expect((await get("nothex", as(manager))).statusCode).toBe(400);
    expect((await get(eventSrc.toUpperCase(), as(manager, { "x-event-id": ctx.nameId }))).statusCode).toBe(200);
  });

  it("streams the event's own upload to an event manager, as a chunked attachment under the event's file name", async () => {
    const res = await get(eventSrc, as(manager, { "x-event-id": ctx.nameId }));
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["cache-control"]).toBe(MAP_SOURCE_CACHE_CONTROL);
    expect(res.headers["content-disposition"]).toBe(`attachment; filename="Event map _.ocd"; filename*=UTF-8''Event%20map%20%C3%A5.ocd`);
    expect(res.headers["content-length"]).toBeUndefined();
    expect(res.headers["transfer-encoding"]).toBe("chunked");
    expect(res.headers.etag).toBeUndefined();
    expect(res.rawPayload.equals(sources.get(eventSrc)!)).toBe(true);
    // ?event= works as for documents.
    expect((await get(`${eventSrc}?event=${ctx.nameId}`, as(manager))).statusCode).toBe(200);
  });

  it("refuses everyone else: anonymous 401 (kiosk key included), course setter and stranger 403, manager without the event 403", async () => {
    expect((await get(eventSrc)).statusCode).toBe(401);
    expect((await get(eventSrc, { "x-event-id": ctx.nameId, "x-kiosk-key": `kiosk-${ctx.nameId}` })).statusCode).toBe(401);
    expect((await get(eventSrc, as(setter, { "x-event-id": ctx.nameId }))).statusCode).toBe(403);
    expect((await get(eventSrc, as(stranger, { "x-event-id": ctx.nameId }))).statusCode).toBe(403);
    expect((await get(eventSrc, as(manager))).statusCode).toBe(403);
    // Managing another event that does not carry this source is not enough.
    expect((await get(eventSrc, as(manager, { "x-event-id": other.nameId }))).statusCode).toBe(403);
  });

  it("keeps a club-library copy in an event to instance admins", async () => {
    expect((await get(clubCopySrc, as(manager, { "x-event-id": other.nameId }))).statusCode).toBe(403);
    const res = await get(clubCopySrc, as(admin, { "x-event-id": other.nameId }));
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain(`filename="adopted.ocd"`);
  });

  it("gives a club version's source to its uploader and to admins, under the source row's name", async () => {
    const res = await get(clubSrc, as(uploader));
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain(`filename="club.ocd"`);
    expect(res.rawPayload.equals(sources.get(clubSrc)!)).toBe(true);
    expect((await get(clubSrc, as(admin))).statusCode).toBe(200);
    expect((await get(clubSrc, as(stranger))).statusCode).toBe(403);
    expect((await get(clubSrc)).statusCode).toBe(401);
  });

  it("with auth off serves what exists and 404s the rest", async () => {
    process.env.AUTH_MODE = "off";
    try {
      const res = await get(eventSrc);
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-disposition"]).toContain(`filename="first-name.ocd"`);
      expect((await get("e".repeat(64))).statusCode).toBe(404);
    } finally {
      process.env.AUTH_MODE = "proxy";
    }
  });

  it("streams a source above 32 MiB intact, without a Content-Length", async () => {
    const big = randomBytes(33 * MiB + 5);
    const hash = await source(big, "big.ocd");
    await ctx.db.mapFile.create({ data: { eventId: ctx.eventId, fileName: "big.ocd", fileData: randomBytes(4), sourceHash: hash } });
    const res = await get(hash, as(manager, { "x-event-id": ctx.nameId }));
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-length"]).toBeUndefined();
    expect(res.rawPayload.byteLength).toBe(big.byteLength);
    expect(sha256(res.rawPayload)).toBe(hash);
  }, 60_000);
});

describe("streamBlob", () => {
  it("reads the blob in slices of the given size", async () => {
    const bytes = sources.get(eventSrc)!;
    const chunks: Buffer[] = [];
    for await (const c of streamBlob(ctx.db, "map_sources", eventSrc, bytes.byteLength, MiB)) chunks.push(c as Buffer);
    expect(chunks.map((c) => c.byteLength)).toEqual([MiB, MiB, MiB, 17]);
    expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
  });

  it("errors when the row no longer matches the planned size", async () => {
    const bytes = sources.get(clubSrc)!;
    const read = async () => {
      for await (const _ of streamBlob(ctx.db, "map_sources", clubSrc, bytes.byteLength + 10, 1024)) void _;
    };
    await expect(read()).rejects.toThrow(/changed while streaming/);
    const gone = async () => {
      for await (const _ of streamBlob(ctx.db, "map_sources", "0".repeat(64), 10, 1024)) void _;
    };
    await expect(gone()).rejects.toThrow(/changed while streaming/);
  });
});
