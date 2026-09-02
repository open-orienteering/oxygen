/**
 * The webhook URL cache must be keyed by event. A single process-wide
 * URL meant two events hitting the same instance within the TTL would
 * send readouts to whichever event had primed the cache.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  clearSheetsCache,
  getWebhookUrl,
} from "../sheetsBackup.js";

function fakeClient(
  urls: Record<string, string | null>,
): {
  event: { findUnique: (args: { where: { id: bigint } }) => Promise<{ googleSheetsWebhookUrl: string | null } | null> };
  calls: bigint[];
} {
  const calls: bigint[] = [];
  return {
    calls,
    event: {
      async findUnique({ where }) {
        calls.push(where.id);
        const url = urls[String(where.id)];
        if (url === undefined) return null;
        return { googleSheetsWebhookUrl: url };
      },
    },
  };
}

afterEach(() => {
  clearSheetsCache();
});

describe("getWebhookUrl", () => {
  it("returns a distinct URL for each event", async () => {
    const db = fakeClient({
      "1": "https://hooks.example/a",
      "2": "https://hooks.example/b",
    });
    const a = await getWebhookUrl(db as never, 1n);
    const b = await getWebhookUrl(db as never, 2n);
    expect(a).toBe("https://hooks.example/a");
    expect(b).toBe("https://hooks.example/b");
    expect(db.calls).toEqual([1n, 2n]);
  });

  it("does not serve one event's URL from another's cache entry", async () => {
    const db = fakeClient({
      "10": "https://hooks.example/first",
      "11": "https://hooks.example/second",
    });
    await getWebhookUrl(db as never, 10n);
    const second = await getWebhookUrl(db as never, 11n);
    expect(second).toBe("https://hooks.example/second");
  });

  it("reuses a cached URL for the same event", async () => {
    const db = fakeClient({ "3": "https://hooks.example/cached" });
    await getWebhookUrl(db as never, 3n);
    await getWebhookUrl(db as never, 3n);
    expect(db.calls).toHaveLength(1);
  });

  it("treats a missing webhook as empty rather than leaking another event's URL", async () => {
    const db = fakeClient({
      "4": "https://hooks.example/only-this-one",
    });
    await getWebhookUrl(db as never, 4n);
    const missing = await getWebhookUrl(db as never, 99n);
    expect(missing).toBe("");
  });
});
