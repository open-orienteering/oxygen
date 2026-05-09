/**
 * Integration test for the online-input puller.
 *
 * Spins up a real itest competition database, stubs `fetch` so no HTTP
 * traffic leaves the test, and asserts:
 *   - `pollOnce` writes oPunch rows with the MeOS-compatible Origin checksum,
 *   - `lastId` advances and the second poll is idempotent (zero new inserts),
 *   - control mapping converts a raw code into a special-punch type,
 *   - the boot reconciler refuses to start a puller for orphan settings.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import {
  pollOnce,
  loadConfig,
  persistConfig,
  getLastId,
  setLastId,
  reconcileEnabledPullers,
  onlineInputPuller,
  configKey,
  lastIdKey,
} from "../../online-input/puller.js";
import { addMapping, mappingKey, removeMapping } from "../../online-input/mapping.js";
import { setSetting } from "../../db.js";
import { computeOrigin } from "../../meosOrigin.js";
import { toRelative } from "../../timeConvert.js";
import { createTestDb, type TestDbContext } from "../helpers/test-db.js";

const ROC_BODY_TWO_PUNCHES =
  "1;31;1234567;2026-05-05 09:42:13\n" +
  "2;100;7654321;2026-05-05 09:43:00\n";

const ROC_BODY_THREE_PUNCHES =
  "3;31;1234567;2026-05-05 09:44:13\n" +
  "4;100;7654321;2026-05-05 09:45:00\n" +
  "5;55;9999999;2026-05-05 09:46:30\n";

let ctx: TestDbContext;
const ORPHAN_NAME = "oxygen_test_oi_orphan";

async function clearKeys(): Promise<void> {
  const names = [ctx?.dbName, ORPHAN_NAME].filter(Boolean) as string[];
  for (const n of names) {
    await setSetting(configKey(n), null);
    await setSetting(lastIdKey(n), null);
    await setSetting(mappingKey(n), null);
  }
}

function mockFetch(body: string) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    return new Response(body, { status: 200, statusText: "OK" });
  });
}

beforeAll(async () => {
  ctx = await createTestDb("online_input_pull");
  await ctx.client.oEvent.updateMany({
    where: { Removed: false },
    data: { Date: "2026-05-05", ZeroTime: 324000 },
  });
  await clearKeys();
}, 60000);

afterAll(async () => {
  onlineInputPuller.stopAll();
  await clearKeys();
  await ctx.cleanup();
}, 30000);

beforeEach(async () => {
  // Each test starts from a clean slate of online-input state, but reuses
  // the same competition DB. Punches we insert get cleaned up explicitly
  // in tests that need it.
  await persistConfig(ctx.dbName, {
    enabled: true,
    protocol: "roc",
    endpointUrl: "http://roc.olresultat.se/getpunches.asp",
    unitId: "TEST-UNIT",
    intervalSeconds: 10,
  });
  await setLastId(ctx.dbName, 0);
  await setSetting(mappingKey(ctx.dbName), null);
  await ctx.client.oPunch.deleteMany({});
});

describe("pollOnce → oPunch", () => {
  it("inserts new punches with MeOS-compatible Origin and advances lastId", async () => {
    const fetchSpy = mockFetch(ROC_BODY_TWO_PUNCHES);
    try {
      const stats = await pollOnce(ctx.dbName);

      expect(stats.fetched).toBe(2);
      expect(stats.inserted).toBe(2);
      expect(stats.skipped).toBe(0);
      expect(stats.newLastId).toBe(2);

      const punches = await ctx.client.oPunch.findMany({
        orderBy: { Id: "asc" },
        where: { Removed: false },
      });
      expect(punches).toHaveLength(2);

      // Punch #1: cardNo=1234567, code=31, time=09:42:13
      const p1 = punches.find((p) => p.CardNo === 1234567);
      expect(p1).toBeDefined();
      expect(p1!.Type).toBe(31);
      const abs1 = (9 * 3600 + 42 * 60 + 13) * 10;
      expect(p1!.Time).toBe(toRelative(abs1, 324000));
      expect(p1!.Origin).toBe(computeOrigin(abs1, 31));
      // The Origin must be > 0 so MeOS treats it as "original".
      expect(p1!.Origin).toBeGreaterThan(0);

      // Punch #2
      const p2 = punches.find((p) => p.CardNo === 7654321);
      expect(p2).toBeDefined();
      expect(p2!.Type).toBe(100);
      const abs2 = (9 * 3600 + 43 * 60 + 0) * 10;
      expect(p2!.Origin).toBe(computeOrigin(abs2, 100));

      expect(await getLastId(ctx.dbName)).toBe(2);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Verify the URL the protocol built — sanity-check on the
      // wire format actually being correct.
      const calledUrl = fetchSpy.mock.calls[0][0];
      const url = new URL(calledUrl as string);
      expect(url.searchParams.get("unitId")).toBe("TEST-UNIT");
      expect(url.searchParams.get("lastId")).toBe("0");
      expect(url.searchParams.get("date")).toBe("2026-05-05");
      expect(url.searchParams.get("time")).toBe("09:00:00");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("a second identical poll inserts zero new rows (idempotent on lastId)", async () => {
    const fetchSpy = mockFetch(ROC_BODY_TWO_PUNCHES);
    try {
      const first = await pollOnce(ctx.dbName);
      expect(first.inserted).toBe(2);

      // Second poll, same body. Server is supposed to honour lastId; we
      // simulate that by returning the same body anyway and asserting the
      // puller correctly skips already-imported rows.
      const second = await pollOnce(ctx.dbName);
      expect(second.fetched).toBe(2);
      expect(second.inserted).toBe(0);
      expect(second.skipped).toBe(2);
      expect(second.newLastId).toBe(2);

      const total = await ctx.client.oPunch.count({ where: { Removed: false } });
      expect(total).toBe(2);

      // Second call should request lastId=2 (advanced after first poll).
      const url2 = new URL(fetchSpy.mock.calls[1][0] as string);
      expect(url2.searchParams.get("lastId")).toBe("2");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("a follow-up poll with newer rows imports just the new ones", async () => {
    // First poll: 2 punches
    const first = mockFetch(ROC_BODY_TWO_PUNCHES);
    try {
      await pollOnce(ctx.dbName);
    } finally {
      first.mockRestore();
    }

    // Second poll: 3 newer punches (id 3,4,5)
    const second = mockFetch(ROC_BODY_THREE_PUNCHES);
    try {
      const stats = await pollOnce(ctx.dbName);
      expect(stats.fetched).toBe(3);
      expect(stats.inserted).toBe(3);
      expect(stats.newLastId).toBe(5);
    } finally {
      second.mockRestore();
    }

    const total = await ctx.client.oPunch.count({ where: { Removed: false } });
    expect(total).toBe(5);
    expect(await getLastId(ctx.dbName)).toBe(5);
  });

  it("applies a control mapping (raw 100 → PunchFinish)", async () => {
    await addMapping(ctx.dbName, 100, 2);

    const fetchSpy = mockFetch(ROC_BODY_TWO_PUNCHES);
    try {
      await pollOnce(ctx.dbName);
    } finally {
      fetchSpy.mockRestore();
    }

    const punches = await ctx.client.oPunch.findMany({
      where: { Removed: false },
      orderBy: { Id: "asc" },
    });
    const finishPunch = punches.find((p) => p.CardNo === 7654321);
    expect(finishPunch).toBeDefined();
    expect(finishPunch!.Type).toBe(2); // PunchFinish, not raw 100
    // Origin reflects the special-punch code (2), not the raw code (100),
    // which keeps `isOriginal()` true after the mapping is applied.
    const abs = (9 * 3600 + 43 * 60 + 0) * 10;
    expect(finishPunch!.Origin).toBe(computeOrigin(abs, 2));

    // Other punch (raw 31, unmapped) is unchanged
    const startPunch = punches.find((p) => p.CardNo === 1234567);
    expect(startPunch!.Type).toBe(31);

    await removeMapping(ctx.dbName, 100);
  });

  it("does not insert anything for malformed rows; well-formed rows still go through", async () => {
    const body =
      "1;31;1234567;2026-05-05 09:42:13\n" +
      "garbage\n" +
      "2;100;7654321;invalid-timestamp\n";
    const fetchSpy = mockFetch(body);
    try {
      const stats = await pollOnce(ctx.dbName);
      expect(stats.inserted).toBe(1);
      expect(await getLastId(ctx.dbName)).toBe(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("throws when disabled", async () => {
    const cfg = await loadConfig(ctx.dbName);
    await persistConfig(ctx.dbName, { ...cfg, enabled: false });
    await expect(pollOnce(ctx.dbName)).rejects.toThrow(/disabled/i);
  });

  it("throws on HTTP error responses", async () => {
    const errFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response("Server error", { status: 500, statusText: "Internal Server Error" });
    });
    try {
      await expect(pollOnce(ctx.dbName)).rejects.toThrow(/HTTP 500/);
    } finally {
      errFetch.mockRestore();
    }
  });
});

describe("reconcileEnabledPullers", () => {
  beforeEach(() => {
    onlineInputPuller.stopAll();
  });

  it("starts a puller for an enabled competition that exists in oEvent", async () => {
    await persistConfig(ctx.dbName, {
      enabled: true,
      protocol: "roc",
      endpointUrl: "http://roc.olresultat.se/getpunches.asp",
      unitId: "TEST-UNIT",
      intervalSeconds: 10,
    });

    const startSpy = vi.spyOn(onlineInputPuller, "start").mockImplementation(() => {});
    try {
      const res = await reconcileEnabledPullers();
      expect(res.started).toContain(ctx.dbName);
      expect(startSpy).toHaveBeenCalledWith(ctx.dbName, 10);
    } finally {
      startSpy.mockRestore();
    }
  });

  it("does not start a puller for orphan settings (deleted competition)", async () => {
    await setSetting(
      configKey(ORPHAN_NAME),
      JSON.stringify({
        enabled: true,
        protocol: "roc",
        endpointUrl: "http://roc.olresultat.se/getpunches.asp",
        unitId: "ORPHAN",
        intervalSeconds: 10,
      }),
    );

    const startSpy = vi.spyOn(onlineInputPuller, "start").mockImplementation(() => {});
    try {
      const res = await reconcileEnabledPullers();
      expect(res.started).not.toContain(ORPHAN_NAME);
      const failure = res.failed.find((f) => f.nameId === ORPHAN_NAME);
      expect(failure?.error).toMatch(/orphan/i);
    } finally {
      startSpy.mockRestore();
    }

    await setSetting(configKey(ORPHAN_NAME), null);
  });

  it("skips disabled competitions", async () => {
    await persistConfig(ctx.dbName, {
      enabled: false,
      protocol: "roc",
      endpointUrl: "http://roc.olresultat.se/getpunches.asp",
      unitId: "TEST-UNIT",
      intervalSeconds: 10,
    });

    const startSpy = vi.spyOn(onlineInputPuller, "start").mockImplementation(() => {});
    try {
      const res = await reconcileEnabledPullers();
      expect(res.skipped).toContain(ctx.dbName);
      expect(res.started).not.toContain(ctx.dbName);
    } finally {
      startSpy.mockRestore();
    }
  });

  it("reports failure when enabled but no unitId is configured", async () => {
    await persistConfig(ctx.dbName, {
      enabled: true,
      protocol: "roc",
      endpointUrl: "http://roc.olresultat.se/getpunches.asp",
      unitId: "",
      intervalSeconds: 10,
    });

    const startSpy = vi.spyOn(onlineInputPuller, "start").mockImplementation(() => {});
    try {
      const res = await reconcileEnabledPullers();
      const failure = res.failed.find((f) => f.nameId === ctx.dbName);
      expect(failure?.error).toMatch(/unitId/i);
    } finally {
      startSpy.mockRestore();
    }
  });
});
