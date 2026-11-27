/**
 * EVT-13: one Eventor upload per event and kind at a time. A second
 * `pushResults` while the first waits on Eventor is refused with
 * EVENTOR_PUSH_IN_PROGRESS (was: it posted the same XML twice); a dry run is
 * never blocked. See docs/system/eventor-sync.md "Upload timeouts and the push guard".
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

vi.mock("../../eventor.js", async () => {
  const actual = await vi.importActual<typeof import("../../eventor.js")>("../../eventor.js");
  return { ...actual, uploadResults: vi.fn(), uploadStartList: vi.fn() };
});

import { uploadResults, uploadStartList } from "../../eventor.js";
import { setSetting } from "../../db.js";
import { createTestEvent, disconnect } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { eventorKeyStore } from "../../eventorKeyStore.js";

beforeAll(async () => {
  await setSetting("eventor_api_key_test", "test-key");
  eventorKeyStore._resetForTests();
}, 30_000);

afterAll(async () => {
  await setSetting("eventor_api_key_test", null);
  eventorKeyStore._resetForTests();
  await disconnect();
}, 30_000);

describe("pushResults / pushStartList guard", () => {
  it("refuses a concurrent second push, never blocks a dry run, releases afterwards", async () => {
    const ctx = await createTestEvent("push-guard");
    try {
      await ctx.db.event.update({
        where: { id: ctx.eventId },
        data: { eventorEventId: 99_301n, eventorEnv: "test" },
      });
      const caller = makeCaller(ctx.event);

      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      vi.mocked(uploadResults).mockImplementationOnce(() => gate);
      vi.mocked(uploadStartList).mockResolvedValue(undefined);

      const first = caller.eventor.pushResults();
      await vi.waitFor(() => expect(uploadResults).toHaveBeenCalledTimes(1));

      await expect(caller.eventor.pushResults()).rejects.toMatchObject({
        code: "CONFLICT",
        message: expect.stringContaining("EVENTOR_PUSH_IN_PROGRESS"),
      });
      expect(uploadResults).toHaveBeenCalledTimes(1);

      // Dry run and the other upload kind are not blocked.
      await expect(caller.eventor.pushResults({ dryRun: true })).resolves.toEqual({ runnerCount: 0 });
      await expect(caller.eventor.pushStartList()).resolves.toEqual({ runnerCount: 0 });

      release();
      await expect(first).resolves.toEqual({ runnerCount: 0 });

      vi.mocked(uploadResults).mockResolvedValueOnce(undefined);
      await expect(caller.eventor.pushResults()).resolves.toEqual({ runnerCount: 0 });
    } finally {
      await ctx.cleanup();
    }
  }, 30_000);
});
