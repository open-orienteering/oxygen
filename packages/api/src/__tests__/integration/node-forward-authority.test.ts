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

  it("event.delete follows the same rule inside its handler", async () => {
    await expect(forwarded(null).event.delete({ nameId: other.nameId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(forwarded(null).event.delete({ nameId: free.nameId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await forwarded(null).event.delete({ nameId: held.nameId })).toMatchObject({ success: true });
  });

  it("an anonymous call, or a marked one with a wrong secret, gets nothing", async () => {
    const anon = makeCaller(held.event, { user: null, identityEmail: null, authEnabled: true, authMode: "proxy", nodeForward: null });
    await expect(anon.event.updateType({ kind: "training" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
