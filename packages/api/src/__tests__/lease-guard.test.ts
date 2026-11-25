/**
 * `mayWriteEventData`: the one guard for "may this node originate race or
 * course data for this event" (review SYNC-08 / D8). A matrix over role,
 * lease rows, holder and a running checkin barrier, against a stub database.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mayWriteEventData } from "../sync/lease.js";
import { beginCheckin, endCheckin, isCheckingIn } from "../sync/leaseState.js";

const EVENT = 7n;

/** A db whose `event_lease` table holds `rows` (newest last). */
function stubDb(rows: Array<{ holderNodeId: string; released: boolean; forced?: boolean }>) {
  return {
    eventLease: {
      findFirst: async (args: { where: { releasedAt?: null } }) => {
        const list = args.where.releasedAt === null ? rows.filter((r) => !r.released) : rows;
        const r = list[list.length - 1];
        return r ? { id: 1n, holderNodeId: r.holderNodeId, acquiredAt: new Date(), forced: r.forced ?? false } : null;
      },
      count: async () => rows.length,
    },
  } as never;
}

function withEnv(role: string | undefined, node: string | undefined) {
  if (role === undefined) delete process.env.NODE_ROLE;
  else process.env.NODE_ROLE = role;
  if (node === undefined) delete process.env.NODE_ID;
  else process.env.NODE_ID = node;
}

const saved = { role: process.env.NODE_ROLE, node: process.env.NODE_ID };
afterEach(() => {
  withEnv(saved.role, saved.node);
  endCheckin(EVENT);
});

describe("mayWriteEventData", () => {
  it("allows a node with no lease rows, whatever its role", async () => {
    withEnv("venue", "box");
    expect(await mayWriteEventData(stubDb([]), EVENT)).toEqual({ ok: true });
    withEnv("cloud", "cloud");
    expect(await mayWriteEventData(stubDb([]), EVENT)).toEqual({ ok: true });
  });

  it("allows the holder of the active lease", async () => {
    withEnv("venue", "box");
    expect(await mayWriteEventData(stubDb([{ holderNodeId: "box", released: false }]), EVENT)).toEqual({ ok: true });
  });

  it("refuses a node when another node holds the lease", async () => {
    withEnv("cloud", "cloud");
    expect(await mayWriteEventData(stubDb([{ holderNodeId: "box", released: false }]), EVENT)).toEqual({
      ok: false,
      reason: "held-elsewhere",
      holder: "box",
    });
  });

  it("refuses a venue box once the lease is released (checked in or taken over)", async () => {
    withEnv("venue", "box");
    const res = await mayWriteEventData(stubDb([{ holderNodeId: "box", released: true }]), EVENT);
    expect(res).toMatchObject({ ok: false, reason: "checked-in" });
  });

  it("allows the cloud once the lease is released", async () => {
    withEnv("cloud", "cloud");
    expect(await mayWriteEventData(stubDb([{ holderNodeId: "box", released: true }]), EVENT)).toEqual({ ok: true });
  });

  it("refuses while this node's checkin barrier runs, even for the holder", async () => {
    withEnv("venue", "box");
    beginCheckin(EVENT);
    expect(await mayWriteEventData(stubDb([{ holderNodeId: "box", released: false }]), EVENT)).toMatchObject({
      ok: false,
      reason: "checking-in",
    });
  });
});

describe("the checkin barrier counts per event", () => {
  it("stays up until every overlapping checkin of the event has ended", () => {
    beginCheckin(EVENT);
    beginCheckin(EVENT);
    expect(isCheckingIn(EVENT)).toBe(true);
    endCheckin(EVENT);
    expect(isCheckingIn(EVENT)).toBe(true);
    endCheckin(EVENT);
    expect(isCheckingIn(EVENT)).toBe(false);
    endCheckin(EVENT); // an extra end never goes negative
    beginCheckin(EVENT);
    expect(isCheckingIn(EVENT)).toBe(true);
    endCheckin(EVENT);
    expect(isCheckingIn(EVENT)).toBe(false);
  });
});
