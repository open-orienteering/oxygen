import { describe, it, expect, beforeEach } from "vitest";

// The lib test environment is node: a minimal localStorage.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};
import { EventClock, offsetFromRoundTrip } from "../event-clock";

const H = 36_000;

describe("offsetFromRoundTrip", () => {
  it("takes the server's time at the request midpoint", () => {
    expect(offsetFromRoundTrip(1_000, 1_200, 6_100)).toBe(5_000);
  });
});

describe("EventClock (RES-06)", () => {
  let device: number;
  beforeEach(() => {
    localStorage.clear();
    // 2026-07-01 08:00:00 UTC on the device.
    device = Date.UTC(2026, 6, 1, 8, 0, 0);
  });

  it("ticks from the device clock before the first answer, in the default zone", () => {
    const c = new EventClock("ev", () => device);
    expect(c.synced).toBe(false);
    // Stockholm in summer: 10:00.
    expect(c.nowDs()).toBe(10 * H);
    device += 60_000;
    expect(c.nowDs()).toBe(10 * H + 600);
  });

  it("applies the server offset and zone, and keeps ticking offline", async () => {
    const c = new EventClock("ev", () => device);
    // The server is 90 s ahead and the event is in Helsinki (+3 in summer).
    await c.sync(async () => ({ now: device + 90_000, timeZone: "Europe/Helsinki" }));
    expect(c.synced).toBe(true);
    expect(c.nowDs()).toBe(11 * H + 900);
    // Network gone: the next sync fails, the clock keeps running.
    await c.sync(async () => {
      throw new Error("offline");
    });
    device += 10_000;
    expect(c.nowDs()).toBe(11 * H + 1000);
  });

  it("remembers the zone for the next start of the station", async () => {
    const a = new EventClock("ev2", () => device);
    await a.sync(async () => ({ now: device, timeZone: "Asia/Tokyo" }));
    const b = new EventClock("ev2", () => device);
    expect(b.timeZone).toBe("Asia/Tokyo");
    expect(b.nowDs()).toBe(17 * H);
  });
});
