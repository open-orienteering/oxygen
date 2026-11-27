/** The lease rule's log line (docs/course-elevation.md §0.44): once an hour per job, event and reason. */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const verdict = vi.hoisted(() => ({ value: { ok: false, reason: "held-elsewhere", holder: "venue" } as { ok: boolean; reason?: string; holder?: string } }));
vi.mock("../sync/lease.js", () => ({ mayWriteEventData: async () => verdict.value }));

import { LEASE_SKIP_LOG_MS, mayRunBackgroundJob } from "../background-lease.js";

describe("mayRunBackgroundJob", () => {
  let info: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { vi.useFakeTimers(); info = vi.spyOn(console, "info").mockImplementation(() => undefined); });
  afterEach(() => { vi.useRealTimers(); info.mockRestore(); });

  it("says a refusal once, again after an hour, and each job, event and reason on its own", async () => {
    const db = {} as never;
    expect(await mayRunBackgroundJob(db, 1n, "job-a")).toBe(false);
    expect(await mayRunBackgroundJob(db, 1n, "job-a")).toBe(false);
    expect(info).toHaveBeenCalledTimes(1);
    await mayRunBackgroundJob(db, 2n, "job-a");
    await mayRunBackgroundJob(db, 1n, "job-b");
    expect(info).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(LEASE_SKIP_LOG_MS + 1);
    await mayRunBackgroundJob(db, 1n, "job-a");
    expect(info).toHaveBeenCalledTimes(4);
  });

  it("runs, silently, where the node may write", async () => {
    verdict.value = { ok: true };
    expect(await mayRunBackgroundJob({} as never, 9n, "job-c")).toBe(true);
    expect(info).not.toHaveBeenCalled();
    verdict.value = { ok: false, reason: "held-elsewhere", holder: "venue" };
  });
});
