/**
 * Integration test for reconcileEnabledPushers().
 *
 * Seeds the oxygen_settings table directly, then verifies the reconciler
 * picks up the right rows. The pusher's start() is stubbed so the test
 * never tries to talk to the real LiveResults MySQL server.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import {
  liveResultsPusher,
  reconcileEnabledPushers,
} from "../../liveresults.js";
import { setSetting, getMainDbConnection } from "../../db.js";
import { createTestDb, type TestDbContext } from "../helpers/test-db.js";

const NAME_DISABLED = "oxygen_test_lr_recon_disabled";
const NAME_NO_TAVID = "oxygen_test_lr_recon_no_tavid";
const NAME_BAD_JSON = "oxygen_test_lr_recon_bad_json";
const NAME_ORPHAN = "oxygen_test_lr_recon_orphan";

let activeCtx: TestDbContext;

async function clearKeys(): Promise<void> {
  const names = [
    activeCtx?.dbName,
    NAME_DISABLED,
    NAME_NO_TAVID,
    NAME_BAD_JSON,
    NAME_ORPHAN,
  ].filter(Boolean) as string[];
  for (const n of names) {
    await setSetting(`liveresults_config_${n}`, null);
    await setSetting(`liveresults_tavid_${n}`, null);
  }
}

describe("reconcileEnabledPushers", () => {
  beforeAll(async () => {
    activeCtx = await createTestDb("lr_recon");
    await clearKeys();
  });

  afterAll(async () => {
    liveResultsPusher.stopAll();
    await clearKeys();
    if (activeCtx) await activeCtx.cleanup();
  });

  beforeEach(() => {
    liveResultsPusher.stopAll();
  });

  it("starts a pusher for an enabled competition with a stored tavid", async () => {
    const nameId = activeCtx.dbName;
    await setSetting(
      `liveresults_config_${nameId}`,
      JSON.stringify({ enabled: true, intervalSeconds: 30, isPublic: false, country: "SE" }),
    );
    await setSetting(`liveresults_tavid_${nameId}`, "12345");

    const startSpy = vi.spyOn(liveResultsPusher, "start").mockImplementation(() => {});
    try {
      const res = await reconcileEnabledPushers();
      expect(res.started).toContain(nameId);
      expect(startSpy).toHaveBeenCalledWith(nameId, 12345, 30);
    } finally {
      startSpy.mockRestore();
    }

    await setSetting(`liveresults_config_${nameId}`, null);
    await setSetting(`liveresults_tavid_${nameId}`, null);
  });

  it("does not start a pusher for orphan settings (deleted competition)", async () => {
    // Settings exist but no oEvent row — exactly the Vinterserien situation
    // that triggered this defensive check.
    await setSetting(
      `liveresults_config_${NAME_ORPHAN}`,
      JSON.stringify({ enabled: true, intervalSeconds: 30, isPublic: false, country: "SE" }),
    );
    await setSetting(`liveresults_tavid_${NAME_ORPHAN}`, "99999");

    const startSpy = vi.spyOn(liveResultsPusher, "start").mockImplementation(() => {});
    try {
      const res = await reconcileEnabledPushers();
      expect(res.started).not.toContain(NAME_ORPHAN);
      const failure = res.failed.find((f) => f.nameId === NAME_ORPHAN);
      expect(failure?.error).toMatch(/orphan/i);
      expect(startSpy).not.toHaveBeenCalledWith(NAME_ORPHAN, expect.any(Number), expect.any(Number));
    } finally {
      startSpy.mockRestore();
    }

    await setSetting(`liveresults_config_${NAME_ORPHAN}`, null);
    await setSetting(`liveresults_tavid_${NAME_ORPHAN}`, null);
  });

  it("does not start a pusher for soft-deleted competitions (Removed=1)", async () => {
    // Same effect as orphan, but the row is still in oEvent with Removed=1.
    const nameId = activeCtx.dbName;
    await setSetting(
      `liveresults_config_${nameId}`,
      JSON.stringify({ enabled: true, intervalSeconds: 30, isPublic: false, country: "SE" }),
    );
    await setSetting(`liveresults_tavid_${nameId}`, "12345");

    const conn = await getMainDbConnection();
    try {
      await conn.execute("UPDATE oEvent SET Removed = 1 WHERE NameId = ?", [nameId]);
    } finally {
      await conn.end();
    }

    const startSpy = vi.spyOn(liveResultsPusher, "start").mockImplementation(() => {});
    try {
      const res = await reconcileEnabledPushers();
      expect(res.started).not.toContain(nameId);
      const failure = res.failed.find((f) => f.nameId === nameId);
      expect(failure?.error).toMatch(/orphan/i);
    } finally {
      startSpy.mockRestore();
    }

    // Restore so other tests still see the active competition
    const conn2 = await getMainDbConnection();
    try {
      await conn2.execute("UPDATE oEvent SET Removed = 0 WHERE NameId = ?", [nameId]);
    } finally {
      await conn2.end();
    }

    await setSetting(`liveresults_config_${nameId}`, null);
    await setSetting(`liveresults_tavid_${nameId}`, null);
  });

  it("skips disabled competitions", async () => {
    await setSetting(
      `liveresults_config_${NAME_DISABLED}`,
      JSON.stringify({ enabled: false, intervalSeconds: 30, isPublic: false, country: "SE" }),
    );
    await setSetting(`liveresults_tavid_${NAME_DISABLED}`, "9999");

    const startSpy = vi.spyOn(liveResultsPusher, "start").mockImplementation(() => {});
    try {
      const res = await reconcileEnabledPushers();
      expect(res.skipped).toContain(NAME_DISABLED);
      expect(res.started).not.toContain(NAME_DISABLED);
      expect(startSpy).not.toHaveBeenCalledWith(NAME_DISABLED, expect.any(Number), expect.any(Number));
    } finally {
      startSpy.mockRestore();
    }

    await setSetting(`liveresults_config_${NAME_DISABLED}`, null);
    await setSetting(`liveresults_tavid_${NAME_DISABLED}`, null);
  });

  it("reports failure when enabled but no tavid is stored", async () => {
    // Use the active competition's nameId so we exercise the tavid check
    // rather than tripping the orphan-settings guard first.
    const nameId = activeCtx.dbName;
    await setSetting(
      `liveresults_config_${nameId}`,
      JSON.stringify({ enabled: true, intervalSeconds: 30, isPublic: false, country: "SE" }),
    );

    const startSpy = vi.spyOn(liveResultsPusher, "start").mockImplementation(() => {});
    try {
      const res = await reconcileEnabledPushers();
      const failure = res.failed.find((f) => f.nameId === nameId);
      expect(failure).toBeDefined();
      expect(failure?.error).toMatch(/tavid/i);
    } finally {
      startSpy.mockRestore();
    }

    await setSetting(`liveresults_config_${nameId}`, null);
  });

  it("reports failure on malformed config JSON without crashing", async () => {
    await setSetting(`liveresults_config_${NAME_BAD_JSON}`, "{not-json");
    await setSetting(`liveresults_tavid_${NAME_BAD_JSON}`, "1");

    const startSpy = vi.spyOn(liveResultsPusher, "start").mockImplementation(() => {});
    try {
      const res = await reconcileEnabledPushers();
      const failure = res.failed.find((f) => f.nameId === NAME_BAD_JSON);
      expect(failure).toBeDefined();
    } finally {
      startSpy.mockRestore();
    }

    await setSetting(`liveresults_config_${NAME_BAD_JSON}`, null);
    await setSetting(`liveresults_tavid_${NAME_BAD_JSON}`, null);
  });
});
