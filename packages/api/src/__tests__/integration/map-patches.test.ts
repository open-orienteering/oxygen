/**
 * Map patches: storage and delivery (docs/map-patches.md §3; row G3).
 *
 *   - the table: one row per event, defaults, RESTRICT on the document,
 *     cascade with the event
 *   - mapPatch.applyChange merges per op id under the row lock: put / remove /
 *     putSymbols, sorted keys, twice = once (the version too), two writers
 *     on different ids both survive (also the first write), the same id is
 *     last-writer-wins, the refusals (duplicate id, wrong document, no map)
 *   - a dormant row (keyed to another document than the pin): not
 *     delivered, not writable
 *   - mapPatch.setEnabled
 *   - auth: kiosk key and viewer read, cannot write; a stranger cannot read
 *   - GET /api/maps/:nameId/patch: 200 / 304 / 401 / 403 / 404, ETag = version
 *   - course.mapMetadata.patchVersion
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { randomBytes } from "crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { SYSTEM_GROUP_IDS, mapDocument } from "@oxygen/shared";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { grantSystemGroup } from "../../permissions.js";
import { applyEventMap } from "../../event-map.js";
import { decodedDocument } from "../../map-store/event-document.js";
import { MAP_PATCH_CACHE_CONTROL, registerMapDocumentRoutes, resetDocumentAccessCache } from "../../map-store/routes.js";
import { isForeignKeyViolation } from "../../map-store/gc.js";
import type { AuthUser } from "../../auth.js";

const FIXTURE = resolve(__dirname, "../../../../../e2e/test.ocd");
const suffix = randomBytes(4).toString("hex");
const EMAIL_DOMAIN = `@map-patches-${suffix}.example`;
const KIOSK = `kiosk-${suffix}`;
/** A second document for the dormant and RESTRICT cases (never decoded). */
const OTHER_HASH = randomBytes(32).toString("hex");

let ctx: TestEventContext;
let caller: ReturnType<typeof makeCaller>;
let server: FastifyInstance;
let documentHash: string;
let fileHash: string;
let symbol: mapDocument.PatchSymbol;
let member: AuthUser;
let viewer: AuthUser;
let stranger: AuthUser;
let previousAuthMode: string | undefined;
const extraEvents: TestEventContext[] = [];

const hide = (i: number): mapDocument.PatchOp => ({ op: "hide", sourceIndex: i });
const modify = (i: number, x: number): mapDocument.PatchOp => ({ op: "modify", sourceIndex: i, coords: [[x, 0], [x + 100, 0]] });
const ADD_ID = "0190a0a0-0000-7000-8000-00000000000a";

async function mkUser(name: string): Promise<AuthUser> {
  return ctx.db.user.create({ data: { email: `${name}${EMAIL_DOMAIN}`, displayName: name, isAdmin: false, active: true } });
}

async function resetPatch(): Promise<void> {
  await ctx.db.mapPatch.deleteMany({ where: { eventId: ctx.eventId } });
}

const get = (url: string, headers: Record<string, string> = {}) => server.inject({ method: "GET", url, headers });

beforeAll(async () => {
  ctx = await createTestEvent("map_patches");
  caller = makeCaller(ctx.event);
  const fixture = Buffer.concat([readFileSync(FIXTURE), Buffer.from(`map-patches-${suffix}`)]);
  const applied = await applyEventMap(ctx.db, ctx.eventId, "test.ocd", fixture, {});
  documentHash = applied.documentHash!;
  fileHash = (await ctx.db.mapFile.findFirstOrThrow({ where: { eventId: ctx.eventId } })).sourceHash!;

  const doc = await decodedDocument(ctx.db, documentHash);
  const withRender = doc!.header.symbols.find((s) => s.render && s.kind === "line")!;
  symbol = mapDocument.patchSymbolSchema.parse(withRender);

  await ctx.db.mapDocument.create({
    data: {
      hash: OTHER_HASH,
      bytes: Uint8Array.from([1, 2, 3]),
      sizeBytes: 3,
      formatVersion: 1,
      importerVersion: "test",
      libraryVersion: "test",
      sourceHash: fileHash,
      header: {},
      report: {},
    },
  });

  member = await mkUser("member");
  viewer = await mkUser("viewer");
  stranger = await mkUser("stranger");
  await grantSystemGroup(ctx.db, { eventId: ctx.eventId, userId: member.id, groupId: SYSTEM_GROUP_IDS.courseSetter, grantedBy: member.id });
  const group = await ctx.db.permissionGroup.create({ data: { name: `Patch viewer ${suffix}`, capabilities: ["event.view", "courses.view"] } });
  await ctx.db.eventPermission.create({ data: { eventId: ctx.eventId, userId: viewer.id, groupId: group.id } });
  // A future date: a completed event grants courses.view to every signed-in user.
  await ctx.db.event.update({ where: { id: ctx.eventId }, data: { kioskKey: KIOSK, date: new Date("2099-06-01T00:00:00Z") } });
  ctx.event.kioskKey = KIOSK;
  ctx.event.date = new Date("2099-06-01T00:00:00Z");

  server = Fastify({ logger: false });
  registerMapDocumentRoutes(server);
  await server.ready();
  previousAuthMode = process.env.AUTH_MODE;
  process.env.AUTH_MODE = "proxy";
  resetDocumentAccessCache();
}, 60_000);

afterAll(async () => {
  if (previousAuthMode === undefined) delete process.env.AUTH_MODE;
  else process.env.AUTH_MODE = previousAuthMode;
  await server?.close();
  for (const e of extraEvents) await e.cleanup();
  await ctx.cleanup();
  await ctx.db.permissionGroup.deleteMany({ where: { name: `Patch viewer ${suffix}` } });
  await ctx.db.mapDocument.deleteMany({ where: { sourceHash: fileHash } });
  await ctx.db.mapSource.deleteMany({ where: { fileHash } });
  await ctx.db.user.deleteMany({ where: { email: { endsWith: EMAIL_DOMAIN } } });
  await disconnect();
}, 30_000);

describe("mapPatch.applyChange", () => {
  it("answers no patch before the first write", async () => {
    await resetPatch();
    expect(await caller.mapPatch.get()).toEqual({ version: "0", patch: null });
  });

  it("creates the row keyed to the pin and merges put / remove / putSymbols per op id", async () => {
    await resetPatch();
    const first = await caller.mapPatch.applyChange({ documentHash, put: [hide(7), modify(3, 10)] });
    expect(BigInt(first.version)).toBeGreaterThan(0n);
    expect(first.patch).toMatchObject({ documentHash, enabled: true, symbols: {} });
    expect(Object.keys(first.patch!.ops)).toEqual(["hide:7", "modify:3"]);

    const add: mapDocument.PatchOp = { op: "add", id: ADD_ID, type: 2, symbol: { patch: "ISOM2017-2:506" }, coords: [[0, 0], [50, 50]] };
    const second = await caller.mapPatch.applyChange({
      documentHash,
      remove: ["hide:7", "hide:999"],
      put: [{ op: "resymbol", sourceIndex: 3, symbol: { doc: 0 } }, add],
      putSymbols: { "ISOM2017-2:506": symbol },
    });
    expect(second.version).not.toBe(first.version);
    expect(Object.keys(second.patch!.ops)).toEqual([`add:${ADD_ID}`, "modify:3", "resymbol:3"]);
    expect(Object.keys(second.patch!.symbols)).toEqual(["ISOM2017-2:506"]);

    // Stored as the shared merge left it; `get` reads it back equal.
    const row = await ctx.db.mapPatch.findUniqueOrThrow({ where: { eventId: ctx.eventId } });
    expect(row.documentHash).toBe(documentHash);
    expect(row.version.toString()).toBe(second.version);
    expect(await caller.mapPatch.get()).toEqual(second);
  });

  it("applying the same change twice equals once, the version included", async () => {
    const change = { documentHash, put: [hide(11)] };
    const once = await caller.mapPatch.applyChange(change);
    const twice = await caller.mapPatch.applyChange(change);
    expect(twice).toEqual(once);
    // An empty change writes nothing either.
    expect((await caller.mapPatch.applyChange({ documentHash })).version).toBe(once.version);
  });

  it("two writers on different op ids both survive, also when neither found a row", async () => {
    await resetPatch();
    const writers = Array.from({ length: 6 }, (_, i) => caller.mapPatch.applyChange({ documentHash, put: [hide(100 + i)] }));
    await Promise.all(writers);
    expect(await ctx.db.mapPatch.count({ where: { eventId: ctx.eventId } })).toBe(1);
    const now = await caller.mapPatch.get();
    expect(Object.keys(now.patch!.ops)).toEqual(["hide:100", "hide:101", "hide:102", "hide:103", "hide:104", "hide:105"]);
  });

  it("two writers on the same op id: the last one wins whole", async () => {
    await Promise.all([caller.mapPatch.applyChange({ documentHash, put: [modify(5, 1)] }), caller.mapPatch.applyChange({ documentHash, put: [modify(5, 2)] })]);
    const op = (await caller.mapPatch.get()).patch!.ops["modify:5"];
    expect([modify(5, 1), modify(5, 2)]).toContainEqual(op);
  });

  it("refuses a change that names one id twice, ops keyed onto another document, and an event without a map", async () => {
    await expect(caller.mapPatch.applyChange({ documentHash, put: [hide(1), hide(1)] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.mapPatch.applyChange({ documentHash, put: [hide(1)], remove: ["hide:1"] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.mapPatch.applyChange({ documentHash: OTHER_HASH, put: [hide(1)] })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringMatching(/^PATCH_DOCUMENT_MISMATCH/),
    });
    const bare = await createTestEvent("map_patches_bare");
    extraEvents.push(bare);
    const bareCaller = makeCaller(bare.event);
    await expect(bareCaller.mapPatch.applyChange({ documentHash, put: [hide(1)] })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringMatching(/^PATCH_NO_DOCUMENT/),
    });
    await expect(bareCaller.mapPatch.setEnabled({ enabled: false })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await bareCaller.mapPatch.get()).toEqual({ version: "0", patch: null });
    expect(await ctx.db.mapPatch.count({ where: { eventId: bare.eventId } })).toBe(0);
  });
});

describe("mapPatch.setEnabled", () => {
  it("toggles the patch, advancing the version only on a change", async () => {
    await resetPatch();
    const created = await caller.mapPatch.setEnabled({ enabled: true });
    expect(created).toEqual({ version: "0", patch: { documentHash, enabled: true, ops: {}, symbols: {} } });
    await caller.mapPatch.applyChange({ documentHash, put: [hide(2)] });
    const off = await caller.mapPatch.setEnabled({ enabled: false });
    expect(off.patch!.enabled).toBe(false);
    expect(off.patch!.ops).toEqual({ "hide:2": hide(2) });
    expect((await caller.mapPatch.setEnabled({ enabled: false })).version).toBe(off.version);
    // A disabled patch is delivered as it is (§3.3).
    expect(await caller.mapPatch.get()).toEqual(off);
    const on = await caller.mapPatch.setEnabled({ enabled: true });
    expect(on.version).not.toBe(off.version);
    expect(on.patch!.enabled).toBe(true);
  });
});

describe("a dormant patch (§3.2)", () => {
  it("is kept but neither delivered nor writable while the pin names another document", async () => {
    await resetPatch();
    await caller.mapPatch.applyChange({ documentHash, put: [hide(4)] });
    const pin = await ctx.db.mapFile.findFirstOrThrow({ where: { eventId: ctx.eventId } });
    await ctx.db.mapFile.update({ where: { id: pin.id }, data: { documentHash: OTHER_HASH } });
    try {
      expect(await caller.mapPatch.get()).toEqual({ version: "0", patch: null });
      expect((await caller.course.mapMetadata())?.patchVersion).toBe("0");
      for (const write of [caller.mapPatch.applyChange({ documentHash: OTHER_HASH, put: [hide(5)] }), caller.mapPatch.setEnabled({ enabled: false })]) {
        await expect(write).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/^PATCH_STALE/) });
      }
      const row = await ctx.db.mapPatch.findUniqueOrThrow({ where: { eventId: ctx.eventId } });
      expect(row.documentHash).toBe(documentHash);
      expect(row.ops).toEqual({ "hide:4": hide(4) });
    } finally {
      await ctx.db.mapFile.update({ where: { id: pin.id }, data: { documentHash } });
    }
    expect((await caller.mapPatch.get()).patch!.ops).toEqual({ "hide:4": hide(4) });
  });
});

describe("the table", () => {
  it("holds one row per event, RESTRICTs its document and cascades with the event", async () => {
    const other = await createTestEvent("map_patches_table");
    extraEvents.push(other);
    const row = await ctx.db.mapPatch.create({ data: { eventId: other.eventId, documentHash: OTHER_HASH } });
    expect(row).toMatchObject({ enabled: true, ops: {}, symbols: {}, version: 0n });
    await expect(ctx.db.mapPatch.create({ data: { eventId: other.eventId, documentHash: OTHER_HASH } })).rejects.toThrow();
    let deleteError: unknown = null;
    try {
      await ctx.db.mapDocument.delete({ where: { hash: OTHER_HASH } });
    } catch (e) {
      deleteError = e;
    }
    expect(isForeignKeyViolation(deleteError)).toBe(true);
    await ctx.db.event.delete({ where: { id: other.eventId } });
    expect(await ctx.db.mapPatch.count({ where: { id: row.id } })).toBe(0);
  });

  it("refuses an array in ops (08 §4.7's shape)", async () => {
    await resetPatch();
    await expect(ctx.db.$executeRaw`INSERT INTO oxygen.map_patches (event_id, document_hash, ops) VALUES (${ctx.eventId}, ${documentHash}, '[]'::jsonb)`).rejects.toThrow();
  });
});

describe("access", () => {
  it("a kiosk key and a viewer read; neither writes", async () => {
    await resetPatch();
    const written = await caller.mapPatch.applyChange({ documentHash, put: [hide(9)] });
    const kiosk = makeCaller(ctx.event, { user: null, authEnabled: true, authMode: "proxy", kioskKey: KIOSK });
    expect(await kiosk.mapPatch.get()).toEqual(written);
    await expect(kiosk.mapPatch.applyChange({ documentHash, put: [hide(10)] })).rejects.toMatchObject({ code: expect.stringMatching(/UNAUTHORIZED|FORBIDDEN/) });

    const asViewer = makeCaller(ctx.event, { user: viewer, authEnabled: true, authMode: "proxy", identityEmail: viewer.email });
    expect(await asViewer.mapPatch.get()).toEqual(written);
    await expect(asViewer.mapPatch.applyChange({ documentHash, put: [hide(10)] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(asViewer.mapPatch.setEnabled({ enabled: false })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const asStranger = makeCaller(ctx.event, { user: stranger, authEnabled: true, authMode: "proxy", identityEmail: stranger.email });
    await expect(asStranger.mapPatch.get()).rejects.toMatchObject({ code: "FORBIDDEN" });

    const asSetter = makeCaller(ctx.event, { user: member, authEnabled: true, authMode: "proxy", identityEmail: member.email });
    expect((await asSetter.mapPatch.applyChange({ documentHash, put: [hide(10)] })).patch!.ops).toHaveProperty("hide:10");
  });
});

describe("GET /api/maps/:nameId/patch", () => {
  const url = () => `/api/maps/${ctx.nameId}/patch`;

  it("answers the patch with ETag = version, and 304 on revalidation", async () => {
    await resetPatch();
    const none = await get(url(), { "x-kiosk-key": KIOSK });
    expect(none.statusCode).toBe(200);
    expect(none.json()).toEqual({ version: "0", patch: null });
    expect(none.headers.etag).toBe('"0"');
    expect(none.headers["cache-control"]).toBe(MAP_PATCH_CACHE_CONTROL);

    const written = await caller.mapPatch.applyChange({ documentHash, put: [hide(12)] });
    const res = await get(url(), { "x-forwarded-email": member.email });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.json()).toEqual(written);
    expect(res.headers.etag).toBe(`"${written.version}"`);

    const again = await get(url(), { "x-forwarded-email": member.email, "if-none-match": `"${written.version}"` });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe("");
    const stale = await get(url(), { "x-forwarded-email": member.email, "if-none-match": '"0"' });
    expect(stale.statusCode).toBe(200);

    // The descriptor carries the same token.
    expect((await caller.course.mapMetadata())?.patchVersion).toBe(written.version);
  });

  it("admits the kiosk key as a header or ?k=, and refuses the rest", async () => {
    expect((await get(url(), { "x-kiosk-key": KIOSK })).statusCode).toBe(200);
    expect((await get(`${url()}?k=${KIOSK}`)).statusCode).toBe(200);
    expect((await get(url(), { "x-forwarded-email": viewer.email })).statusCode).toBe(200);
    expect((await get(url())).statusCode).toBe(401);
    expect((await get(url(), { "x-kiosk-key": "wrong" })).statusCode).toBe(401);
    expect((await get(url(), { "x-forwarded-email": stranger.email })).statusCode).toBe(403);
    expect((await get(`/api/maps/no_such_event_${suffix}/patch`, { "x-kiosk-key": KIOSK })).statusCode).toBe(404);
  });
});
