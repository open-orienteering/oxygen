/**
 * `eventor.syncRunnerDb` runs one at a time (API-16, package 20): it is a
 * ~9 MB download and a bulk upsert behind `event.manage`, so a second call
 * while one runs is refused with CONFLICT, and the slot is free again once
 * the first call has finished, successfully or not. The Eventor fetch is
 * mocked and held open by the test.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const held = vi.hoisted(() => {
  const state: { release: (() => void) | null; fail: boolean } = { release: null, fail: false };
  return state;
});

vi.mock("../../eventor.js", async () => {
  const actual = await vi.importActual<typeof import("../../eventor.js")>("../../eventor.js");
  return {
    ...actual,
    fetchCachedCompetitors: vi.fn(
      () =>
        new Promise((resolve, reject) => {
          held.release = () => (held.fail ? reject(new Error("eventor down")) : resolve([]));
        }),
    ),
    fetchClubs: vi.fn(async () => []),
    fetchClubLogo: vi.fn(async () => null),
  };
});

import { setSetting } from "../../db.js";
import { eventorKeyStore } from "../../eventorKeyStore.js";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";

let ctx: TestEventContext;

beforeAll(async () => {
  ctx = await createTestEvent("rdb-single-flight");
  await setSetting("eventor_api_key_test", "test-key");
  eventorKeyStore._resetForTests();
});

afterAll(async () => {
  await setSetting("eventor_api_key_test", null);
  eventorKeyStore._resetForTests();
  await ctx.cleanup();
  await disconnect();
});

describe("syncRunnerDb single flight", () => {
  it("refuses a second call while one runs, and frees the slot when it ends", async () => {
    const caller = makeCaller(ctx.event);
    const first = caller.eventor.syncRunnerDb({ env: "test" });
    await vi.waitFor(() => expect(held.release).not.toBeNull());

    await expect(caller.eventor.syncRunnerDb({ env: "test" })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Runner database sync already running",
    });

    held.release!();
    await expect(first).resolves.toMatchObject({ runners: 0 });

    // The failed run must free the slot too.
    held.release = null;
    held.fail = true;
    const second = caller.eventor.syncRunnerDb({ env: "test" });
    const secondResult = expect(second).rejects.toThrow("eventor down");
    await vi.waitFor(() => expect(held.release).not.toBeNull());
    held.release!();
    await secondResult;

    held.release = null;
    held.fail = false;
    const third = caller.eventor.syncRunnerDb({ env: "test" });
    await vi.waitFor(() => expect(held.release).not.toBeNull());
    held.release!();
    await expect(third).resolves.toMatchObject({ runners: 0 });
  });
});
