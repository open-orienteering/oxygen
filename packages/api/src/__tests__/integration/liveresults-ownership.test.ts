/**
 * Package 16 (LiveResults) against Postgres:
 *  - MC-29: the tavid is never set by hand and is unique per event.
 *  - MC-28: a soft-deleted event stops publishing and polling; a purge
 *    drops its per-event settings rows.
 *  - SYNC-14 (Sheets half): a readout shipped from another node is not
 *    pushed to the backup sheet again; a station's own push still is.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const sheetPushes = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../sheetsBackup.js", async (orig) => ({
  ...(await orig<typeof import("../../sheetsBackup.js")>()),
  pushToGoogleSheet: () => {
    sheetPushes.count++;
  },
}));

import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import {
  liveResultsPusherManager,
  reconcileEnabledPushers,
} from "../../liveresults.js";
import {
  activePullerEventIds,
  reconcileEnabledPullers,
  stopAllPullers,
} from "../../online-input/puller.js";

let ctx: TestEventContext;

beforeAll(async () => {
  ctx = await createTestEvent("liveresults-own");
});

afterAll(async () => {
  liveResultsPusherManager.stopAll();
  stopAllPullers();
  await ctx.cleanup();
  await disconnect();
});

describe("MC-29: tavid allocation only", () => {
  it("saveConfig ignores a tavid and liveresults.setConfig is gone", async () => {
    const caller = makeCaller(ctx.event);
    await caller.liveresults.saveConfig({ intervalSeconds: 45, tavid: 999_001 } as never);
    const row = await ctx.db.event.findUniqueOrThrow({
      where: { id: ctx.eventId },
      select: { liveresultsTavid: true, liveresultsConfig: true },
    });
    expect(row.liveresultsTavid).toBeNull();
    expect((row.liveresultsConfig as { intervalSeconds: number }).intervalSeconds).toBe(45);
    await expect(
      (caller.liveresults as unknown as { setConfig: (i: unknown) => Promise<unknown> }).setConfig({
        tavid: 999_001,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("two events cannot share a tavid", async () => {
    const other = await createTestEvent("liveresults-own-b");
    try {
      await ctx.db.event.update({ where: { id: ctx.eventId }, data: { liveresultsTavid: 999_002 } });
      await expect(
        other.db.event.update({ where: { id: other.eventId }, data: { liveresultsTavid: 999_002 } }),
      ).rejects.toThrow();
      // NULL stays allowed on any number of events.
      await ctx.db.event.update({ where: { id: ctx.eventId }, data: { liveresultsTavid: null } });
    } finally {
      await other.cleanup();
    }
  });
});

describe("MC-28: a deleted event stops publishing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    liveResultsPusherManager.stopAll();
    stopAllPullers();
  });

  it("the pusher reconcile does not arm a removed event and stops a running timer", async () => {
    const ev = await createTestEvent("liveresults-removed");
    // No real MySQL: record which events the reconcile arms.
    const started: bigint[] = [];
    vi.spyOn(liveResultsPusherManager, "start").mockImplementation((id) => {
      started.push(id);
    });
    try {
      await ev.db.event.update({
        where: { id: ev.eventId },
        data: { liveresultsTavid: 999_003, liveresultsConfig: { enabled: true, intervalSeconds: 30 } },
      });
      await reconcileEnabledPushers();
      expect(started).toContain(ev.eventId);

      vi.restoreAllMocks();
      // A timer for it is running here (stub sync, never reaches MySQL).
      liveResultsPusherManager.start(ev.eventId, 999_003, 30, async () => ({
        runners: 0,
        results: 0,
        splitcontrols: 0,
      }));
      await ev.db.event.update({ where: { id: ev.eventId }, data: { removed: true } });
      const r = await reconcileEnabledPushers();
      expect(r.started).not.toContain(ev.eventId);
      expect(liveResultsPusherManager.isRunning(ev.eventId)).toBe(false);
    } finally {
      await ev.cleanup();
    }
  });

  it("the ROC puller reconcile skips a removed event but keeps its config", async () => {
    const ev = await createTestEvent("roc-removed");
    const key = `online_input_${ev.eventId}_config`;
    try {
      await ev.db.setting.upsert({
        where: { key },
        create: {
          key,
          value: JSON.stringify({ enabled: true, intervalSeconds: 3600, protocol: "roc", endpointUrl: "http://127.0.0.1:9", unitId: "x", lastId: 0 }),
        },
        update: {},
      });
      await ev.db.event.update({ where: { id: ev.eventId }, data: { removed: true } });
      await reconcileEnabledPullers();
      expect(activePullerEventIds()).not.toContain(ev.eventId);
      expect(await ev.db.setting.findUnique({ where: { key } })).not.toBeNull();
    } finally {
      await ev.db.setting.deleteMany({ where: { key } });
      await ev.cleanup();
    }
  });

  it("purgeDeleted removes the event's ROC and LiveResults settings rows, and only those", async () => {
    const ev = await createTestEvent("liveresults-purge");
    const keep = await createTestEvent("liveresults-keep");
    const doomedKeys = [
      `online_input_${ev.eventId}_config`,
      `online_input_${ev.eventId}_poll_count`,
      `liveresults_${ev.eventId}_status`,
    ];
    const keptKeys = [`online_input_${keep.eventId}_config`, `liveresults_${keep.eventId}_status`];
    try {
      for (const key of [...doomedKeys, ...keptKeys]) {
        await ev.db.setting.upsert({ where: { key }, create: { key, value: "{}" }, update: {} });
      }
      await ev.db.event.update({ where: { id: ev.eventId }, data: { removed: true } });
      await makeCaller(null).event.purgeDeleted();
      const left = await ev.db.setting.findMany({
        where: { key: { in: [...doomedKeys, ...keptKeys] } },
        select: { key: true },
      });
      expect(left.map((s) => s.key).sort()).toEqual([...keptKeys].sort());
    } finally {
      await ev.db.setting.deleteMany({ where: { key: { in: [...doomedKeys, ...keptKeys] } } });
      await ev.cleanup();
      await keep.cleanup();
    }
  });
});

describe("SYNC-14: Sheets push only on the node that stored the readout", () => {
  const SECRET = "liveresults-own-secret";
  let prevSecret: string | undefined;
  let card = 93000;

  beforeAll(() => {
    prevSecret = process.env.SYNC_SHARED_SECRET;
    process.env.SYNC_SHARED_SECRET = SECRET;
  });
  afterAll(() => {
    if (prevSecret === undefined) delete process.env.SYNC_SHARED_SECRET;
    else process.env.SYNC_SHARED_SECRET = prevSecret;
  });

  const readout = () => ({
    id: randomUUID(),
    type: "card.read" as never,
    competitionId: ctx.event.nameId,
    stationId: "station-S",
    timestamp: Date.now() + card * 1000,
    payload: {
      cardNo: card++,
      punches: [{ controlCode: 31, time: 360000 }],
      startTime: 359000,
      finishTime: 366000,
      cardType: "SIAC",
    },
  });

  it("a station's own push stores the readout and pushes it to the sheet", async () => {
    sheetPushes.count = 0;
    const res = await makeCaller(ctx.event).events.push({ events: [readout()] });
    expect(res.failed).toEqual([]);
    expect(sheetPushes.count).toBe(1);
  });

  it("a readout shipped by the venue node is stored but not pushed again", async () => {
    sheetPushes.count = 0;
    const e = readout();
    const res = await makeCaller(ctx.event, { syncSecret: SECRET, peerNodeId: "venue-1" } as never).events.push({
      events: [e],
    });
    expect(res.failed).toEqual([]);
    expect(res.synced).toContain(e.id);
    expect(await ctx.db.cardReadout.count({ where: { eventId: ctx.eventId, cardNo: e.payload.cardNo } })).toBe(1);
    expect(sheetPushes.count).toBe(0);
  });
});
