/**
 * What a venue's forwarded call may do on the cloud (API-29 / MC-24, package 20).
 *
 * The call carries the node secret and the forwarded marker, so `ctx.nodeForward`
 * is set and `ctx.user` is null. On an event whose active lease the node holds it
 * has every capability (the event is checked out to it); on any other event none;
 * it is never an instance admin.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { acquireLease } from "../../sync/lease.js";
import { appRouter } from "../../routers/index.js";
import { createContext } from "../../trpc.js";
import { registerVenueForwarder } from "../../sync/venueForwarder.js";
import { grantSystemGroup } from "../../permissions.js";
import { SYSTEM_GROUP_IDS } from "@oxygen/shared";
import Fastify from "fastify";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import http from "node:http";

let held: TestEventContext;
let other: TestEventContext;
let free: TestEventContext;

const forwarded = (event: TestEventContext["event"], nodeId: string | null = "venue-fwd") =>
  makeCaller(event, { user: null, identityEmail: null, authEnabled: true, authMode: "proxy", nodeForward: { nodeId } });

beforeAll(async () => {
  held = await createTestEvent("fwd_held");
  other = await createTestEvent("fwd_other");
  free = await createTestEvent("fwd_free");
  await acquireLease(held.db, held.eventId, "venue-fwd");
  await acquireLease(other.db, other.eventId, "some-other-venue");
});

afterAll(async () => {
  await held.cleanup();
  await other.cleanup();
  await free.cleanup();
  await disconnect();
});

describe("a forwarded call holds capabilities only where its node holds the lease", () => {
  it("may change a cloud-owned event setting of an event checked out to it", async () => {
    const res = await forwarded(held.event).event.updateType({ kind: "training" });
    expect(res).toMatchObject({ kind: "training" });
  });

  it("is refused on an event another node holds, and on one nobody holds", async () => {
    await expect(forwarded(other.event).event.updateType({ kind: "training" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(forwarded(free.event).event.updateType({ kind: "training" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("a node that did not name itself holds nothing", async () => {
    await expect(forwarded(held.event, null).event.updateType({ kind: "training" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("is never an administrator", async () => {
    await expect(forwarded(held.event).eventor.setKey({ apiKey: "deadbeef", env: "test" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(forwarded(held.event).eventor.clearKey({ env: "test" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("event.delete, event.create and eventor.importEvent are refused to a node, even for its own event", async () => {
    for (const nameId of [other.nameId, free.nameId, held.nameId]) {
      await expect(forwarded(null).event.delete({ nameId })).rejects.toMatchObject({ code: "FORBIDDEN", message: /Do this on the cloud/ });
    }
    await expect(forwarded(null).event.create({ name: "Ownerless", date: "2099-01-01" })).rejects.toMatchObject({ code: "FORBIDDEN", message: /Do this on the cloud/ });
    await expect(
      forwarded(null).eventor.importEvent({ eventId: 1, eventName: "X", eventDate: "2099-01-01", classificationId: 0 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: /Do this on the cloud/ });
    // Still there.
    expect(await held.db.event.findUnique({ where: { id: held.eventId }, select: { removed: true } })).toEqual({ removed: false });
  });

  it("event.list shows a node only the events whose lease it holds", async () => {
    const names = (await forwarded(null).event.list()).map((e) => e.nameId);
    expect(names).toContain(held.nameId);
    expect(names).not.toContain(other.nameId);
    expect(names).not.toContain(free.nameId);
    expect((await forwarded(null, null).event.list()).map((e) => e.nameId)).toEqual([]);
  });

  it("mapPatch.promote passes the gate for the node that holds the lease and not for others", async () => {
    // No map on this event: the handler's own refusal, never FORBIDDEN / UNAUTHORIZED, for the holder.
    await expect(forwarded(held.event).mapPatch.promote({ label: "x" })).rejects.not.toMatchObject({ code: "FORBIDDEN" });
    await expect(forwarded(held.event).mapPatch.promote({ label: "x" })).rejects.not.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(forwarded(other.event).mapPatch.promote({ label: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(forwarded(held.event, null).mapPatch.promote({ label: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("an anonymous call, or a marked one with a wrong secret, gets nothing", async () => {
    const anon = makeCaller(held.event, { user: null, identityEmail: null, authEnabled: true, authMode: "proxy", nodeForward: null });
    await expect(anon.event.updateType({ kind: "training" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});


describe("the context wiring over real HTTP (marker + secret into a procedure)", () => {
  it("runs a marked call with the right secret as the node and refuses a wrong one", async () => {
    const saved = { mode: process.env.AUTH_MODE, secret: process.env.SYNC_SHARED_SECRET };
    process.env.AUTH_MODE = "proxy";
    process.env.SYNC_SHARED_SECRET = "http-secret";
    const app = Fastify({ logger: false });
    await app.register(fastifyTRPCPlugin, { prefix: "/trpc", trpcOptions: { router: appRouter, createContext } });
    await app.ready();
    try {
      const call = (secret: string | null, event: string, node = "venue-fwd") =>
        app.inject({
          method: "POST",
          url: "/trpc/event.updateType",
          headers: {
            "content-type": "application/json",
            "x-event-id": event,
            "x-oxygen-forwarded": "1",
            "x-oxygen-node-id": node,
            "x-forwarded-email": "nobody@example.org",
            ...(secret ? { "x-oxygen-sync-secret": secret } : {}),
          },
          payload: JSON.stringify({ kind: "training" }),
        });
      const ok = await call("http-secret", held.nameId);
      expect(ok.statusCode).toBe(200);
      expect((await call("wrong", held.nameId)).statusCode).toBe(401);
      expect((await call(null, held.nameId)).statusCode).toBe(401);
      expect((await call("http-secret", other.nameId)).statusCode).toBe(403);
      expect((await call("http-secret", held.nameId, "some-other-venue")).statusCode).toBe(403);
    } finally {
      await app.close();
      if (saved.mode === undefined) delete process.env.AUTH_MODE;
      else process.env.AUTH_MODE = saved.mode;
      if (saved.secret === undefined) delete process.env.SYNC_SHARED_SECRET;
      else process.env.SYNC_SHARED_SECRET = saved.secret;
    }
  });
});

describe("the capabilities the box vouches for limit the forwarded call (x-oxygen-forwarded-caps)", () => {
  it("intersects the lease-holder rule with the forwarded set; absent header is as before; unknown names are ignored", async () => {
    const saved = { mode: process.env.AUTH_MODE, secret: process.env.SYNC_SHARED_SECRET };
    process.env.AUTH_MODE = "proxy";
    process.env.SYNC_SHARED_SECRET = "http-secret";
    const app = Fastify({ logger: false });
    await app.register(fastifyTRPCPlugin, { prefix: "/trpc", trpcOptions: { router: appRouter, createContext } });
    await app.ready();
    try {
      // courseObject.reorder needs courses.edit; an id that does not exist answers NOT_FOUND once past the gate.
      const call = (event: string, caps: string | null) =>
        app.inject({
          method: "POST",
          url: "/trpc/courseObject.reorder",
          headers: {
            "content-type": "application/json",
            "x-event-id": event,
            "x-oxygen-forwarded": "1",
            "x-oxygen-node-id": "venue-fwd",
            "x-oxygen-sync-secret": "http-secret",
            ...(caps !== null ? { "x-oxygen-forwarded-caps": caps } : {}),
          },
          payload: JSON.stringify({ ids: [999999] }),
        });
      expect((await call(held.nameId, null)).statusCode).toBe(404);
      expect((await call(held.nameId, "courses.edit")).statusCode).toBe(404);
      expect((await call(held.nameId, "event.view,courses.view,courses.edit,courses.review")).statusCode).toBe(404);
      expect((await call(held.nameId, "bogus.cap, courses.edit")).statusCode).toBe(404);
      // A viewer's set, a manager-only set and an empty set do not include courses.edit.
      expect((await call(held.nameId, "event.view,results.view")).statusCode).toBe(403);
      expect((await call(held.nameId, "event.manage")).statusCode).toBe(403);
      expect((await call(held.nameId, "")).statusCode).toBe(403);
      expect((await call(held.nameId, "nonsense")).statusCode).toBe(403);
      // The lease rule still applies on top of a full set.
      expect((await call(other.nameId, "courses.edit")).statusCode).toBe(403);
    } finally {
      await app.close();
      if (saved.mode === undefined) delete process.env.AUTH_MODE;
      else process.env.AUTH_MODE = saved.mode;
      if (saved.secret === undefined) delete process.env.SYNC_SHARED_SECRET;
      else process.env.SYNC_SHARED_SECRET = saved.secret;
    }
  });
});

describe("the box checks its own caller before lending its authority upstream", () => {
  it("refuses anonymous callers and callers without access; forwards a course setter and a viewer with their own capabilities", async () => {
    const stamp = Math.random().toString(16).slice(2, 8);
    const mk = (label: string, isAdmin = false) =>
      free.db.user.create({ data: { email: `${label}-${stamp}@fwd-gate.example`, displayName: label, isAdmin, active: true } });
    const [member, setter, admin, nobody] = [await mk("m"), await mk("s"), await mk("a", true), await mk("n")];
    await grantSystemGroup(free.db, { eventId: free.eventId, userId: member.id, groupId: SYSTEM_GROUP_IDS.member, grantedBy: admin.id });
    await grantSystemGroup(free.db, { eventId: free.eventId, userId: setter.id, groupId: SYSTEM_GROUP_IDS.courseSetter, grantedBy: admin.id });

    // A finished event gives every signed-in user a view; the "no access" case needs one still to come.
    const originalDate = (await free.db.event.findUniqueOrThrow({ where: { id: free.eventId }, select: { date: true } })).date;
    await free.db.event.update({ where: { id: free.eventId }, data: { date: new Date(Date.now() + 30 * 86_400_000) } });
    const upstreamSeen: Array<{ url: string; caps: string | undefined }> = [];
    const upstream = http.createServer((req, res) => {
      upstreamSeen.push({ url: req.url ?? "", caps: req.headers["x-oxygen-forwarded-caps"] as string | undefined });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ result: { data: { ok: true } } }));
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const saved = { role: process.env.NODE_ROLE, peer: process.env.SYNC_PEER_URL, mode: process.env.AUTH_MODE, secret: process.env.SYNC_SHARED_SECRET, node: process.env.NODE_ID };
    process.env.NODE_ROLE = "venue";
    process.env.SYNC_PEER_URL = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    process.env.AUTH_MODE = "proxy";
    process.env.SYNC_SHARED_SECRET = "box-secret";
    process.env.NODE_ID = "venue-fwd";
    const box = Fastify({ logger: false });
    registerVenueForwarder(box);
    box.post("/trpc/*", async () => ({ local: true }));
    await box.ready();
    try {
      const post = (email: string | null, event: string | null, url = "/trpc/courseObject.reorder") =>
        box.inject({
          method: "POST",
          url,
          headers: { "content-type": "application/json", ...(email ? { "x-forwarded-email": email } : {}), ...(event ? { "x-event-id": event } : {}) },
          payload: "{}",
        });
      expect((await post(null, free.nameId)).statusCode).toBe(401);
      const anon = (await post(null, free.nameId)).json() as { error: { data: { code: string } } };
      expect(anon.error.data.code).toBe("UNAUTHORIZED");
      // Signed in but no access to the event at all: an empty set.
      expect((await post(nobody.email, free.nameId)).statusCode).toBe(403);
      expect(upstreamSeen).toEqual([]);
      // A course setter (courses.edit, no event.manage) is forwarded, carrying exactly their capabilities.
      expect((await post(setter.email, free.nameId)).statusCode).toBe(200);
      expect(upstreamSeen.at(-1)?.caps?.split(",").sort()).toEqual(["courses.edit", "courses.review", "courses.view", "event.view"]);
      // A viewer is forwarded too, but without courses.edit: the cloud refuses the edit (see the caps test above).
      expect((await post(member.email, free.nameId)).statusCode).toBe(200);
      expect(upstreamSeen.at(-1)?.caps?.split(",").sort()).toEqual(["event.view", "results.view"]);
      // No event named: a signed-in user is enough; an admin carries every capability, others none.
      expect((await post(admin.email, null)).statusCode).toBe(200);
      expect(upstreamSeen.at(-1)?.caps?.split(",").length).toBeGreaterThan(5);
      expect((await post(setter.email, null)).statusCode).toBe(200);
      expect(upstreamSeen.at(-1)?.caps).toBe("");
      // A batch gets one refusal per call.
      const batch = await post(nobody.email, free.nameId, "/trpc/club.update,club.create?batch=1");
      expect(batch.statusCode).toBe(403);
      expect((batch.json() as unknown[]).length).toBe(2);
      expect(upstreamSeen).toHaveLength(4);
    } finally {
      await box.close();
      await new Promise<void>((r) => upstream.close(() => r()));
      for (const [k, v] of [["NODE_ROLE", saved.role], ["SYNC_PEER_URL", saved.peer], ["AUTH_MODE", saved.mode], ["SYNC_SHARED_SECRET", saved.secret], ["NODE_ID", saved.node]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await free.db.event.update({ where: { id: free.eventId }, data: { date: originalDate } });
      await free.db.user.deleteMany({ where: { email: { endsWith: "@fwd-gate.example" } } });
    }
  });
});
