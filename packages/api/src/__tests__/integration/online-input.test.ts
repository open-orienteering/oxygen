/**
 * Online-input integration tests.
 *
 * Covers the full ROC ingestion path: persisted config → `pollOnceForEvent`
 * → parsed punches → `loadMapping` rewrite → `punches` insert with
 * control resolution.
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
import { saveMapping } from "../../online-input/mapping.js";

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
      // 100 → finish (2). The raw 100 should never hit `control_code`.
      await saveMapping(f.ctx.nameId, { "100": 2 });

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
});
