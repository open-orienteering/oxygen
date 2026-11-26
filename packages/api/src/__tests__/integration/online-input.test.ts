/**
 * Online-input integration tests.
 *
 * Covers the full ROC ingestion path: persisted config → `pollOnceForEvent`
 * → parsed punches → control mapping from the config → `punches` insert
 * with control resolution, plus the router writes that share the config
 * row with the puller's watermark.
 *
 * The remote service is mocked at the `fetch` level so we don't depend on
 * ROC's actual servers. The matcher / kiosk pipelines are *not* exercised
 * here — they have their own integration suites.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createTestEvent, disconnect } from "../helpers/test-db.js";
import { getSetting, setSetting } from "../../db.js";
import {
  pollOnceForEvent,
  setPullerEnabled,
} from "../../online-input/puller.js";
import { makeCaller } from "../helpers/caller.js";

function cfgKey(eventId: bigint): string {
  return `online_input_${String(eventId)}_config`;
}

async function readConfig(eventId: bigint) {
  return JSON.parse((await getSetting(cfgKey(eventId))) ?? "{}") as {
    lastId: number;
    mapping: Record<string, number>;
    unitId: string;
    intervalSeconds: number;
  };
}

function rocBody(rows: string[]): Response {
  return new Response(rows.join("\n"), {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}

afterAll(async () => {
  await disconnect();
});

interface FixtureCtx {
  ctx: Awaited<ReturnType<typeof createTestEvent>>;
  fetchSpy: ReturnType<typeof vi.spyOn>;
}

async function setupPuller(label: string): Promise<FixtureCtx> {
  const ctx = await createTestEvent(label);

  // Persist the operator-editable config keyed by event id.
  await setSetting(
    `online_input_${String(ctx.eventId)}_config`,
    JSON.stringify({
      enabled: true,
      protocol: "roc",
      unitId: "12345",
      endpointUrl: "http://roc.test/getpunches.asp",
      intervalSeconds: 10,
      mapping: {},
      lastId: 0,
    }),
  );

  // Two controls so the puller can resolve `control_id` for one and
  // leave the other as a free punch.
  await ctx.db.control.create({
    data: { eventId: ctx.eventId, codes: "31", name: "" },
  });
  await ctx.db.control.create({
    data: { eventId: ctx.eventId, codes: "32", name: "" },
  });

  const fetchSpy = vi.spyOn(globalThis, "fetch");
  return { ctx, fetchSpy };
}

async function teardown({ ctx, fetchSpy }: FixtureCtx) {
  fetchSpy.mockRestore();
  // Wipe the per-event settings rows we wrote so leftover state can't
  // bleed into adjacent suites that happen to reuse the same numeric id.
  await Promise.all(
    [
      "config",
      "last_polled",
      "poll_count",
      "punches_imported",
      "last_error",
    ].map((k) =>
      setSetting(`online_input_${String(ctx.eventId)}_${k}`, null),
    ),
  );
  await ctx.cleanup();
}

describe("online-input ROC puller", () => {
  it("ingests punches and advances lastId / counters", async () => {
    const f = await setupPuller("oi-basic");
    try {
      f.fetchSpy.mockResolvedValue(
        new Response(
          // ROC format: punchId;controlCode;cardNo;YYYY-MM-DD HH:MM:SS
          [
            "1;31;1001;2026-01-01 10:00:00",
            "2;32;1002;2026-01-01 10:01:00",
            "3;99;1003;2026-01-01 10:02:00", // unknown control — free punch
          ].join("\n"),
          { status: 200, headers: { "Content-Type": "text/plain" } },
        ),
      );

      const stats = await pollOnceForEvent(f.ctx.eventId);
      expect(stats).toEqual({ fetched: 3, inserted: 3 });

      const punches = await f.ctx.db.punch.findMany({
        where: { eventId: f.ctx.eventId, source: "online_input" },
        orderBy: { time: "asc" },
        select: {
          cardNo: true,
          controlCode: true,
          controlId: true,
          time: true,
        },
      });
      expect(punches.map((p) => p.cardNo)).toEqual([1001, 1002, 1003]);
      // Control 31 + 32 should be resolved; 99 should be a free punch.
      const codes31 = punches.find((p) => p.controlCode === 31);
      const codes32 = punches.find((p) => p.controlCode === 32);
      const codes99 = punches.find((p) => p.controlCode === 99);
      expect(codes31?.controlId).not.toBeNull();
      expect(codes32?.controlId).not.toBeNull();
      expect(codes99?.controlId).toBeNull();

      // Time is stored as ZeroTime-relative deciseconds; ZeroTime defaults
      // to 09:00:00 (324000), 10:00:00 absolute → 36000 relative.
      expect(codes31?.time).toBe(36000);

      const cfgRaw = await getSetting(
        `online_input_${String(f.ctx.eventId)}_config`,
      );
      const cfg = JSON.parse(cfgRaw ?? "{}");
      expect(cfg.lastId).toBe(3);

      // Status counters should match.
      const pollCount = await getSetting(
        `online_input_${String(f.ctx.eventId)}_poll_count`,
      );
      const imported = await getSetting(
        `online_input_${String(f.ctx.eventId)}_punches_imported`,
      );
      expect(pollCount).toBe("1");
      expect(imported).toBe("3");
    } finally {
      await teardown(f);
    }
  });

  it("journals a punch.recorded (absolute ds) per ingested punch", async () => {
    const f = await setupPuller("oi-journal");
    try {
      f.fetchSpy.mockResolvedValue(
        new Response(
          [
            "1;31;2001;2026-01-01 10:00:00",
            "2;32;2002;2026-01-01 10:01:00",
          ].join("\n"),
          { status: 200 },
        ),
      );

      await pollOnceForEvent(f.ctx.eventId);

      const entries = await f.ctx.db.journalEntry.findMany({
        where: { eventId: f.ctx.eventId, type: "punch.recorded" },
        orderBy: { hlc: "asc" },
      });
      expect(entries.length).toBe(2);
      // Provenance station id carries the ROC unit; payload time is ABSOLUTE
      // deciseconds (10:00:00 = 360000), not the ZeroTime-relative stored form.
      expect(entries[0].stationId).toBe("roc-12345");
      expect(entries[0].payload).toMatchObject({
        cardNo: 2001,
        controlCode: 31,
        time: 360000,
        origin: "online_input",
      });
    } finally {
      await teardown(f);
    }
  });

  it("re-polling never re-inserts already-seen punches", async () => {
    const f = await setupPuller("oi-dedupe");
    try {
      f.fetchSpy.mockResolvedValueOnce(
        new Response("1;31;9001;2026-01-01 10:00:00", { status: 200 }),
      );
      f.fetchSpy.mockResolvedValueOnce(
        // Same row + a new one — only id=2 should land in `punches`.
        new Response(
          ["1;31;9001;2026-01-01 10:00:00", "2;32;9002;2026-01-01 10:01:00"].join(
            "\n",
          ),
          { status: 200 },
        ),
      );

      const first = await pollOnceForEvent(f.ctx.eventId);
      const second = await pollOnceForEvent(f.ctx.eventId);

      expect(first.inserted).toBe(1);
      expect(second.inserted).toBe(1);

      const count = await f.ctx.db.punch.count({
        where: { eventId: f.ctx.eventId, source: "online_input" },
      });
      expect(count).toBe(2);
    } finally {
      await teardown(f);
    }
  });

  it("applies the per-event control mapping (start / finish / check)", async () => {
    const f = await setupPuller("oi-mapping");
    try {
      // 100 → finish (2), set the way the Event page sets it. The raw 100
      // should never hit `control_code`.
      const caller = makeCaller(f.ctx.event);
      await caller.onlineInput.addMapping({ rawCode: 100, target: 2 });
      expect((await readConfig(f.ctx.eventId)).mapping).toEqual({ "100": 2 });

      f.fetchSpy.mockResolvedValue(
        new Response("1;100;7777;2026-01-01 10:30:00", { status: 200 }),
      );

      await pollOnceForEvent(f.ctx.eventId);

      const punch = await f.ctx.db.punch.findFirst({
        where: { eventId: f.ctx.eventId, cardNo: 7777 },
      });
      expect(punch?.controlCode).toBe(2);
      // No control row at code 2 exists yet — should be a free punch.
      expect(punch?.controlId).toBeNull();
    } finally {
      await teardown(f);
    }
  });

  it("records HTTP errors in last_error without crashing", async () => {
    const f = await setupPuller("oi-error");
    try {
      f.fetchSpy.mockResolvedValue(new Response("", { status: 503 }));

      const stats = await pollOnceForEvent(f.ctx.eventId);
      expect(stats.inserted).toBe(0);

      const lastError = await getSetting(
        `online_input_${String(f.ctx.eventId)}_last_error`,
      );
      expect(lastError).toMatch(/HTTP 503/);
    } finally {
      await teardown(f);
    }
  });

  it("skips polling when the puller is disabled", async () => {
    const f = await setupPuller("oi-disabled");
    try {
      const cfgRaw = await getSetting(
        `online_input_${String(f.ctx.eventId)}_config`,
      );
      const cfg = JSON.parse(cfgRaw ?? "{}");
      cfg.enabled = false;
      await setSetting(
        `online_input_${String(f.ctx.eventId)}_config`,
        JSON.stringify(cfg),
      );

      const stats = await pollOnceForEvent(f.ctx.eventId);
      expect(stats).toEqual({ fetched: 0, inserted: 0 });
      expect(f.fetchSpy).not.toHaveBeenCalled();
    } finally {
      await teardown(f);
    }
  });

  it("setPullerEnabled idempotent — starting twice keeps a single handle", async () => {
    const f = await setupPuller("oi-restart");
    try {
      f.fetchSpy.mockResolvedValue(new Response("", { status: 200 }));
      await setPullerEnabled(f.ctx.eventId, true);
      await setPullerEnabled(f.ctx.eventId, true);
      await setPullerEnabled(f.ctx.eventId, false);
      // No assertion beyond "no crash" — the registry state is module-
      // private. A leaked timer would leave Vitest hanging at process
      // exit so this is a sufficient smoke check.
    } finally {
      await teardown(f);
    }
  });

  it("imports a punch range exactly once when two pollers race it", async () => {
    // The background-jobs lease should mean a single poller, but
    // leadership changes hands and ROC de-dupes purely by watermark, so
    // the import has to be safe on its own. Duplicate punches are not
    // something an operator can easily unpick after the fact.
    const f = await setupPuller("oi-race");
    try {
      f.fetchSpy.mockResolvedValue(
        new Response(
          [
            "1;31;1001;2026-01-01 10:00:00",
            "2;32;1002;2026-01-01 10:01:00",
            "3;31;1003;2026-01-01 10:02:00",
          ].join("\n"),
          { status: 200, headers: { "Content-Type": "text/plain" } },
        ),
      );

      const [a, b] = await Promise.all([
        pollOnceForEvent(f.ctx.eventId),
        pollOnceForEvent(f.ctx.eventId),
      ]);

      const punches = await f.ctx.db.punch.findMany({
        where: { eventId: f.ctx.eventId, source: "online_input" },
        select: { cardNo: true },
      });
      expect(punches).toHaveLength(3);
      expect(punches.map((p) => p.cardNo).sort()).toEqual([1001, 1002, 1003]);

      // Exactly one of the two claimed the range; the loser wrote nothing.
      expect([a.inserted, b.inserted].filter((n) => n > 0)).toHaveLength(1);

      // The watermark moved once, so a third poll of the same response
      // is a no-op.
      const again = await pollOnceForEvent(f.ctx.eventId);
      expect(again).toEqual({ fetched: 0, inserted: 0 });

      const journal = await f.ctx.db.journalEntry.count({
        where: { eventId: f.ctx.eventId, type: "punch.recorded" },
      });
      expect(journal).toBe(3);
    } finally {
      await teardown(f);
    }
  });

  it("removeMapping stops rewriting the code on the next poll", async () => {
    const f = await setupPuller("oi-unmap");
    try {
      const caller = makeCaller(f.ctx.event);
      await caller.onlineInput.addMapping({ rawCode: 100, target: 2 });
      await caller.onlineInput.removeMapping({ rawCode: 100 });
      expect((await readConfig(f.ctx.eventId)).mapping).toEqual({});

      f.fetchSpy.mockResolvedValue(rocBody(["1;100;7778;2026-01-01 10:30:00"]));
      await pollOnceForEvent(f.ctx.eventId);

      const punch = await f.ctx.db.punch.findFirst({
        where: { eventId: f.ctx.eventId, cardNo: 7778 },
      });
      expect(punch?.controlCode).toBe(100);
    } finally {
      await teardown(f);
    }
  });

  it("keeps importing after Reset last id: stored punches are skipped, new ones added", async () => {
    const f = await setupPuller("oi-reset");
    try {
      const caller = makeCaller(f.ctx.event);
      const rows = [
        "1;31;5001;2026-01-01 10:00:00",
        "2;32;5002;2026-01-01 10:01:00",
      ];
      f.fetchSpy.mockResolvedValueOnce(rocBody(rows));
      expect(await pollOnceForEvent(f.ctx.eventId)).toEqual({ fetched: 2, inserted: 2 });

      await caller.onlineInput.clearLastId();
      expect((await readConfig(f.ctx.eventId)).lastId).toBe(0);

      // ROC answers lastId=0 with everything again, plus one new punch.
      f.fetchSpy.mockResolvedValueOnce(
        rocBody([...rows, "3;31;5003;2026-01-01 10:02:00"]),
      );
      const second = await pollOnceForEvent(f.ctx.eventId);
      expect(second).toEqual({ fetched: 3, inserted: 1 });

      const punches = await f.ctx.db.punch.findMany({
        where: { eventId: f.ctx.eventId, source: "online_input" },
        select: { cardNo: true },
      });
      expect(punches.map((p) => p.cardNo).sort()).toEqual([5001, 5002, 5003]);
      expect((await readConfig(f.ctx.eventId)).lastId).toBe(3);
      expect(
        await getSetting(`online_input_${String(f.ctx.eventId)}_last_error`),
      ).toBeNull();
      expect(
        await getSetting(`online_input_${String(f.ctx.eventId)}_punches_imported`),
      ).toBe("3");
      // Only punches actually stored are journaled.
      const journal = await f.ctx.db.journalEntry.count({
        where: { eventId: f.ctx.eventId, type: "punch.recorded" },
      });
      expect(journal).toBe(3);

      // And the following poll is back to normal.
      f.fetchSpy.mockResolvedValueOnce(rocBody(["4;32;5004;2026-01-01 10:03:00"]));
      expect(await pollOnceForEvent(f.ctx.eventId)).toEqual({ fetched: 1, inserted: 1 });
    } finally {
      await teardown(f);
    }
  });

  it("an out-of-range row is skipped and does not block the rows around it", async () => {
    const f = await setupPuller("oi-range");
    try {
      f.fetchSpy.mockResolvedValueOnce(
        rocBody([
          "1;31;6001;2026-01-01 10:00:00",
          "99999999999;31;6002;2026-01-01 10:01:00",
          "3;32;6003;2026-01-01 10:02:00",
          "4;31;99999999999;2026-01-01 10:03:00",
        ]),
      );
      const stats = await pollOnceForEvent(f.ctx.eventId);
      expect(stats.inserted).toBe(2);

      const punches = await f.ctx.db.punch.findMany({
        where: { eventId: f.ctx.eventId, source: "online_input" },
        select: { cardNo: true },
      });
      expect(punches.map((p) => p.cardNo).sort()).toEqual([6001, 6003]);
      // The watermark stops at the last valid id; the corrupt id never
      // becomes the watermark.
      expect((await readConfig(f.ctx.eventId)).lastId).toBe(3);
      expect(
        await getSetting(`online_input_${String(f.ctx.eventId)}_last_error`),
      ).toBeNull();
    } finally {
      await teardown(f);
    }
  });

  it("reports a non-ROC 200 body as an error and recovers on the next good poll", async () => {
    const f = await setupPuller("oi-html");
    try {
      f.fetchSpy.mockResolvedValueOnce(
        new Response(
          "<!DOCTYPE html>\n<html><body><h1>Sign in</h1></body></html>\n",
          { status: 200, headers: { "Content-Type": "text/html" } },
        ),
      );
      const stats = await pollOnceForEvent(f.ctx.eventId);
      expect(stats).toEqual({ fetched: 0, inserted: 0 });
      const errKey = `online_input_${String(f.ctx.eventId)}_last_error`;
      expect(await getSetting(errKey)).toMatch(/^Unexpected response: <!DOCTYPE html>/);
      expect(
        await getSetting(`online_input_${String(f.ctx.eventId)}_last_polled`),
      ).toBeNull();
      expect((await readConfig(f.ctx.eventId)).lastId).toBe(0);

      f.fetchSpy.mockResolvedValueOnce(rocBody(["1;31;6101;2026-01-01 10:00:00"]));
      expect((await pollOnceForEvent(f.ctx.eventId)).inserted).toBe(1);
      expect(await getSetting(errKey)).toBeNull();
    } finally {
      await teardown(f);
    }
  });

  it("an empty 200 body is still a healthy poll", async () => {
    const f = await setupPuller("oi-empty");
    try {
      f.fetchSpy.mockResolvedValueOnce(new Response("", { status: 200 }));
      await pollOnceForEvent(f.ctx.eventId);
      expect(
        await getSetting(`online_input_${String(f.ctx.eventId)}_last_error`),
      ).toBeNull();
      expect(
        await getSetting(`online_input_${String(f.ctx.eventId)}_last_polled`),
      ).not.toBeNull();
    } finally {
      await teardown(f);
    }
  });

  it("a config save racing a watermark advance does not roll lastId back", async () => {
    const f = await setupPuller("oi-cfg-race");
    try {
      const caller = makeCaller(f.ctx.event);
      const key = cfgKey(f.ctx.eventId);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let locked!: () => void;
      const isLocked = new Promise<void>((r) => (locked = r));

      // Stand-in for a poll: lock the row, wait while the save starts,
      // then move the watermark the way advanceWatermark does and commit.
      const poll = f.ctx.db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM oxygen.settings WHERE key = ${key} FOR UPDATE`;
          locked();
          await gate;
          await tx.$executeRaw`
            UPDATE oxygen.settings
               SET value = jsonb_set(value::jsonb, '{lastId}', to_jsonb(5::bigint))::text
             WHERE key = ${key}
          `;
        },
        { timeout: 10_000 },
      );
      await isLocked;

      const save = caller.onlineInput.saveConfig({ unitId: "54321" });
      // Give the save time to read the row (an unlocked read would see
      // lastId 0 here and write it back after the poll commits).
      await new Promise((r) => setTimeout(r, 300));
      release();
      await poll;
      await save;

      const cfg = await readConfig(f.ctx.eventId);
      expect(cfg.unitId).toBe("54321");
      expect(cfg.lastId).toBe(5);
    } finally {
      await teardown(f);
    }
  });

  it("router writes create the config row when there is none", async () => {
    const ctx = await createTestEvent("oi-fresh");
    try {
      const caller = makeCaller(ctx.event);
      await caller.onlineInput.addMapping({ rawCode: 150, target: 3 });
      const cfg = await readConfig(ctx.eventId);
      expect(cfg.mapping).toEqual({ "150": 3 });
      expect(cfg.lastId).toBe(0);
      expect(cfg.intervalSeconds).toBe(10);
    } finally {
      await setSetting(cfgKey(ctx.eventId), null);
      await ctx.cleanup();
    }
  });
});
