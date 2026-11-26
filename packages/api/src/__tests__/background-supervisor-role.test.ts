/**
 * SYNC-14: the LiveResults pusher is single-owner and the cloud owns it.
 * A venue box reconciles the ROC puller, the shipper and storage GC, but
 * never arms a LiveResults timer.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const calls = vi.hoisted(() => ({ pushers: 0, pullers: 0, pusherStops: 0, shipper: 0, gc: 0 }));

vi.mock("../liveresults.js", () => ({
  reconcileEnabledPushers: async () => {
    calls.pushers++;
  },
  liveResultsPusherManager: {
    stopAll: () => {
      calls.pusherStops++;
    },
  },
}));
vi.mock("../online-input/puller.js", () => ({
  reconcileEnabledPullers: async () => {
    calls.pullers++;
  },
  stopAllPullers: () => {},
}));
vi.mock("../sync/shipper.js", () => ({
  startShipper: () => {
    calls.shipper++;
  },
  stopShipper: () => {},
}));
vi.mock("../map-store/gc.js", () => ({
  maybeStartStorageGc: async () => {
    calls.gc++;
  },
  stopStorageGc: () => {},
}));

const { defaultJobs, publishesLiveResults } = await import("../background/supervisor.js");

describe("defaultJobs.reconcile by node role (SYNC-14)", () => {
  const saved = process.env.NODE_ROLE;
  beforeEach(() => {
    Object.assign(calls, { pushers: 0, pullers: 0, pusherStops: 0, shipper: 0, gc: 0 });
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.NODE_ROLE;
    else process.env.NODE_ROLE = saved;
  });

  it("a venue node never reconciles the LiveResults pusher, and drops any timer", async () => {
    process.env.NODE_ROLE = "venue";
    expect(publishesLiveResults()).toBe(false);
    await defaultJobs.reconcile();
    expect(calls.pushers).toBe(0);
    expect(calls.pusherStops).toBe(1);
    // The rest of the jobs still run on the box.
    expect(calls.pullers).toBe(1);
    expect(calls.shipper).toBe(1);
    expect(calls.gc).toBe(1);
  });

  it("a cloud node reconciles both the pusher and the puller", async () => {
    process.env.NODE_ROLE = "cloud";
    expect(publishesLiveResults()).toBe(true);
    await defaultJobs.reconcile();
    expect(calls.pushers).toBe(1);
    expect(calls.pullers).toBe(1);
    expect(calls.pusherStops).toBe(0);
  });

  it("the default role (unset) is the cloud", async () => {
    delete process.env.NODE_ROLE;
    await defaultJobs.reconcile();
    expect(calls.pushers).toBe(1);
  });
});
